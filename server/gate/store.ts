// Signed guardrails are World Model events: every approval is an upsert on the contract
// entity, persisted to data/runtime/.world (gitignored), so the gate survives a restart.

import path from "node:path";
import { loadEngine } from "../engines/load.ts";
import type { Contract } from "./contract.ts";

export async function guardrailStore(dir = path.join(import.meta.dirname, "..", "..", "data", "runtime")) {
  const { mod } = await loadEngine("world-model");
  const wm = new mod.WorldModel({ namespace: "guardrails", storage: "local", directory: dir });
  return {
    async record(c: Contract) {
      await wm.upsertEntity({
        type: "contract", externalKey: { system: "blackbox", id: c.id },
        attrs: { status: "approved", contract: JSON.stringify(c) },
        source: { kind: "manual", by: c.approved_by, at: c.approved_at },
      });
    },
    /** The most recently approved contract, if a human has signed one. */
    latest(): Contract | undefined {
      const all: Contract[] = wm.view("graph").query({ type: "contract" }).map((e: any) => JSON.parse(e.attrs.contract));
      return all.sort((a, b) => String(a.approved_at).localeCompare(String(b.approved_at))).at(-1);
    },
  };
}
