import { describe, expect, it } from "vitest";
import { replayFlight, type FlightRows } from "./world-model.ts";

const INCIDENT = new Date("2026-10-21T10:00:00Z");

// Shaped like Zetaris rows: every value is a string, sources arrive unsorted.
const rows: FlightRows = {
  policies: [
    { version: "2", max_return_days: "14", valid_from: "2026-10-18 00:00:00", note: "FIN-212" },
    { version: "1", max_return_days: "30", valid_from: "2026-01-01 00:00:00", note: "launch" },
  ],
  tickets: [{ ticket_id: "OPS-882", opened_at: "2026-10-21 16:00:00", team: "Support", subject: "Duplicate IDs?" }],
  decisions: [
    { request_id: "REQ-0003", ts: "2026-10-21T10:00:03.000Z", decision: "deny", days_since_delivery: "35", routed_model: "nvidia/n", reason: "too old", refund_id: null, amount_egp: null, from_cache: "false" },
    { request_id: "REQ-0001", ts: "2026-10-21T10:00:01.000Z", decision: "approve", days_since_delivery: "9", routed_model: "nvidia/n", reason: "ok", refund_id: "RF-0001", amount_egp: "500.00", from_cache: "true" },
    { request_id: "REQ-0002", ts: "2026-10-21T10:00:02.000Z", decision: "approve", days_since_delivery: "20", routed_model: "nvidia/n", reason: "within 30", refund_id: "RF-0002", amount_egp: "1200.00", from_cache: "false" },
  ],
};

describe("flight recorder on the World Model engine", () => {
  it("replays every write in time order with increasing seq", async () => {
    const flight = await replayFlight(rows, INCIDENT);
    expect(flight.events.map((e) => e.id)).toEqual(["policy v1", "policy v2", "REQ-0001", "REQ-0002", "REQ-0003", "OPS-882"]);
    const seqs = flight.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("reads the policy live at the incident from the engine's point-in-time fold", async () => {
    expect((await replayFlight(rows, INCIDENT)).policyAtIncident).toBe(14);
    expect((await replayFlight(rows, new Date("2026-10-01T00:00:00Z"))).policyAtIncident).toBe(30);
  });

  it("flags payouts past the live window as bad, comparing numbers not strings", async () => {
    const flight = await replayFlight(rows, INCIDENT);
    expect(flight.events.filter((e) => e.bad).map((e) => e.id)).toEqual(["REQ-0002"]);
    expect(flight.bad).toBe(1);
  });
});
