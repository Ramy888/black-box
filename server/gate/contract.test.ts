import { describe, expect, it } from "vitest";
import { activateGate, ContractInvalid, signContract, verifyContract, type Contract } from "./contract.ts";

const KEY = "test-key";
const proposal: Contract = {
  id: "GC-0417-1", case_id: "BB-0417", proposed_by: "REM", proposed_at: "2026-10-24T10:00:00.000Z",
  clause: "issue_refund pays only when days since delivery <= the live policy's max_return_days.",
  rule: { tool: "issue_refund", require: "days_since_delivery <= live_policy.max_return_days", live_source: "SHOP_PG.policy_versions WHERE valid_to IS NULL" },
  context: "Live policy v2, 14 days.", evidence: ["L2", "A1"],
};
const signed = () => signContract(proposal, KEY, "On-call lead", new Date("2026-10-24T10:05:00Z"));

describe("guardrail contract", () => {
  it("verifies a signed contract and records who signed it", async () => {
    const c = await signed();
    expect(c).toMatchObject({ approved_by: "On-call lead", approved_at: "2026-10-24T10:05:00.000Z" });
    expect(await verifyContract(c, KEY)).toBe(true);
  });

  it("rejects an unsigned contract, a wrong key, and a single changed character", async () => {
    const c = await signed();
    expect(await verifyContract(proposal, KEY)).toBe(false);
    expect(await verifyContract(c, "other-key")).toBe(false);
    expect(await verifyContract({ ...c, clause: c.clause.replace("<=", "< ") }, KEY)).toBe(false);
    expect(await verifyContract({ ...c, approved_by: "Someone else" }, KEY)).toBe(false);
  });

  it("will not activate on an altered contract", async () => {
    const c = await signed();
    await expect(activateGate({ ...c, evidence: ["L9"] }, KEY, 14)).rejects.toBeInstanceOf(ContractInvalid);
  });

  it("allows refunds inside the live window and blocks the rest with the clause", async () => {
    const gate = await activateGate(await signed(), KEY, 14);
    expect(gate({ days_since_delivery: 14 })).toEqual({ allow: true, contract_id: "GC-0417-1" });
    expect(gate({ days_since_delivery: 15 })).toEqual({ allow: false, contract_id: "GC-0417-1", clause: proposal.clause });
  });
});
