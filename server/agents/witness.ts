// Witnesses: one per source. Each runs vetted Zetaris queries and files the rows as
// evidence tags on the hangar-floor grid (A1, B2, ...). No model call here on purpose:
// a witness reports what the data says, and the report is a template over real rows.

import { INCIDENT_AT } from "../../scenario/generate.ts";

export type Row = unknown[];
export type Query = (sql: string) => Promise<{ rows: Row[] }>;

export interface Evidence {
  cell: string; by: string; source: string; title: string;
  sql: string; columns: string[]; rows: Row[]; ms: number; report: string;
}

/** A hypothesis a witness files without judging it (a ticket that guesses a cause). */
export interface Reported { by: string; claim: string; cells: string[] }

const AT = `timestamp '${INCIDENT_AT.toISOString().slice(0, 19).replace("T", " ")}'`;
const LIVE_DAYS = "(SELECT max_return_days FROM SHOP_PG.policy_versions WHERE valid_to IS NULL)";
const num = (v: unknown) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const day = (v: unknown) => String(v).slice(0, 10);

export interface Survey { cell: string; title: string; columns: string[]; sql: string; report: (rows: Row[]) => string }
export interface Witness { callsign: string; source: string; surveys: Survey[] }

export const WITNESSES: Witness[] = [
  {
    callsign: "WIT·1", source: "SHOP_PG · Postgres",
    surveys: [
      {
        cell: "A1", title: "Refund policy versions", columns: ["version", "max_return_days", "valid_from", "valid_to", "note"],
        sql: "SELECT version, max_return_days, valid_from, valid_to, note FROM SHOP_PG.policy_versions ORDER BY version",
        report: (rows) => rows.map((r) => `Policy v${r[0]} allows ${r[1]} days from ${day(r[2])}${r[3] ? ` to ${day(r[3])}` : " and is live"} (${r[4]})`).join("; ") + ".",
      },
      {
        cell: "A2", title: "Refunds paid past the live window", columns: ["refunds", "egp", "min_days", "max_days"],
        sql: `SELECT count(*) AS refunds, sum(f.amount_egp) AS egp, min(datediff(${AT}, o.delivered_at)) AS min_days, max(datediff(${AT}, o.delivered_at)) AS max_days
FROM SHOP_PG.refunds f JOIN SHOP_PG.orders o ON o.id = f.order_id
WHERE datediff(${AT}, o.delivered_at) > ${LIVE_DAYS}`,
        report: ([r]) => Number(r?.[0]) === 0 ? "No refunds were paid past the live return window." :
          `${num(r[0])} refunds totalling ${num(r[1])} EGP were paid for orders delivered ${r[2]} to ${r[3]} days before the incident, past the live return window.`,
      },
    ],
  },
  {
    callsign: "WIT·2", source: "BB_FILES.agent_traces · JSON",
    surveys: [
      {
        cell: "B1", title: "What the refund agent ran with", columns: ["policy_in_prompt", "routed_model", "reasoning", "decisions"],
        sql: "SELECT policy_in_prompt, routed_model, reasoning, count(*) AS decisions FROM BB_FILES.agent_traces GROUP BY policy_in_prompt, routed_model, reasoning",
        // "reasoning" is what the agent asked for; Nemotron 3.5 reasons regardless, so the report says "requested".
        report: (rows) => rows.map((r) => `${r[3]} refund decisions ran on ${r[1]} (reasoning requested ${r[2]}), prompted with the policy "${r[0]}"`).join("; ") + ".",
      },
      {
        cell: "B2", title: "Why the agent paid past the window", columns: ["reason", "payouts"],
        sql: `SELECT t.reason, count(*) AS payouts FROM BB_FILES.agent_traces t JOIN SHOP_PG.refunds f ON f.request_id = t.request_id
WHERE t.days_since_delivery > ${LIVE_DAYS} GROUP BY t.reason ORDER BY payouts DESC`,
        report: (rows) => rows.length === 0 ? "The agent paid no refunds past the live window." :
          `Paid refunds past the live window, by the agent's own stated reason: ${rows.slice(0, 3).map((r) => `"${r[0]}" ×${r[1]}`).join(", ")}${rows.length > 3 ? `, and ${rows.length - 3} more reasons` : ""}.`,
      },
    ],
  },
  {
    callsign: "WIT·3", source: "BB_FILES.ops_tickets · CSV",
    surveys: [
      {
        cell: "C1", title: "Ops tickets after the incident", columns: ["ticket_id", "team", "subject"],
        sql: "SELECT ticket_id, team, subject FROM BB_FILES.ops_tickets ORDER BY opened_at",
        report: (rows) => `Ops tickets after the incident: ${rows.map((r) => `${r[0]} (${r[1]}) "${r[2]}"`).join("; ")}.`,
      },
    ],
  },
];

export async function runWitness(w: Witness, query: Query, onEvidence: (e: Evidence) => void): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const s of w.surveys) {
    const started = Date.now();
    const { rows } = await query(s.sql);
    const e: Evidence = { cell: s.cell, by: w.callsign, source: w.source, title: s.title, sql: s.sql, columns: s.columns, rows, ms: Date.now() - started, report: s.report(rows) };
    out.push(e);
    onEvidence(e);
  }
  return out;
}

/** Tickets that guess at a cause (subject ends in "?") are filed as hypotheses for the Skeptic, unjudged. */
export function reportedHypotheses(tickets: Evidence): Reported[] {
  return tickets.rows.filter((r) => String(r[2]).trim().endsWith("?"))
    .map((r) => ({ by: tickets.by, claim: `Reported by ${r[1]} in ${r[0]}: ${r[2]}`, cells: [tickets.cell] }));
}
