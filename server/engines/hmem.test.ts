import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LedgerRow } from "../agents/investigate.ts";
import type { Evidence } from "../agents/witness.ts";
import type { Contract } from "../gate/contract.ts";
import { incidentMemory } from "./hmem.ts";

const contract = {
  id: "GC-0417-1", case_id: "BB-0417", clause: "issue_refund pays only within the live window.", approved_by: "On-call lead",
  approved_at: "2026-10-24T17:00:00.000Z", evidence: ["L2", "A1"],
} as Contract;
const ledger = [{ id: "L2", kind: "root-cause", status: "survives", claim: "The agent's prompt kept the 30-day policy." }] as LedgerRow[];
const evidence = [{ cell: "A1", sql: "SELECT version\nFROM SHOP_PG.policy_versions" }] as Evidence[];

describe("incident memory on H-MEM", () => {
  it("recalls a signed finding in a later session, with the ledger rows and queries behind it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-hmem-"));
    (await incidentMemory(dir)).remember({ contract, ledger, evidence });
    const recalled = (await incidentMemory(dir)).recall(); // a fresh instance reads what was persisted
    expect(recalled).toMatchObject({ case_id: "BB-0417", source: "black-box BB-0417", label: "BB-0417: guardrail GC-0417-1 signed" });
    expect(recalled!.content).toContain("kept the 30-day policy");
    expect(recalled!.refs).toEqual(["L2", "A1", "A1: SELECT version FROM SHOP_PG.policy_versions"]);
  });

  it("recalls nothing before any finding is signed", async () => {
    expect((await incidentMemory(fs.mkdtempSync(path.join(os.tmpdir(), "bb-hmem-")))).recall()).toBeUndefined();
  });
});
