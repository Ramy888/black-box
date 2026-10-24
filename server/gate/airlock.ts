// The Airlock: replays the incident's bad requests through the real refund agent with
// the signed guardrail in front of issue_refund. It runs in one sealed transaction that
// is always rolled back, so the incident data the investigation reads never changes.

import type pg from "pg";
import { INCIDENT_AT } from "../../scenario/generate.ts";
import { runRefundAgent, type Chat } from "../culprit/agent.ts";
import { activateGate, type Contract } from "./contract.ts";

export const AIRLOCK_RUN = "airlock-0417";

export type AirlockEvent =
  | { type: "airlock-start"; contract_id: string; signer: string; signature: string; requests: number; live_max_days: number; live_version: number }
  | { type: "attempt"; request_id: string; decision: "approve" | "deny"; days_since_delivery: number; from_cache: boolean; blocked: boolean; clause?: string }
  | { type: "airlock-done"; attempted: number; blocked: number; payouts: number; ms: number; sealed: true }
  | { type: "airlock-error"; message: string };

export async function runAirlock({ pool, ai, contract, key, emit }: {
  pool: pg.Pool; ai: Chat; contract: Contract; key: string; emit: (e: AirlockEvent) => void;
}) {
  const started = Date.now();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows: [live] } = await db.query("SELECT version, max_return_days FROM policy_versions WHERE valid_to IS NULL");
    // The same requests the incident paid outside the live window, computed the way the agent computes days.
    const { rows: bad } = await db.query(
      `SELECT f.request_id FROM refunds f JOIN orders o ON o.id = f.order_id
       WHERE floor(extract(epoch FROM ($1::timestamptz - o.delivered_at)) / 86400) > $2 ORDER BY f.request_id`,
      [INCIDENT_AT, live.max_return_days]);
    const gate = await activateGate(contract, key, live.max_return_days);
    emit({ type: "airlock-start", contract_id: contract.id, signer: contract.approved_by!, signature: contract.signature!, requests: bad.length, live_max_days: live.max_return_days, live_version: live.version });

    const traces = await runRefundAgent({
      db, ai, runId: AIRLOCK_RUN, now: INCIDENT_AT, requestIds: bad.map((r) => r.request_id), gate,
      onTrace: (t) => emit({ type: "attempt", request_id: t.request_id, decision: t.decision, days_since_delivery: t.days_since_delivery, from_cache: t.from_cache, blocked: Boolean(t.blocked_by), clause: t.blocked_by?.clause }),
    });
    const { rows: [paid] } = await db.query("SELECT count(*)::int AS n FROM refunds WHERE run_id = $1", [AIRLOCK_RUN]);
    const done = { type: "airlock-done" as const, attempted: traces.length, blocked: traces.filter((t) => t.blocked_by).length, payouts: paid.n, ms: Date.now() - started, sealed: true as const };
    emit(done);
    return done;
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    db.release();
  }
}
