import { describe, expect, it, vi } from "vitest";
import { parseDecision, runRefundAgent, STALE_POLICY } from "./agent.ts";

describe("refund agent", () => {
  it("still carries the stale 30-day policy (the planted bug)", () => {
    expect(STALE_POLICY).toContain("30 days");
  });

  it("reads the decision JSON even with text around it", () => {
    expect(parseDecision('Sure. {"decision":"approve","reason":"within 30 days"} done')).toEqual({ decision: "approve", reason: "within 30 days" });
  });

  it("denies when the reply is not valid JSON", () => {
    expect(parseDecision("I think yes").decision).toBe("deny");
  });

  it("treats any unknown decision value as deny", () => {
    expect(parseDecision('{"decision":"maybe"}').decision).toBe("deny");
  });
});

describe("refund agent behind a gate", () => {
  // A fake shop DB that records every write.
  function fakeDb() {
    const writes: { sql: string; values: unknown[] }[] = [];
    return {
      writes,
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("FROM refund_requests")) return { rows: [{ id: "RR-0090", order_id: "O-0090", reason: "too big" }] };
        if (sql.includes("FROM orders")) return { rows: [{ id: "O-0090", amount_egp: "900.00", delivered_at: "2026-10-01T10:00:00Z" }] };
        writes.push({ sql, values });
        return { rows: [] };
      },
    };
  }
  const approve = { chat: async () => ({ text: '{"decision":"approve","reason":"Within 30-day window"}', model: "nvidia/nemotron" }) };
  const now = new Date("2026-10-21T10:00:00Z");

  it("still lets the model decide, but the gate stops the payout and logs the block", async () => {
    const db = fakeDb();
    const gate = vi.fn(() => ({ allow: false, contract_id: "GC-1", clause: "within the live window only" }));
    const [t] = await runRefundAgent({ db, ai: approve, runId: "airlock", now, requestIds: ["RR-0090"], gate });
    expect(gate).toHaveBeenCalledWith({ request_id: "RR-0090", days_since_delivery: 20, amount_egp: 900 });
    expect(t).toMatchObject({ decision: "approve", blocked_by: { contract_id: "GC-1", clause: "within the live window only" } });
    expect(db.writes.some((w) => w.sql.startsWith("INSERT INTO refunds"))).toBe(false);
    expect(db.writes.find((w) => w.values[3] === "issue_refund")!.values[5]).toContain('"status":"blocked"');
  });

  it("pays when the gate allows", async () => {
    const db = fakeDb();
    await runRefundAgent({ db, ai: approve, runId: "r", now, requestIds: ["RR-0090"], gate: () => ({ allow: true, contract_id: "GC-1" }) });
    expect(db.writes.some((w) => w.sql.startsWith("INSERT INTO refunds"))).toBe(true);
  });
});
