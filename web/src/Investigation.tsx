// Investigation Room: streams the investigation over SSE. Agents on the left, evidence
// tags and the ledger in the middle, the Nemotron thinking budget on the right.

import { useRef, useState } from "react";
import type { InvestigationEvent, LedgerRow } from "../../server/agents/investigate.ts";
import type { ModelCall } from "../../server/agents/root-cause.ts";
import type { Evidence } from "../../server/agents/witness.ts";
import { Recorder, RECORDER_CALLSIGNS as CALLSIGNS } from "./Recorder.tsx";

const MAX_BUDGET = 8192;
type AgentState = { state: "idle" | "working" | "done" | "failed"; note: string };

export function Investigation() {
  const [mode, setMode] = useState<"live" | "replay">();
  const [running, setRunning] = useState(false);
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [calls, setCalls] = useState<ModelCall[]>([]);
  const [status, setStatus] = useState<string>();
  const [events, setEvents] = useState<InvestigationEvent[]>([]);
  const source = useRef<EventSource>();

  function start() {
    source.current?.close();
    setAgents({}); setEvidence([]); setLedger([]); setCalls([]); setEvents([]); setStatus(undefined); setRunning(true);
    const es = new EventSource("/api/investigate");
    source.current = es;
    const stop = (msg: string) => { setStatus(msg); setRunning(false); es.close(); };
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as InvestigationEvent;
      setEvents((v) => [...v, e]);
      if (e.type === "mode") setMode(e.mode);
      if (e.type === "agent") setAgents((a) => ({ ...a, [e.callsign]: { state: e.state, note: e.note } }));
      if (e.type === "evidence") setEvidence((v) => [...v, e.evidence].sort((a, b) => a.cell.localeCompare(b.cell)));
      if (e.type === "ledger") setLedger((v) => [...v, e.row]);
      if (e.type === "model") setCalls((v) => [...v, e.call]);
      if (e.type === "verdict") setLedger((v) => v.map((r) => (r.id === e.verdict.id ? { ...r, status: e.verdict.status, verdict: e.verdict } : r)));
      if (e.type === "done") stop(`${e.survives} claims survive, ${e.struck} struck by SKP · ${Math.round(e.ms / 1000)} s`);
      if (e.type === "error") stop(`Investigation failed: ${e.message}`);
    };
    es.onerror = () => stop("Lost the connection to the investigation stream.");
  }

  const last = calls.at(-1);
  const cellOf = (c: string) => evidence.find((e) => e.cell === c);

  return (
    <section className="room">
      <header className="room-head">
        <button className="primary" onClick={start} disabled={running}>{running ? "Investigating…" : "Investigate"}</button>
        {mode && <span className={`mode ${mode}`}>{mode === "replay" ? "Replay: recorded run" : "Live: Zetaris + Nightshift"}</span>}
        {status && <span className={status.startsWith("Investigation failed") || status.startsWith("Lost") ? "error" : "muted"}>{status}</span>}
      </header>

      <div className="room-grid">
        <section className="panel agents">
          <header><b>Agents</b><span className="mono muted">callsign · state</span></header>
          <ol>
            {CALLSIGNS.map((c) => {
              const a = agents[c] ?? { state: "idle", note: c === "RCA" ? "waits for the witnesses" : c === "SKP" ? "waits for the claims" : "waits for Investigate" };
              return (
                <li key={c} className={`agent ${a.state}`}>
                  <span className="mono callsign">{c}</span>
                  <span><b>{a.state}</b><br /><span className="muted">{a.note}</span></span>
                </li>
              );
            })}
          </ol>
          <Recorder events={events} />
        </section>

        <section className="panel ledger">
          <header><b>Evidence ledger</b><span className="mono muted">{ledger.length} claims · {evidence.length} evidence tags</span></header>
          {ledger.length > 0 && (
            <table>
              <thead><tr><th>Cell</th><th>Claim</th><th>Rows</th><th>Status</th></tr></thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={r.id} className={r.status}>
                    <td className="mono">{r.cells.join(" ")}</td>
                    <td>
                      <span className="mono muted">{r.id} · {r.by} · {r.kind}</span><br /><span className="claim">{r.claim}</span>
                      <details className="query">
                        <summary className="mono muted">{r.sql.length} Zetaris {r.sql.length === 1 ? "query" : "queries"} · {r.sources.join(" + ")}</summary>
                        {r.cells.map((c) => <pre key={c} className="mono"><b>{c}</b> {cellOf(c)?.sql}</pre>)}
                      </details>
                    </td>
                    <td className="mono">{r.rows}</td>
                    <td className="status">
                      {r.verdict ? <b>{r.verdict.status === "struck" ? "Struck by SKP" : "Survives SKP"}</b> : r.kind === "reported" ? "Open, unverified" : "Open"}
                      {r.verdict && <span className="muted"><br />{r.verdict.why}{r.verdict.cells.length ? ` [${r.verdict.cells.join(", ")}]` : ""}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="tags">
            {evidence.map((e) => (
              <article key={e.cell} className="tag">
                <span className="mono cell">{e.cell}</span>
                <b>{e.title}</b>
                <p>{e.report}</p>
                <span className="mono muted">{e.by} · {e.source} · {e.rows.length} rows · {e.ms} ms</span>
              </article>
            ))}
          </div>
        </section>

        <section className="panel budget">
          <header><b>Thinking budget</b><span className="mono muted">Nemotron</span></header>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={MAX_BUDGET} aria-valuenow={last?.budget ?? 0} aria-label="Nemotron thinking budget">
            <div className="fill" style={{ width: `${((last?.budget ?? 0) / MAX_BUDGET) * 100}%` }} />
          </div>
          <p className="mono">{last ? `${last.budget.toLocaleString("en-US")} tokens` : "idle"}</p>
          <p className="muted">{caption(calls)}</p>
          <ol className="calls mono">
            {calls.map((c, i) => (
              <li key={i}>{c.raised_by ? "↑ " : ""}{c.callsign} {c.budget.toLocaleString("en-US")} · {c.outcome}{c.receipt ? ` · ${Math.round(c.receipt.ms / 1000)} s${c.receipt.from_cache ? " · cache" : ""}` : ""}</li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}

function caption(calls: ModelCall[]): string {
  const last = calls.at(-1);
  if (!last) return "Nemotron always reasons before it answers; the token budget is the lever.";
  const n = (v: number) => v.toLocaleString("en-US");
  if (last.raised_by) return `Raised to ${n(last.budget)}: ${last.raised_by}, so every round after a refutation starts higher.`;
  const prev = calls.at(-2);
  if (prev && prev.callsign === last.callsign && prev.outcome !== "ok" && last.budget > prev.budget) {
    return `Raised to ${n(last.budget)}: ${prev.outcome === "exhausted" ? `Nemotron ran out of budget at ${n(prev.budget)} while reasoning` : `the reply at ${n(prev.budget)} was unusable`}.`;
  }
  if (last.outcome === "ok") return `${last.callsign} answered within ${n(last.budget)} tokens.`;
  return last.outcome === "exhausted" ? `${last.callsign} ran out of budget at ${n(last.budget)}.` : `${last.callsign}'s reply at ${n(last.budget)} was unusable.`;
}
