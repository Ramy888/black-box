// The Airlock: the incident's bad requests replayed through the real refund agent with
// the signed guardrail active. The climax is a hard cut: a full-width orange BLOCKED band,
// no easing, then stillness.

import { useRef, useState } from "react";
import type { Contract } from "../../server/gate/contract.ts";
import type { AirlockEvent } from "../../server/gate/airlock.ts";

type Start = Extract<AirlockEvent, { type: "airlock-start" }>;
type Attempt = Extract<AirlockEvent, { type: "attempt" }>;
type Done = Extract<AirlockEvent, { type: "airlock-done" }>;

export function Airlock({ approved }: { approved?: Contract }) {
  const [start, setStart] = useState<Start>();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [done, setDone] = useState<Done>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const source = useRef<EventSource>();

  function run() {
    source.current?.close();
    setStart(undefined); setAttempts([]); setDone(undefined); setError(undefined); setRunning(true);
    const es = new EventSource("/api/airlock");
    source.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AirlockEvent;
      if (e.type === "airlock-start") setStart(e);
      if (e.type === "attempt") setAttempts((v) => [...v, e]);
      if (e.type === "airlock-done") { setDone(e); setRunning(false); es.close(); }
      if (e.type === "airlock-error") { setError(e.message); setRunning(false); es.close(); }
    };
    es.onerror = () => { setError("Lost the connection to the Airlock stream."); setRunning(false); es.close(); };
  }

  const last = attempts.at(-1);
  const blocked = attempts.filter((a) => a.blocked).length;
  const cached = attempts.filter((a) => a.from_cache).length;
  const held = done && done.payouts === 0 && done.blocked === done.attempted;

  return (
    <section className="panel airlock">
      <header>
        <b>Airlock</b>
        <span className="mono muted">{start ? `${start.live ? "LIVE" : "recorded run"} · ${start.contract_id} active · live window ${start.live_max_days} days (v${start.live_version})` : "replays the incident with the guardrail active"}</span>
      </header>
      {!approved && <p className="muted">Sign the guardrail first. Nothing activates without a human signature.</p>}
      {approved && (
        <div className="airlock-row">
          <button className="primary" onClick={run} disabled={running}>{running ? "Replaying…" : "Replay the incident through the Airlock"}</button>
          <span className="mono">{attempts.length}/{start?.requests ?? "?"} requests · {blocked} blocked · {done ? done.payouts : 0} paid</span>
        </div>
      )}
      {start && (
        <svg className="doors" viewBox="0 0 600 70" role="img" aria-label="Request passes the outer door, the guardrail contract is the inner door">
          <rect x="4" y="10" width="160" height="50" className="door" />
          <text x="84" y="40" textAnchor="middle" className="door-label">refund agent decides</text>
          <rect x="220" y="10" width="160" height="50" className={`door inner${last?.blocked ? " shut" : ""}`} />
          <text x="300" y="40" textAnchor="middle" className="door-label">{start.contract_id} (inner door)</text>
          <rect x="436" y="10" width="160" height="50" className="door" />
          <text x="516" y="40" textAnchor="middle" className="door-label">issue_refund pays</text>
          {last && <text x="192" y="66" textAnchor="middle" className="door-tag">{last.request_id}</text>}
        </svg>
      )}
      {last && <p className="mono muted">{last.request_id}: refund agent decided {last.decision} at {last.days_since_delivery} days{last.model ? ` (${last.model} via Nightshift${last.from_cache ? ", cache" : ""})` : ""} → {last.blocked ? "gate blocked" : "gate allowed"}</p>}
      {error && <p className="error">Airlock failed: {error}</p>}
      {held && start && (
        <div className="blocked-band" role="status">
          <span className="blocked-word">BLOCKED</span>
          <div className="mono">
            <p>{start.contract_id}: {attempts.find((a) => a.clause)?.clause}</p>
            <p><b>0 of {done.attempted} payouts executed.</b> The agent still decided "approve" {attempts.filter((a) => a.decision === "approve").length} times; the signed guardrail stopped every one.</p>
            <p>Signed by {start.signer} · hmac {start.signature.slice(0, 16)}… · replayed in a sealed transaction, nothing written{cached ? ` · ${cached} decisions served from Nightshift's cache` : ""}</p>
          </div>
        </div>
      )}
      {done && !held && <p className="error">Guardrail failed: {done.payouts} payouts executed, {done.blocked} of {done.attempted} blocked.</p>}
    </section>
  );
}
