# Farlantern event stream

Append-only JSONL, one file per day (`events-YYYY-MM-DD.jsonl`), written by `fort/scripts/emit.sh`. This is the fort's replayable history: the data source for a future Dwarf-Fortress-style visualizer and for any digest/monitoring consumer. Daily files are **tracked in git since cycle 7** (the audit record is tamper-evident and rides the offsite backup; the Mayor stages them path-scoped at session close — see fort/seats/mayor.md). This README and the schema are tracked. *(Originally gitignored for worktree merge-hazard reasons; superseded 2026-08-08.)*

## Schema

```json
{"ts":"2026-08-03T17:30:00-08:00","actor":"orin","seat":"forge","category":"bead.claimed","target":"longburn-mij","detail":"Orin claims the CI bead","payload":null}
```

- **ts**: ISO-8601 with offset. **actor**: who did it (`vardis`, `orin`, `sereth`, `overseer`, `harness`, `regent`, `watcher:<name>`). **seat**: office if applicable (`mayor|forge|warden`). **category**: dotted event type (below). **target**: bead ID, commit hash, seat, or path. **detail**: one human-readable line (this becomes the DF announcement text). **payload**: optional JSON (model used, tokens, verdicts, tallies).

## Categories (extend freely; never rename existing ones)

- `fort.founded`, `fort.renamed`, `moot.convened`, `moot.declaration`, `moot.ballot`, `moot.named`, `charter.amended`
- `seat.founded`, `seat.named`, `session.start`, `session.end`, `handoff.written`
- `bead.filed`, `bead.claimed`, `bead.closed`, `bead.blocked`, `bead.unblocked`
- `verify.run`, `verify.pass`, `verify.fail`, `review.verdict`, `merge`, `push`, `deploy`
- `incident`, `incident.corrected`, `laurel`, `overseer.decision`, `watcher.alert`

## Emission points (who must emit, when)

- **Launchers** (`mayor.sh`, `forge.sh`): `session.start` on launch, `session.end` (with exit code) on exit.
- **Seats**: `handoff.written` at session close; Mayor emits `bead.filed` when filing; Warden emits `review.verdict` (payload: `{"verdict":"approve|request_changes|escalate"}`).
- **Harness**: `bead.claimed`/`bead.closed`, `verify.*`, `merge`, `push`, `incident`.
- **Watchers**: `watcher.alert` on any finding (plus filing the bead).

Rules: events are append-only and never edited (standing order 12 applies); one event per line; keep `detail` under ~140 chars so it reads as an announcement; timestamps may be backfilled only with `-T` and only for reconstructing real history.
