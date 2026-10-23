// The investigation: witnesses file evidence in parallel, hand off to RCA, and every
// claim lands in the Evidence Ledger with the Zetaris queries of the cells it cites.

import { runRootCause, type Chat, type ModelCall } from "./root-cause.ts";
import { reportedHypotheses, runWitness, WITNESSES, type Evidence, type Query } from "./witness.ts";

export interface LedgerRow {
  id: string; kind: "root-cause" | "finding" | "reported"; by: string; claim: string;
  cells: string[]; sql: string[]; sources: string[]; rows: number; status: "open";
}

export type InvestigationEvent =
  | { type: "mode"; mode: "live" | "replay" }
  | { type: "agent"; callsign: string; state: "working" | "done" | "failed"; note: string }
  | { type: "evidence"; evidence: Evidence }
  | { type: "handoff"; from: string; to: string; note: string }
  | { type: "model"; call: ModelCall }
  | { type: "ledger"; row: LedgerRow }
  | { type: "done"; claims: number; ms: number }
  | { type: "error"; message: string };

export async function investigate({ query, ai, emit }: { query: Query; ai: Chat; emit: (e: InvestigationEvent) => void }) {
  const started = Date.now();
  const ledger: LedgerRow[] = [];
  const evidence: Evidence[] = [];
  const file = (r: Omit<LedgerRow, "id" | "sql" | "sources" | "rows" | "status">) => {
    const cited = evidence.filter((e) => r.cells.includes(e.cell));
    const row: LedgerRow = {
      ...r, id: `L${ledger.length + 1}`, status: "open",
      sql: cited.map((e) => e.sql), sources: [...new Set(cited.map((e) => e.source))], rows: cited.reduce((n, e) => n + e.rows.length, 0),
    };
    ledger.push(row);
    emit({ type: "ledger", row });
  };

  await Promise.all(WITNESSES.map(async (w) => {
    emit({ type: "agent", callsign: w.callsign, state: "working", note: `querying ${w.source}` });
    try {
      const found = await runWitness(w, query, (e) => { evidence.push(e); emit({ type: "evidence", evidence: e }); });
      emit({ type: "agent", callsign: w.callsign, state: "done", note: `${found.length} evidence ${found.length === 1 ? "tag" : "tags"}` });
      emit({ type: "handoff", from: w.callsign, to: "RCA", note: found.map((e) => e.cell).join(", ") });
    } catch (err) {
      emit({ type: "agent", callsign: w.callsign, state: "failed", note: (err as Error).message.slice(0, 200) });
      throw err;
    }
  }));
  evidence.sort((a, b) => a.cell.localeCompare(b.cell));

  for (const h of evidence.filter((e) => e.cell.startsWith("C")).flatMap(reportedHypotheses)) file({ kind: "reported", ...h });

  emit({ type: "agent", callsign: "RCA", state: "working", note: "Nemotron reasoning over the evidence" });
  try {
    const claims = await runRootCause(ai, evidence, (call) => emit({ type: "model", call }));
    for (const c of claims) file({ by: "RCA", ...c });
    emit({ type: "agent", callsign: "RCA", state: "done", note: `${claims.length} claims` });
  } catch (err) {
    emit({ type: "agent", callsign: "RCA", state: "failed", note: (err as Error).message.slice(0, 200) });
    throw err;
  }
  emit({ type: "done", claims: ledger.length, ms: Date.now() - started });
  return { evidence, ledger };
}
