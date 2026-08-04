# Warden Review 2: longburn-6yu

Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern
Model: Claude Opus 5 (frontier rung; r1 ran on the GPT-5.6 Sol failover)
Date: 2026-08-04
Commit: `b27bbe6` by Orin Slowfire (Forge, GPT-5.6 Terra)
Branch: `bead/6yu`, worktree `/home/justin/dev/longburn-worktrees/6yu`
Governing texts: charter SO 10-13, GDD §4.5/§6, and `docs/specs/causality-invariant-design.md` as amended at `8b6af93` per the Overseer ruling of 2026-08-04.

## VERDICT: request_changes

The r1 escalation is answered. The tolerance constant is gone, and the invariant now holds where I could measure it: at the exact one-light-second boundary, under receding and approaching receivers, against malformed provenance, and against exact rational arithmetic over four thousand randomized moving-receiver cases with zero early scheduling ticks. There is no remaining invariant-math failure, so this does not escalate a second time.

It does not yet approve. Three things are still open, and two of them sit in the one dimension the Overseer's amendment added. The light-cone solve returns its last iterate with no conservative margin, so its residual error points in the unsafe direction; I measured that residual at 3.57e-7 ms, which is harmless against a 1 ms grid but is the exact uncertainty the amended note says must resolve toward *later*. The suite cannot see that dimension at all: loosening `CONVERGENCE_MS` from 0.001 to 1000 leaves all six causality tests green, and so does returning the previous iterate instead of the converged one. Both mutations push emission earlier. This bead's entire product is the thing that catches a regression in the light cone, and it currently has a blind spot precisely where the amendment landed. Separately, the transport fence catches two of eight realistic bypasses while the README claims it "mechanically rejects raw outbound calls" without qualification, which is a false promise to the author of `longburn-din.5`.

## Round-1 findings, re-verified

**1. (was critical) Tolerance removed and the light-cone solve is correct — CLOSED.**
`CAUSALITY_RELATIVE_TOLERANCE` is gone; `grep -rniE "toleran|epsilon|EPS|0\.999|fudge|slack"` over `src/` and `eslint.config.mjs` returns nothing. Boundary probe at exactly one light-second with a static receiver: emission at 999 ms returns `{sent:false}`, transport is never called, one incident with reason `early-emission` is recorded and the counter increments once; emission at 1000 ms returns `{sent:true}` with server-computed `stalenessMs` of 1000. The solve matches the amended note: seed at the event-time distance, fixed-point iterate on receiver position at the candidate arrival, sub-millisecond step bound, hard cap of 32 iterations, and non-convergence throws so the gate blocks. The assertion compares `emissionTime < Math.ceil(arrivalTimeMs)`, which rounds the requirement *up*; a probe at a deliberately fractional arrival (1500.0412 ms) confirmed emission at 1500 blocks and 1501 passes.

Moving receivers behave as the note requires. A receiver receding at 100 km/s from one light-second out yields an arrival of 1000.3337 ms against a naive event-time distance of 1000 ms, agreeing with the closed-form quadratic root to under 0.01 ms, and the gate blocks at `tick-1` and admits at `tick`. An approaching receiver at the same speed yields 999.6664 ms and the gate still refuses to release at `ceil-1`.

The strongest check I ran: 4000 randomized linear worldlines (distances 1e6 to 4e11 m, speeds to ~170 km/s, arbitrary directions), with each solver output compared against the exact arrival solved as a rational quadratic at 60-digit precision. Zero cases produced a scheduling tick earlier than the exact tick. Maximum under-estimate of the arrival time: 3.57e-7 ms.

*Open, minor:* that under-estimate is real and one-directional. The note says "every uncertainty — iteration remainder, floating point, provenance the gate cannot verify, non-convergence — resolves toward *later* emission," and the remainder currently does not. It is a one-line fix (return `nextArrivalTimeMs` plus the convergence bound, or plus a few ulp of the magnitude) and it converts a probabilistic argument into a proof. I would rather hold the proof.

**2. (was blocker) Boundary tests and independent property generation — CLOSED for the stationary case, open for motion.**
The r1 survivors are dead. `Math.floor` on the returned arrival: killed, 3 of 6 tests fail. `c` to `299_792_459`: killed, the exact-boundary test fails (`expected 1000 to be 1001`). Inequality flip `<` to `>`: killed, 4 of 6 fail. I added a fourth mutation, `Math.ceil` to `Math.floor` in the assertion: killed, 3 of 6 fail. The oracle `independentEarliestTick` hardcodes the SI value of c and derives the earliest tick without touching the production helper, which is what makes the c+1 kill meaningful rather than circular.

*Open, blocker for this bead's purpose:* the independent generator and the liveness property are both stationary-only (`stationaryAt`). The only moving-receiver test is one hand-built case asserting `toBeGreaterThan(1_000)`, with no independent oracle. Consequence, measured: `CONVERGENCE_MS` 0.001 to 1000 survives all six tests, and returning `arrivalTimeMs` instead of `nextArrivalTimeMs` survives all six. Both weaken the solve in the early-emission direction. Raising the iteration cap question the other way (`MAX_LIGHT_CONE_ITERATIONS` to 1) *is* killed, but only because it trips the fail-closed path, not because anything measures accuracy. Add a moving-receiver boundary property whose expectation comes from the closed-form quadratic root — for linear motion `(|v|² − c²)t² + 2(p₀·v)t + |p₀|² = 0`, smallest non-negative root — generated independently of the solver, asserting block at `ceil−1` and pass at `ceil`. That property kills both survivors.

**3. (was blocker) Runtime provenance validation — CLOSED.**
`isSimTimeMs` requires `Number.isSafeInteger` and non-negative, applied to both times inside `requiredArrivalTimeMs` before any comparison. Twelve malformed-time probes (NaN on either time, negative, non-integer, unsafe-integer, Infinity, string, null, undefined) all returned `{sent:false}` with exactly one `invalid-provenance` incident and one counter increment, and transport was never called. Five malformed-position probes (NaN, Infinity, null, string, missing `z`) all blocked with `invalid-position`. The r1 `NaN < required` hole is closed.

**4. (was blocker) Observability on every failure mode — CLOSED.**
`emit` wraps everything, derives an incident for unexpected errors, and calls `recordIncident` and `incrementCausalityFailure` in *separate* try blocks so a reporting failure cannot become a send. Re-probed the r1 getter-throw case: `{sent:false}`, no transport, one incident, one counter. Throwing worldline evaluator: same. Both reporters throwing simultaneously on a genuine 999 ms violation: still `{sent:false}`, transport untouched.

*Open, minor:* if `send` itself throws, the gate catches it, records a *causality* incident with reason `invalid-position`, increments the causality alert, and returns `{sent:false}` — while the message may already have gone out. A probe confirmed the transport ran and `{sent:false}` came back. That mislabels transport faults as causality breaches on the one channel an operator watches for leaks, and it lies about delivery. Move the `#send` call outside the causality catch, or give it its own reason. Related and worth deciding now rather than in `din.5`: `EmissionResult` carries no reason on the false branch, so a caller cannot distinguish "too early, retry at the legal tick" from "malformed, drop it." Also note `incident.provenance` holds the whole event including `payload`, so incident-grade logs will contain message contents.

**5. (was blocker) Mechanical transport fence — PARTIALLY CLOSED.**
The mechanics are sound. The `causal-boundary/no-raw-outbound` rule fires on `test/fixtures/sim/raw-outbound.ts` (one error, correct message); the fixture is globally ignored by the production `eslint src` pass and reached by the fence test via `ignore: false`; `tsc --listFiles` confirms both fixtures are type-checked, so the `longburn-66g` lesson holds. The fence has its own deliberate-violation regression test, which is the right shape.

*Open:* the rule is a name tripwire, not a boundary. I planted a realistic future transport module in `src/net/transport.ts` in my scratch copy with eight bypasses. It caught two: `sock.send(...)` and `sock.write(...)`. It missed `sock.emit(...)` (the likeliest spelling for a socket or event transport, and unbannable since it is the gate's own method name), `sock.push(...)`, `sock.dispatch(...)`, a bound alias `const raw = sock.send.bind(sock); raw(s)`, a destructured `const { send: fire } = sock`, and a computed member `sock["se"+"nd"](s)`. It also exempts all of `src/sim/causality.ts` by filename rather than scoping to the gate class, and it will false-positive on any future `.write(` in `src/` (a stream, a file, a database), which is the pressure that gets fences disabled.

I judge this real but thin: it will stop a careless raw send and will not stop a considered one, and it does not do the thing r1 asked for most, which is *define the transport boundary `din.5` builds against*. There is still no transport interface in the codebase; the gate takes a bare `send` callback in its options. Either give `din.5` a nominal boundary the rule can enforce structurally (an exported transport type the rule requires all outbound calls to go through), or keep the tripwire and stop overclaiming it. What is not acceptable is the README as written: "The `causal-boundary/no-raw-outbound` ESLint rule mechanically rejects raw outbound calls outside that gate" is false for six of the eight forms I tried, and the next author will trust it. Documentation must match the code (global spec discipline). Fix the sentence or fix the rule.

**6. Standard sweep — CLOSED.**
Determinism: injecting `Date.now()`, `Math.random()`, `new Date().getTime()`, and `performance.now()` into `src/sim/causality.ts` produced 5 ESLint errors across `no-restricted-properties` and `no-restricted-syntax`. The production module reads no wall clock and contains no unseeded randomness. Units: positions in meters, `c` the exact SI integer, `×1000` converts seconds to sim milliseconds, staleness in sim ms. Tier fence (SO 13): the diff adds the gate, its tests, the lint rule, one fixture, two README sentences, and two handoffs. No player subscription topology, no relativistic correction, no market behavior, no post-T0 scope. Deliberate-violation fixtures exist for both layers: `raw-outbound.ts` for the fence, and the `ceil−1` assertions plus the fail-closed cases for the gate. Liveness now genuinely proves delayed visibility: each property message is emitted once blocked at `earliest−1` and then admitted at `earliest`, with staleness asserted equal to `emissionTime − eventTime` on every message that got through.

## Verification and mutation record

- Target worktree at `b27bbe6` was never modified. `git status --porcelain` empty before and after. All mutations ran in a `/tmp` scratch copy with `.git` removed.
- Baseline `npm run verify` in scratch: ESLint clean, `tsc --noEmit` strict clean, 13 tests across 6 files passed. Matches the Forge's claim.
- Exact boundary, static receiver at one light-second: 999 ms blocked with incident `early-emission` and counter; 1000 ms sent with `stalenessMs` 1000. **Passed.**
- Receding receiver at 100 km/s: arrival 1000.3337 ms vs closed form 1000.33377 ms, delta < 0.01 ms; blocked at `tick−1`, sent at `tick`. **Passed.**
- Approaching receiver at 100 km/s: arrival 999.6664 ms vs closed form, delta < 0.01 ms; blocked at `ceil−1`. **Passed.**
- 4000 randomized linear worldlines vs exact 60-digit rational quadratic solve: 0 early ticks, 0 solver errors, max arrival under-estimate 3.57e-7 ms. **Passed with a noted one-directional residual.**
- 2,000,000 adversarial stationary distances (each the smallest integer meter count strictly past an integer millisecond of light travel, k = 1..2e6) comparing float `ceil` against exact `Fraction` `ceil`: 0 undershoots. Float rounding does not leak at T0 scales.
- 12 malformed provenance-time probes + 5 malformed-position probes: all blocked, all observed. **Passed.**
- Getter-throw, worldline-throw, both-reporters-throw: all blocked, transport never called. **Passed.**
- Mutation `Math.floor(nextArrivalTimeMs)`: **killed** (3/6 fail). r1 survivor now dead.
- Mutation `c` = 299_792_459: **killed** (1/6 fail, the exact-boundary test). r1 survivor now dead.
- Mutation `<` to `>` in the assertion: **killed** (4/6 fail).
- Mutation `Math.ceil` to `Math.floor` in the assertion: **killed** (3/6 fail).
- Mutation `MAX_LIGHT_CONE_ITERATIONS` = 1: **killed** (1/6 fail, via the fail-closed path).
- Mutation `CONVERGENCE_MS` 0.001 to 1000: **SURVIVED** (6/6 green). Unsafe direction.
- Mutation return `arrivalTimeMs` instead of `nextArrivalTimeMs`: **SURVIVED** (6/6 green). Unsafe direction.
- Injected wall-clock and unseeded-random forms into `src/sim/causality.ts`: 5 ESLint errors. **Killed.**
- Fence bypass probe, 8 realistic forms in a scratch `src/net/transport.ts`: 2 caught (`.send`, `.write`), 6 missed (`.emit`, `.push`, `.dispatch`, bound alias, destructure, computed member).
- Fixture scoping: `eslint test/fixtures/sim/raw-outbound.ts` ignored in the production pass; `--no-ignore` produces exactly the one fence error; `tsc --listFiles` covers both fixtures.
- `send`-throws probe: transport ran, gate returned `{sent:false}` and logged a causality incident with reason `invalid-position`.

## Required disposition

1. Give the light-cone solve an explicitly conservative return so the iteration remainder and float error can only delay (r1 finding 1 residual, minor but named by the amended note).
2. Add a moving-receiver boundary property with an oracle independent of the solver, generating both sides of the tick. It must kill the `CONVERGENCE_MS` and stale-iterate mutations recorded above (r1 finding 2, the remaining blocker).
3. Reconcile the fence with its README claim: either enforce a structural transport boundary for `din.5`, or narrow the README sentence to what the rule actually does (r1 finding 5).
4. Optional but cheap while the file is open: stop reporting transport failures as causality incidents, and consider a reason on the blocked `EmissionResult` before `din.5` builds retry logic on it.

Findings 1, 3, 4, and 6 are otherwise closed. No further Overseer escalation is warranted; the ruling is honored and the invariant holds under every measurement I could construct.
