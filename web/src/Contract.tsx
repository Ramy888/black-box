// Guardrail contract panel: REM's proposal, and the human "Approve and sign" step.
// Nothing activates until a person signs; the signature is an HMAC over the contract.

import { useState } from "react";
import type { Contract } from "../../server/gate/contract.ts";

export function ContractPanel({ proposal, approved, onApproved }: { proposal?: Contract; approved?: Contract; onApproved: (c: Contract) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shown = approved && (!proposal || approved.id === proposal.id) ? approved : proposal;
  if (!shown) return <p className="muted">REM proposes a guardrail once a root cause survives the Skeptic.</p>;
  const signed = Boolean(shown.signature);

  async function approve() {
    setBusy(true); setError(undefined);
    try {
      const r = await fetch(`/api/contract/${encodeURIComponent(shown!.id)}/approve`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onApproved(body.approved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="contract">
      <p className="mono"><b>{shown.id}</b> · proposed by {shown.proposed_by}</p>
      <p className="mono clause">{shown.clause}</p>
      <p className="mono muted">require {shown.rule.require}<br />from {shown.rule.live_source}</p>
      <p className="muted">{shown.context}</p>
      <p className="mono muted">evidence {shown.evidence.join(" ")}</p>
      {signed ? (
        <p className="mono signed">Signed by {shown.approved_by}<br />{shown.approved_at?.replace("T", " ").slice(0, 19)}Z<br />hmac {shown.signature?.slice(0, 16)}…</p>
      ) : (
        <button className="primary stamp" onClick={approve} disabled={busy}>{busy ? "Signing…" : "Approve and sign"}</button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
