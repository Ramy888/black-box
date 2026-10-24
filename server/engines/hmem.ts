// Incident memory on the Meterless H-MEM engine. When a human signs a guardrail, the
// finding is remembered with its provenance (ledger rows, evidence cells, the Zetaris
// queries behind them); the next investigation recalls it before the witnesses report.

import path from "node:path";
import type { LedgerRow } from "../agents/investigate.ts";
import type { Evidence } from "../agents/witness.ts";
import type { Contract } from "../gate/contract.ts";
import { loadEngine } from "./load.ts";

export interface Recalled { case_id: string; content: string; relevance: number; label: string; refs: string[]; source: string }

export const MEMORY_DIR = path.join(import.meta.dirname, "..", "..", "data", "runtime", "hmem");
// What a refund-agent incident looks like when it starts; the recall query, not a model prompt.
export const REFUND_INCIDENT_QUERY = "refund agent paid refunds outside the live return window policy";

export async function incidentMemory(dir = MEMORY_DIR) {
  const { mod } = await loadEngine("hmem");
  const mem = new mod.HMEM({ persistDir: dir, actor: "black-box" });
  return {
    remember({ contract, ledger, evidence }: { contract: Contract; ledger: LedgerRow[]; evidence: Evidence[] }) {
      const root = ledger.find((r) => r.kind === "root-cause" && r.status === "survives");
      const cited = evidence.filter((e) => contract.evidence.includes(e.cell));
      return mem.add({
        content: `Case ${contract.case_id}: refund agent paid refunds outside the live return window policy. Root cause: ${root?.claim ?? "unknown"} Guardrail ${contract.id} signed by ${contract.approved_by}: ${contract.clause}`,
        type: "factual", layer: "long_term", confidence: 0.9,
        tags: ["incident", "refund-agent", "policy-drift", contract.case_id],
        source: `black-box ${contract.case_id}`,
        provenance: {
          origin: "plan_completion", learnedAt: Date.parse(contract.approved_at ?? new Date().toISOString()),
          label: `${contract.case_id}: guardrail ${contract.id} signed`,
          refs: [...contract.evidence, ...cited.map((e) => `${e.cell}: ${e.sql.replace(/\s+/g, " ")}`)],
        },
      });
    },
    recall(query = REFUND_INCIDENT_QUERY): Recalled | undefined {
      const hit = mem.query(query, { topN: 1 }).memories[0];
      if (!hit) return undefined;
      const m = hit.memory;
      return { case_id: m.tags.find((t: string) => t.startsWith("BB-")) ?? "", content: m.content, relevance: Math.round(hit.relevance * 100) / 100, label: m.provenance.label, refs: m.provenance.refs ?? [], source: m.source };
    },
  };
}
