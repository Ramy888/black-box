// The Remediator (REM): compiles the root cause that survived the Skeptic into a
// guardrail contract. No model call: a guardrail has to be exact, so the rule is fixed
// code and the evidence is the surviving ledger rows. The live window is named by its
// source, so the gate reads it when it checks and the contract cannot go stale.

import type { Contract } from "../gate/contract.ts";
import type { LedgerRow } from "./investigate.ts";
import type { Evidence } from "./witness.ts";

export function proposeGuardrail(ledger: LedgerRow[], evidence: Evidence[], caseId = "BB-0417", at = new Date()): Contract | undefined {
  const root = ledger.find((r) => r.kind === "root-cause" && r.status === "survives");
  if (!root) return undefined;
  const live = evidence.find((e) => e.cell === "A1")?.rows.find((r) => r[3] == null);
  const survivors = ledger.filter((r) => r.by === "RCA" && r.status === "survives");
  return {
    id: `GC-${caseId.split("-").pop()}-1`, case_id: caseId, proposed_by: "REM", proposed_at: at.toISOString(),
    clause: "issue_refund pays only when the days since delivery are within max_return_days of the live refund policy.",
    rule: { tool: "issue_refund", require: "days_since_delivery <= live_policy.max_return_days", live_source: "SHOP_PG.policy_versions WHERE valid_to IS NULL" },
    context: `${live ? `Live policy at proposal: v${live[0]}, ${live[1]} days. ` : ""}Root cause ${root.id}: ${root.claim}`,
    evidence: [...survivors.map((r) => r.id), ...new Set(survivors.flatMap((r) => r.cells))],
  };
}
