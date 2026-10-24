// Agent recorder: a strip chart drawn from the investigation's own event stream. One
// column per callsign, one row per event (index-spaced). A pen trace runs while an agent
// works, dashed lines are handoffs, and a refutation is a red spike on the Skeptic's trace.

import type { InvestigationEvent } from "../../server/agents/investigate.ts";

export const RECORDER_CALLSIGNS = ["WIT·1", "WIT·2", "WIT·3", "RCA", "SKP", "REM"];
const W = 268, TOP = 22, STEP = 13;
const colW = W / RECORDER_CALLSIGNS.length;
const x = (c: string) => colW * RECORDER_CALLSIGNS.indexOf(c) + colW / 2;
const y = (i: number) => TOP + i * STEP + STEP / 2;

export function Recorder({ events }: { events: InvestigationEvent[] }) {
  const rows = events.filter((e) => e.type !== "mode" && e.type !== "ledger" && e.type !== "done" && e.type !== "error");
  const open = new Map<string, number>();
  const spans: { c: string; from: number; to: number }[] = [];
  rows.forEach((e, i) => {
    if (e.type !== "agent") return;
    if (e.state === "working") open.set(e.callsign, i);
    else if (open.has(e.callsign)) { spans.push({ c: e.callsign, from: open.get(e.callsign)!, to: i }); open.delete(e.callsign); }
  });
  for (const [c, from] of open) spans.push({ c, from, to: rows.length - 1 });
  const height = Math.max(TOP + rows.length * STEP + 8, 120);

  return (
    <svg className="recorder" viewBox={`0 0 ${W} ${height}`} width="100%" role="img"
      aria-label={`Agent recorder: ${rows.length} events across ${RECORDER_CALLSIGNS.join(", ")}`}>
      {RECORDER_CALLSIGNS.map((c) => (
        <g key={c}>
          <text x={x(c)} y={12} textAnchor="middle" className="rec-label">{c}</text>
          <line x1={x(c)} x2={x(c)} y1={TOP} y2={height - 4} className="rec-base" />
        </g>
      ))}
      {spans.map((s, i) => <line key={i} x1={x(s.c)} x2={x(s.c)} y1={y(s.from)} y2={y(s.to)} className="rec-trace" />)}
      {rows.map((e, i) => {
        const yy = y(i);
        if (e.type === "handoff") return <line key={i} x1={x(e.from)} x2={x(e.to)} y1={yy} y2={yy} className="rec-handoff" />;
        if (e.type === "evidence") return <rect key={i} x={x(e.evidence.by) - 4} y={yy - 4} width={8} height={8} className="rec-evidence" />;
        if (e.type === "model") {
          const w = 3 + (e.call.budget / 8192) * 9; // tick width tracks the thinking budget
          return <line key={i} x1={x(e.call.callsign) - w} x2={x(e.call.callsign) + w} y1={yy} y2={yy} className={`rec-tick ${e.call.outcome}`} />;
        }
        if (e.type === "verdict" && e.verdict.status === "struck") {
          const cx = x("SKP");
          return (
            <g key={i}>
              <path d={`M${cx - 14} ${yy} L${cx - 8} ${yy - 7} L${cx - 2} ${yy + 7} L${cx + 4} ${yy - 7} L${cx + 10} ${yy}`} className="rec-spike" />
              <text x={cx - 17} y={yy + 3} textAnchor="end" className="rec-refuted">refuted {e.verdict.id}</text>
            </g>
          );
        }
        if (e.type === "contract") return <rect key={i} x={x("REM") - 5} y={yy - 5} width={10} height={10} className="rec-contract" />;
        if (e.type === "verdict") return <circle key={i} cx={x("SKP")} cy={yy} r={3.5} className="rec-ok" />;
        return null;
      })}
    </svg>
  );
}
