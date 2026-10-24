// The investigation: witnesses file evidence in parallel, hand off to RCA, and every
// claim lands in the Evidence Ledger with the Zetaris queries of the cells it cites.

import { runRootCause, type Chat, type ModelCall } from "./root-cause.ts";
import type { Contract } from "../gate/contract.ts";
import { proposeGuardrail } from "./remediator.ts";
import { runSkeptic, type Verdict } from "./skeptic.ts";
import { reportedHypotheses, runWitness, WITNESSES, type Evidence, type Query } from "./witness.ts";

export interface LedgerRow {
  id: string; kind: "root-cause" | "finding" | "reported"; by: string; claim: string;
  cells: string[]; sql: string[]; sources: string[]; rows: number;
  status: "open" | "survives" | "struck"; verdict?: Verdict;
}

export type InvestigationEvent =
  | { type: "mode"; mode: "live" | "replay" }
  | { type: "agent"; callsign: string; state: "working" | "done" | "failed"; note: string }
  | { type: "evidence"; evidence: Evidence }
  | { type: "handoff"; from: string; to: string; note: string }
  | { type: "model"; call: ModelCall }
  | { type: "ledger"; row: LedgerRow }
  | { type: "verdict"; verdict: Verdict }
  | { type: "contract"; contract: Contract }
  | { type: "done"; claims: number; survives: number; struck: number; ms: number }
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
    emit({ type: "ledger", row: { ...row } });
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
  emit({ type: "handoff", from: "RCA", to: "SKP", note: ledger.map((r) => r.id).join(", ") });
  emit({ type: "agent", callsign: "SKP", state: "working", note: "re-running every cited query, then probing" });
  try {
    await runSkeptic({
      query, ai, evidence, claims: ledger,
      onEvidence: (e) => { evidence.push(e); emit({ type: "evidence", evidence: e }); },
      onCall: (call) => emit({ type: "model", call }),
      onVerdict: (v) => { Object.assign(ledger.find((r) => r.id === v.id)!, { status: v.status, verdict: v }); emit({ type: "verdict", verdict: v }); },
    });
  } catch (err) {
    emit({ type: "agent", callsign: "SKP", state: "failed", note: (err as Error).message.slice(0, 200) });
    throw err;
  }
  const struck = ledger.filter((r) => r.status === "struck").length;
  emit({ type: "agent", callsign: "SKP", state: "done", note: `${struck} struck, ${ledger.length - struck} survive` });

  emit({ type: "handoff", from: "SKP", to: "REM", note: "surviving root cause" });
  emit({ type: "agent", callsign: "REM", state: "working", note: "compiling the root cause into a guardrail (no model call)" });
  const contract = proposeGuardrail(ledger, evidence);
  if (contract) emit({ type: "contract", contract });
  emit({ type: "agent", callsign: "REM", state: "done", note: contract ? `proposed ${contract.id}, awaiting a human signature` : "no surviving root cause, nothing to propose" });
  emit({ type: "done", claims: ledger.length, survives: ledger.length - struck, struck, ms: Date.now() - started });
  return { evidence, ledger, contract };
}
