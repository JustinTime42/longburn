# Handoff: Forge 2026-08-07 longburn-1ls round 2

## Plan executed

1. Read the governing fort records, approved worldline and flight-plan specifications, prior 1ls handoff, current durable schemas, and production call sites.
2. Verify the existing committed tranche and identify every fact required to make `arrivalRecorded` durable and replay-safe.
3. Stop before implementation because the target-body fact required by the approved schema is absent from every authoritative interface.

## Clarifying questions

1. Where must the authoritative target-body identity live before `arrivalRecorded` is appended? `FlightPlan`, `BurnNode`, `commandIssued`, and `SimState` carry no Earth/Moon/Mars target, yet authoritative-worldline-v0.1 §2 requires `arrivalRecorded` to stamp the terminal state plus that target body's ephemerides state. Please specify the durable owner (for example, a flight-plan-level destination field, or a separately stamped stream fact) and its live-boundary validation rule. Inferring a target from a planned burn would fabricate replay history and violates the stored-facts doctrine.

Model: gpt-5.6-terra
