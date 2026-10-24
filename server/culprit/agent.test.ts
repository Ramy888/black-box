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

describe("refund agent robustness", () => {
  it("reads a decision whose reason contains braces, and skips braces before the JSON", () => {
    expect(parseDecision('{"decision":"approve","reason":"within {30} days"}')).toEqual({ decision: "approve", reason: "within {30} days" });
    expect(parseDecision('Sure {see below} {"decision":"approve","reason":"ok"}')).toEqual({ decision: "approve", reason: "ok" });
  });

  it("stops every worker after the first failure, so nothing is written after the caller sees the error", async () => {
    const writes: string[] = [];
    const db = {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("FROM refund_requests")) return { rows: ["RR-0001", "RR-0002", "RR-0003", "RR-0004", "RR-0005"].map((id) => ({ id, order_id: `O-${id.slice(3)}`, reason: "x" })) };
        if (sql.includes("FROM orders")) return { rows: [{ id: values[0], amount_egp: "10", delivered_at: "2026-10-20T10:00:00Z" }] };
        if (sql.startsWith("INSERT INTO refunds")) writes.push(String(values[1]));
        return { rows: [] };
      },
    };
    let calls = 0;
    const ai = { chat: async () => {
      if (++calls === 1) throw new Error("model down");
      await new Promise((r) => setTimeout(r, 5));
      return { text: '{"decision":"approve","reason":"ok"}', model: "m" };
    } };
    await expect(runRefundAgent({ db, ai, runId: "r", now: new Date("2026-10-21T10:00:00Z") })).rejects.toThrow("model down");
    const atFailure = writes.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(writes.length).toBe(atFailure); // no stray worker kept paying
    expect(writes.length).toBeLessThanOrEqual(1); // at most the one request already in flight
  });

  it("fails clearly when a request points at a missing order", async () => {
    const db = { async query(sql: string) { return { rows: sql.includes("FROM refund_requests") ? [{ id: "RR-0009", order_id: "O-404", reason: "x" }] : [] }; } };
    await expect(runRefundAgent({ db, ai: { chat: async () => ({ text: "{}", model: "m" }) }, runId: "r", now: new Date() })).rejects.toThrow(/order O-404, which does not exist/);
  });
});
