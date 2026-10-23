// The Skeptic (SKP): tries to refute every claim in the ledger. First it re-runs each
// cited query on its own; evidence that does not reproduce is struck with no model call.
// Then it runs its own falsification probes and asks Nemotron for a verdict per claim,
// one round at a time. Each strike makes the next round start one rung higher.

import type { ChatMessage } from "../ai/provider.ts";
import { askWithLadder, InvalidReply, LADDER, type Chat, type ModelCall } from "./root-cause.ts";
import { runWitness, type Evidence, type Query, type Survey } from "./witness.ts";

export interface Verdict {
  id: string; status: "survives" | "struck"; by: "SKP"; cells: string[]; why: string; reproduced: boolean;
}

export interface Judged { id: string; claim: string; cells: string[] }

export const PROBES: Survey[] = [
  {
    cell: "S1", title: "Duplicate payment refs, ticket vs payments", columns: ["ticket_id", "payments", "distinct_refs"],
    sql: `SELECT t.ticket_id, count(p.id) AS payments, count(DISTINCT p.provider_ref) AS distinct_refs
FROM BB_FILES.ops_tickets t CROSS JOIN SHOP_PG.payments p
WHERE lower(t.subject) LIKE '%duplicate%' GROUP BY t.ticket_id`,
    report: (rows) => rows.length === 0 ? "No ticket mentions duplicates." : rows.map((r) =>
      `${r[0]} asks about duplicate payment IDs; the payments table has ${r[1]} payments with ${r[2]} distinct provider refs, so ${Number(r[1]) - Number(r[2])} duplicates`).join("; ") + ".",
  },
  {
    cell: "S2", title: "Requests refunded more than once", columns: ["refunds", "refunded_requests"],
    sql: "SELECT count(*) AS refunds, count(DISTINCT request_id) AS refunded_requests FROM SHOP_PG.refunds",
    report: ([r]) => `${r[0]} refunds were issued for ${r[1]} distinct requests, so ${Number(r[0]) - Number(r[1])} requests were refunded more than once.`,
  },
];

const SYSTEM = `You are SKP, the Skeptic in an AI incident investigation. Try to refute the claim using only the evidence given.
Evidence is tagged with grid cells. Reply with exactly two lines and nothing else:
VERDICT: SURVIVES [cells]   or   VERDICT: STRUCK [cells]
WHY: <one sentence>
[cells] lists the evidence cells that decide the verdict. Read the cited evidence together: the claim survives if that evidence supports it.
Strike it if the evidence contradicts it, or if it asserts something none of the evidence shows.`;

export function parseVerdict(text: string, valid: Set<string>): { status: Verdict["status"]; cells: string[]; why: string } {
  const clean = text.replace(/[*_`#>]+/g, " ");
  const v = clean.match(/VERDICT\s*:\s*(SURVIVES|STRUCK)\s*\[([^\]]*)\]/i);
  const why = clean.match(/WHY\s*:\s*(.+)/i)?.[1].trim();
  if (!v || !why) throw new InvalidReply(`no VERDICT and WHY lines in: ${text.slice(0, 200)}`);
  const cells = v[2].split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter((c) => valid.has(c));
  const status = v[1].toUpperCase() === "STRUCK" ? "struck" : "survives";
  // A strike has to point at the evidence that refutes the claim.
  if (status === "struck" && !cells.length) throw new InvalidReply(`STRUCK without a real cell in: ${text.slice(0, 200)}`);
  return { status, cells, why };
}

export async function runSkeptic({ query, ai, evidence, claims, onEvidence, onCall, onVerdict }: {
  query: Query; ai: Chat; evidence: Evidence[]; claims: Judged[];
  onEvidence: (e: Evidence) => void; onCall: (c: ModelCall) => void; onVerdict: (v: Verdict) => void;
}): Promise<Verdict[]> {
  const byCell = new Map(evidence.map((e) => [e.cell, e]));
  // Re-run every cited query independently, before any model is asked anything.
  const reproduced = new Map(await Promise.all([...new Set(claims.flatMap((c) => c.cells))].map(async (cell) => {
    const again = (await query(byCell.get(cell)!.sql)).rows;
    return [cell, JSON.stringify(again) === JSON.stringify(byCell.get(cell)!.rows)] as const;
  })));
  const probes = await runWitness({ callsign: "SKP", source: "Zetaris federation · probes", surveys: PROBES }, query, onEvidence);
  const probeLines = probes.map((p) => `[${p.cell}] ${p.report}`).join("\n");

  const verdicts: Verdict[] = [];
  let strikes: string[] = [];
  for (const c of claims) {
    const broken = c.cells.filter((cell) => !reproduced.get(cell));
    let v: Verdict;
    if (broken.length) {
      v = { id: c.id, status: "struck", by: "SKP", cells: broken, why: `Evidence ${broken.join(", ")} did not reproduce when SKP re-ran the query.`, reproduced: false };
    } else {
      const valid = new Set([...c.cells, ...probes.map((p) => p.cell)]);
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Claim ${c.id}: ${c.claim}\nCited evidence:\n${c.cells.map((cell) => `[${cell}] ${byCell.get(cell)!.report}`).join("\n")}\nSkeptic probes:\n${probeLines}` },
      ];
      // Each strike starts the next round a rung higher, but never on the top rung: running out must still have somewhere to climb.
      const start = Math.min(strikes.length, LADDER.length - 2);
      const out = await askWithLadder(ai, "SKP", messages, (text) => parseVerdict(text, valid), onCall,
        { start, raisedBy: strikes.length ? `SKP struck ${strikes.join(", ")}` : undefined });
      v = { id: c.id, by: "SKP", reproduced: true, ...out };
    }
    if (v.status === "struck") strikes = [...strikes, c.id];
    verdicts.push(v);
    onVerdict(v);
  }
  return verdicts;
}
