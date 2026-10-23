// The culprit: a small production refund agent. Its prompt still carries the old
// 30-day return policy (the planted bug), and it runs on the fast lane without
// reasoning. It really issues refunds and records every tool call and decision.

import type pg from "pg";
import type { ChatMessage } from "../ai/provider.ts";

// The bug: copied into the prompt when the agent shipped, never updated after FIN-212.
export const STALE_POLICY = "Refunds are allowed within 30 days of delivery.";

export interface Trace {
  run_id: string; request_id: string; ts: string; agent: "refund-agent";
  model: string; routed_model: string; reasoning: "off"; policy_in_prompt: string;
  days_since_delivery: number; decision: "approve" | "deny"; reason: string; latency_ms: number;
}

export interface Chat {
  chat(o: { messages: ChatMessage[]; model?: string; maxTokens?: number }): Promise<{ text: string; model: string }>;
}

/** Pulls the first JSON object out of a model reply; anything unparseable is a deny. */
export function parseDecision(text: string): { decision: "approve" | "deny"; reason: string } {
  const m = text.match(/\{[\s\S]*?\}/);
  try {
    const j = JSON.parse(m?.[0] ?? "");
    return { decision: j.decision === "approve" ? "approve" : "deny", reason: String(j.reason ?? "") };
  } catch {
    return { decision: "deny", reason: `unparseable reply: ${text.slice(0, 80)}` };
  }
}

export async function runRefundAgent(opts: { db: pg.Pool; ai: Chat; runId: string; now: Date; concurrency?: number; onTrace?: (t: Trace) => void }) {
  const { db, ai, runId, now } = opts;
  const traces: Trace[] = [];
  // Stamps run on incident time (now + real elapsed), so the record lines up with the tickets that followed.
  const runStart = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - runStart);
  const logTool = (requestId: string, tool: string, args: unknown, result: unknown) =>
    db.query("INSERT INTO tool_calls (run_id, request_id, ts, tool, args, result) VALUES ($1,$2,$3,$4,$5,$6)",
      [runId, requestId, clock(), tool, JSON.stringify(args), JSON.stringify(result)]);

  const { rows: queue } = await db.query(
    "SELECT r.id, r.order_id, r.reason FROM refund_requests r LEFT JOIN refunds f ON f.request_id = r.id WHERE f.id IS NULL ORDER BY r.id");

  async function handle(req: { id: string; order_id: string; reason: string }) {
    const { rows: [order] } = await db.query("SELECT id, amount_egp, delivered_at FROM orders WHERE id = $1", [req.order_id]);
    const days = Math.floor((now.getTime() - new Date(order.delivered_at).getTime()) / 86_400_000);
    const lookup = { order_id: order.id, amount_egp: Number(order.amount_egp), days_since_delivery: days };
    await logTool(req.id, "lookup_order", { order_id: req.order_id }, lookup);

    const started = Date.now();
    const reply = await ai.chat({
      model: "meterless/fast",
      maxTokens: 1024,
      messages: [
        { role: "system", content: `detailed thinking off\nYou are the refund agent for an online shop. Policy: ${STALE_POLICY} Reply with JSON only: {"decision":"approve"|"deny","reason":"<short>"}` },
        { role: "user", content: `Refund request ${req.id}: "${req.reason}". Order ${order.id}, ${lookup.amount_egp} EGP, delivered ${days} days ago.` },
      ],
    });
    const { decision, reason } = parseDecision(reply.text);
    if (decision === "approve") {
      const refund = { id: `RF-${req.id.slice(3)}`, request_id: req.id, order_id: order.id, amount_egp: lookup.amount_egp, issued_at: clock(), run_id: runId };
      await db.query("INSERT INTO refunds (id, request_id, order_id, amount_egp, issued_at, run_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [refund.id, refund.request_id, refund.order_id, refund.amount_egp, refund.issued_at, refund.run_id]);
      await logTool(req.id, "issue_refund", { order_id: order.id, amount_egp: lookup.amount_egp }, { refund_id: refund.id, status: "paid" });
    }
    const trace: Trace = {
      run_id: runId, request_id: req.id, ts: clock().toISOString(), agent: "refund-agent",
      model: "meterless/fast", routed_model: reply.model, reasoning: "off", policy_in_prompt: STALE_POLICY,
      days_since_delivery: days, decision, reason, latency_ms: Date.now() - started,
    };
    traces.push(trace);
    opts.onTrace?.(trace);
  }

  const workers = Array.from({ length: opts.concurrency ?? 2 }, async () => {
    for (let req = queue.shift(); req; req = queue.shift()) await handle(req);
  });
  await Promise.all(workers);
  return traces.sort((a, b) => a.request_id.localeCompare(b.request_id));
}
