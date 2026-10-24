import { describe, expect, it } from "vitest";
import type { ChatResult } from "../ai/provider.ts";
import { crossExamine, parseAnswer, parseQuestions } from "./counterpart.ts";
import type { LedgerRow } from "./investigate.ts";
import { InvalidReply } from "./root-cause.ts";
import type { Evidence } from "./witness.ts";

const row = (id: string, status: LedgerRow["status"], cells: string[]): LedgerRow =>
  ({ id, kind: "finding", by: "RCA", claim: `claim ${id}`, cells, sql: [], sources: [], rows: 1, status });
const ledger = [row("L1", "struck", ["C1"]), row("L2", "survives", ["A1", "B1"]), row("L3", "survives", ["A2"])];
const evidence = ["A1", "A2", "B1", "C1"].map((cell) => ({ cell, report: `report ${cell}` }) as Evidence);
const ok = (text: string): ChatResult => ({ text, model: "nvidia/nemotron", receipt: { routed_model: "nvidia/nemotron", from_cache: false, cache_status: null, tokens_out: null, tokens_per_s: null, cost_usd: null, ms: 1 } });

describe("Counterpart cross-examination", () => {
  it("marks a claim weak when RCA's answer cites nothing real, and keeps it when it does", async () => {
    const replies = [
      "**Q [L2]:** Were any customers refused who should have been paid?\nQ [L3]: Is 69,422 EGP the full exposure?\nQ [L1]: about the struck rumour",
      "A: Every out-of-window payout is in A2; refusals were inside the old window. [L3, A2]",
      "A: The evidence does not show total exposure beyond these refunds. [Z9]",
    ];
    const exchanges = await crossExamine({ ai: { chat: async () => ok(replies.shift()!) }, ledger, evidence, onCall: () => {}, onExchange: () => {} });
    expect(exchanges.map((x) => [x.target, x.cites, x.weak])).toEqual([["L2", ["L3", "A2"], false], ["L3", [], true]]);
  });

  it("only questions surviving claims", () => {
    expect(parseQuestions("Q [L1]: rumour?\nQ [L3]: exposure?", new Set(["L2", "L3"]))).toEqual([{ target: "L3", question: "exposure?" }]);
    expect(() => parseQuestions("What about it?", new Set(["L2"]))).toThrow(InvalidReply);
  });

  it("rejects an answer with no citation brackets", () => {
    expect(() => parseAnswer("A: trust me", new Set(["A2"]))).toThrow(InvalidReply);
  });
});
