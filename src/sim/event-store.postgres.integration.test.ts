import { describe, it } from "vitest";

describe.skip("PostgresSimulationEventStore integration", () => {
  it("requires a live PostgreSQL server configured by CI or the host", () => {
    // Intentionally skipped in the Forge sandbox: no networked PostgreSQL is
    // available here, and this suite must never claim adapter verification.
  });
});
