// Flight recorder: the incident replayed from the World Model event log. One tick per
// event, spaced by order (not wall time, or 15 minutes of payouts would be a sliver
// next to a 3-day-old policy change); the orange playhead is the only orange.

import { useEffect, useRef, useState } from "react";
import type { FlightEvent } from "../../server/engines/world-model.ts";

interface Flight { engine: string; runId: string; policyAtIncident: number; bad: number; events: FlightEvent[] }

const TICK = { policy: 0.9, ticket: 0.7, decision: 0.45, bad: 0.62 } as const;

export function Timeline() {
  const [flight, setFlight] = useState<Flight>();
  const [error, setError] = useState<string>();
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number>();

  useEffect(() => {
    fetch("/api/flight")
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`); return body; })
      .then((f: Flight) => { setFlight(f); setAt(f.events.length - 1); })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!playing || !flight) return;
    timer.current = window.setInterval(() => setAt((i) => {
      if (i >= flight.events.length - 1) { setPlaying(false); return i; }
      return i + 1;
    }), 60);
    return () => window.clearInterval(timer.current);
  }, [playing, flight]);

  if (error) return <section className="panel"><header><b>Flight recorder</b></header><p className="error">Replay failed: {error}</p></section>;
  if (!flight) return <section className="panel"><header><b>Flight recorder</b><span className="mono muted">loading</span></header></section>;

  const n = flight.events.length;
  const cur = flight.events[at];
  const badSoFar = flight.events.slice(0, at + 1).filter((e) => e.bad).length;
  const x = (i: number) => ((i + 0.5) / n) * 1000;

  return (
    <section className="panel">
      <header>
        <b>Flight recorder</b>
        <span className="mono muted">REC · {flight.runId} · {n} events · {flight.engine}</span>
      </header>
      <svg className="strip" viewBox="0 0 1000 120" preserveAspectRatio="none" role="img"
        aria-label={`${n} recorded events, ${flight.bad} refunds paid outside the live policy`}>
        {flight.events.map((e, i) => (
          <line key={e.seq} x1={x(i)} x2={x(i)} y1={120} y2={120 - 110 * TICK[e.bad ? "bad" : e.kind]}
            className={e.bad ? "tick bad" : `tick ${e.kind}`} opacity={i <= at ? 1 : 0.35} />
        ))}
        <line className="playhead" x1={x(at)} x2={x(at)} y1={0} y2={120} />
      </svg>
      <div className="scrub">
        <button className="primary" onClick={() => { if (at >= n - 1) setAt(0); setPlaying((p) => !p); }}>
          {playing ? "Pause" : "Replay"}
        </button>
        <input type="range" min={0} max={n - 1} value={at} aria-label="Scrub the flight recorder"
          onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} />
        <span className="mono">{String(at + 1).padStart(3, "0")}/{n}</span>
      </div>
      <dl className={cur.bad ? "readout bad" : "readout"}>
        <dt className="mono">{cur.at.replace("T", " ").slice(0, 19)}Z · {cur.id}</dt>
        <dd><b>{cur.label}</b></dd>
        <dd className="muted">{cur.detail}</dd>
        {cur.bad && <dd className="error">Out of policy: the live window at the incident was {flight.policyAtIncident} days.</dd>}
      </dl>
      <p className="mono muted">Out-of-policy payouts so far: <span className="count">{badSoFar}</span> of {flight.bad}</p>
    </section>
  );
}
