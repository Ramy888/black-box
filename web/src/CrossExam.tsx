// Cross-examination: the Counterpart (a customer-success VP) questions the surviving
// claims; RCA must answer from the ledger, or the claim is marked weak.

import { useRef, useState } from "react";
import type { CrossExamEvent, Exchange } from "../../server/agents/counterpart.ts";
import type { ModelCall } from "../../server/agents/root-cause.ts";

export function CrossExam({ ready, onCall, onWeak }: { ready: boolean; onCall: (c: ModelCall) => void; onWeak: (id: string) => void }) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [status, setStatus] = useState<string>();
  const [running, setRunning] = useState(false);
  const source = useRef<EventSource>();

  function run() {
    source.current?.close();
    setExchanges([]); setStatus(undefined); setRunning(true);
    const es = new EventSource("/api/crossexam");
    source.current = es;
    const stop = (msg: string) => { setStatus(msg); setRunning(false); es.close(); };
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as CrossExamEvent;
      if (e.type === "model") onCall(e.call);
      if (e.type === "exchange") { setExchanges((v) => [...v, e.exchange]); if (e.exchange.weak) onWeak(e.exchange.target); }
      if (e.type === "crossexam-done") stop(e.weak.length ? `Weak under questioning: ${e.weak.join(", ")}` : `All ${e.asked} answers cited the ledger.`);
      if (e.type === "crossexam-error") stop(`Cross-examination failed: ${e.message}`);
    };
    es.onerror = () => stop("Lost the connection to the cross-examination stream.");
  }

  return (
    <section className="panel crossexam">
      <header><b>Cross-examination</b><span className="mono muted">CNT · VP Customer Success</span></header>
      <div className="airlock-row">
        <button className="primary" onClick={run} disabled={!ready || running}>{running ? "Cross-examining…" : "Cross-examine the finding"}</button>
        {status && <span className={status.startsWith("Cross-examination failed") || status.startsWith("Lost") ? "error" : "muted"}>{status}</span>}
        {!ready && <span className="muted">Runs after the investigation.</span>}
      </div>
      <ol className="exchanges">
        {exchanges.map((x, i) => (
          <li key={i} className={x.weak ? "weak" : ""}>
            <p><span className="mono">CNT → {x.target}</span> {x.question}</p>
            <p><span className="mono">RCA</span> {x.answer} <span className="mono muted">[{x.cites.join(", ")}]</span>{x.weak && <b className="error"> {x.target} marked weak: no ledger citation</b>}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
