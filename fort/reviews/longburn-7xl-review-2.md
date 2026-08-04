# Warden Review 2: longburn-7xl

Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern  
Model: GPT-5.6 Sol failover (Opus rung hit its session limit)  
Date: 2026-08-04  
Commit reviewed: `5320e6ba64131c6c02af4e3a0e00ade507d9e79a`

## Scope and commit checks

Compared `5b3a69e..5320e6b` and read the complete final `docs/decisions/ephemerides.md`. The commit changes only that decision document: 8 insertions and 5 deletions. There is no handoff-record change. The worktree is clean. The commit subject is exactly `longburn-7xl: apply Warden round-1 findings`, which has the required `longburn-7xl: ...` form.

Per the round-2 instruction, I did not repeat the empirical accuracy measurements. I judged the revised text against the facts established in round 1.

## Per-finding disposition

1. **Timescale UT/TT/TDB contract: fully addressed.** The adapter input is now unambiguously UT days since J2000. The text states that the numeric input goes through `MakeTime`, which performs Astronomy Engine's UT-to-TT conversion. The Horizons fixture recipe now pins `TIME_TYPE=TDB` and requires each fixture to preserve the exact TDB epoch, corresponding adapter UT input, and the conversion convention proving they represent the same physical instant. The contract is coherent from caller input through library calculation to reference fixture.

2. **Sun zero-vector contract: fully addressed.** The document now says plainly that `HelioState(Body.Sun, time)` is zero by definition in the chosen heliocentric frame. It correctly assigns solar barycentric displacement to `BaryState`, fences it out of Tier 0, and warns callers not to infer barycentric motion from the Sun value.

3. **Delta-T pinning, call-history determinism, and HelioState/EQJ fence: fully addressed.** Adapter initialization must pin and assert the delta-T function instead of inheriting mutable process-global state. Tests must cover cold and warmed execution, varied call order/history, and interleaved queries. The adapter is limited to `HelioState` in EQJ, with of-date rotations explicitly off-limits. The requirement was strengthened, not weakened.

4. **Measured deltas replacing the arcminute figure: partially addressed.** The misleading arcminute claim is gone, and the measured deltas are recorded correctly as 750 km for Earth, 760 km for Moon, 1,982 km for Mars, and about 1.3 m/s velocity. However, the next sentence says, "Those position deltas are 0.1–0.3% of the relevant patched-conic sphere-of-influence radii." That is not true for all three listed bodies. Round 1 established that the Moon's 760 km delta is about 1.2% of its roughly 66,000 km SOI; 0.1–0.3% described Earth and Mars. This is a new factual contradiction in the decision record. Fix the sentence by separating Earth/Mars from Moon or by giving all three percentages accurately. Do not remove or loosen the measured-error evidence or validation gate.

5. **Pluto fence: fully addressed.** Pluto is explicitly outside Tier 0 and this contract. Any future Pluto work must evaluate its different determinism profile rather than extending the current decision by assumption.

## Verdict: request changes

Findings 1, 2, 3, and 5 are fully addressed. Finding 4 is partial because its new SOI-percentage summary contradicts the round-1 measurements. The underlying provider decision remains sound, the timescale chain is now coherent end to end, and no requirement was weakened. Correct the single percentage sentence and return the same doc-only scope for review.

Surprise: the only remaining defect is introduced by the remediation itself. The absolute deltas are correct, but their shared percentage range accidentally excludes the Moon.
