// The flight recorder, built on the Meterless World Model engine. Incident rows from
// Zetaris are written into its event-sourced log in time order; the replay reads the
// log back, and the policy that was live at the incident comes from the engine's
// point-in-time fold, not from our own bookkeeping.

import type { createZetaris } from "../data/zetaris.ts";
import { loadEngine } from "./load.ts";

type Cell = string | number | null;
export interface FlightRows {
  policies: { version: Cell; max_return_days: Cell; valid_from: Cell; note: Cell }[];
  tickets: { ticket_id: Cell; opened_at: Cell; team: Cell; subject: Cell }[];
  decisions: { request_id: Cell; ts: Cell; decision: Cell; days_since_delivery: Cell; routed_model: Cell; reason: Cell; refund_id: Cell; amount_egp: Cell; from_cache: Cell }[];
}

export interface FlightEvent {
  seq: number; at: string; kind: "policy" | "ticket" | "decision";
  id: string; label: string; detail: string; bad: boolean;
}

const RUN_ID = "run-0417";

// Zetaris returns timestamps without a zone ("2026-10-18 00:00:00"); the data is UTC.
const iso = (v: Cell) => {
  const s = String(v);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`).toISOString();
};

export async function replayFlight(rows: FlightRows, asOf: Date) {
  const { mod, source: engine } = await loadEngine("world-model");
  const wm = new mod.WorldModel({ namespace: "flight" });
  const policyId: string = mod.externalId("policy", "shop", "refunds");
  const shop = (id: Cell) => ({ system: "shop", id: String(id) });

  const writes: { at: string; write: (at: string) => Promise<unknown> }[] = [
    ...rows.policies.map((p) => ({
      at: iso(p.valid_from),
      write: (at: string) => wm.upsertEntity({
        type: "policy", externalKey: shop("refunds"),
        attrs: { version: Number(p.version), max_return_days: Number(p.max_return_days), note: p.note },
        source: { kind: "api", by: "SHOP_PG.policy_versions", at, runId: RUN_ID },
      }),
    })),
    ...rows.tickets.map((t) => ({
      at: iso(t.opened_at),
      write: (at: string) => wm.upsertEntity({
        type: "ticket", externalKey: shop(t.ticket_id), attrs: { team: t.team, subject: t.subject },
        source: { kind: "file", by: "BB_FILES.ops_tickets", at, runId: RUN_ID },
      }),
    })),
    ...rows.decisions.map((d) => ({
      at: iso(d.ts),
      write: (at: string) => wm.upsertEntity({
        type: "request", externalKey: shop(d.request_id),
        attrs: {
          decision: d.decision, days_since_delivery: Number(d.days_since_delivery), reason: d.reason,
          routed_model: d.routed_model, from_cache: String(d.from_cache) === "true", refund_id: d.refund_id, amount_egp: d.amount_egp == null ? null : Number(d.amount_egp),
        },
        source: { kind: "agent", by: "refund-agent", at, runId: RUN_ID },
      }),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  // The engine appends in call order, so the sort above is what makes the replay chronological.
  for (const w of writes) await w.write(w.at);

  const limit = Number(wm.view("snapshot").entityAt(policyId, asOf.toISOString())?.attrs.max_return_days);
  const events: FlightEvent[] = wm.view("timeline").get()
    .filter((e: any) => e.kind === "upsertEntity")
    .map((e: any) => toFlightEvent(e.seq, e.payload, limit));
  return { engine, runId: RUN_ID, policyAtIncident: limit, bad: events.filter((e) => e.bad).length, events };
}

function toFlightEvent(seq: number, entity: any, limit: number): FlightEvent {
  const a = entity.attrs;
  const base = { seq, at: entity.source.at, id: String(entity.id).split(":").pop()! };
  if (entity.type === "policy") {
    return { ...base, kind: "policy", id: `policy v${a.version}`, label: `Return window set to ${a.max_return_days} days`, detail: String(a.note), bad: false };
  }
  if (entity.type === "ticket") {
    return { ...base, kind: "ticket", label: String(a.subject), detail: `${a.team} ticket`, bad: false };
  }
  const paid = a.decision === "approve";
  return {
    ...base, kind: "decision",
    label: paid ? `Refund ${a.refund_id ?? ""} paid, ${a.amount_egp ?? "?"} EGP` : "Refund denied",
    detail: `${a.days_since_delivery} days after delivery · ${a.reason} · ${a.routed_model}${a.from_cache ? " (Nightshift cache)" : ""}`,
    bad: paid && a.days_since_delivery > limit,
  };
}

/** Reads the three incident sources through Zetaris: Postgres, the tickets CSV and the traces JSON. */
export async function loadFlightRows(zx: ReturnType<typeof createZetaris>): Promise<FlightRows> {
  const pick = async <K extends string>(cols: K[], sql: string) =>
    (await zx.query(sql)).rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] as Cell])) as Record<K, Cell>);
  const [policies, tickets, decisions] = await Promise.all([
    pick(["version", "max_return_days", "valid_from", "note"], "SELECT version, max_return_days, valid_from, note FROM SHOP_PG.policy_versions"),
    pick(["ticket_id", "opened_at", "team", "subject"], "SELECT ticket_id, opened_at, team, subject FROM BB_FILES.ops_tickets"),
    pick(["request_id", "ts", "decision", "days_since_delivery", "routed_model", "reason", "refund_id", "amount_egp", "from_cache"],
      `SELECT t.request_id, t.ts, t.decision, t.days_since_delivery, t.routed_model, t.reason, f.id, f.amount_egp, t.from_cache
       FROM BB_FILES.agent_traces t LEFT JOIN SHOP_PG.refunds f ON f.request_id = t.request_id`),
  ]);
  return { policies, tickets, decisions };
}
