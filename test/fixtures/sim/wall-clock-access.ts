const timestamp = Date.now();
const date = new Date();
const parsed = Date.parse("2026-08-04T00:00:00Z");
const highResolutionTime = performance.now();
const globalTimestamp = globalThis.Date.now();

void [timestamp, date, parsed, highResolutionTime, globalTimestamp];
