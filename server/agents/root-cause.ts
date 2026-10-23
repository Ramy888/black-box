// Root-Cause (RCA): Nemotron reasons over the witnesses' reports and names the root
// cause, citing grid cells. Nemotron always thinks before answering and the token
// budget is the only lever, so a reply that runs out of budget climbs the ladder.

import { BudgetExhausted, type ChatMessage, type ChatResult } from "../ai/provider.ts";
import type { Evidence } from "./witness.ts";

export interface Chat {
  chat(o: { messages: ChatMessage[]; model?: string; maxTokens?: number; stream?: boolean }): Promise<ChatResult>;
}

export interface Claim { kind: "root-cause" | "finding"; claim: string; cells: string[] }

export interface ModelCall {
  callsign: string; budget: number; stream: boolean; outcome: "ok" | "exhausted" | "invalid";
  receipt?: ChatResult["receipt"]; note?: string;
}

// Every rung streams: a non-streamed call that reasons past ~45 s is cut off by Nightshift's upstream timeout.
// Streamed receipts carry no token counts, so the meter shows the budget given, not the tokens used.
export const LADDER = [2048, 4096, 8192].map((maxTokens) => ({ maxTokens, stream: true }));

const SYSTEM = `You are RCA, the root-cause investigator for an AI agent incident: a refund agent paid refunds it should not have.
Witness findings are tagged with grid cells. Reply with exactly three lines and nothing else:
ROOT: <one sentence naming the root cause> [cells]
FINDING: <one sentence> [cells]
FINDING: <one sentence> [cells]
[cells] lists the grid cells whose findings prove that line, for example [A1, B1].`;

/** A reply the agent cannot use. Like running out of budget, it climbs the ladder for a fresh answer. */
export class InvalidReply extends Error {}

/**
 * Calls the model up the budget ladder until `parse` accepts a reply. Every attempt is
 * reported, so the budget meter shows what was spent and why it rose.
 */
export async function askWithLadder<T>(ai: Chat, callsign: string, messages: ChatMessage[], parse: (text: string) => T, onCall: (c: ModelCall) => void, ladder = LADDER): Promise<T> {
  for (const [i, rung] of ladder.entries()) {
    const call = { callsign, budget: rung.maxTokens, stream: rung.stream };
    try {
      const out = await ai.chat({ model: "meterless/fast", messages, ...rung });
      const value = parse(out.text);
      onCall({ ...call, outcome: "ok", receipt: out.receipt });
      return value;
    } catch (err) {
      const outcome = err instanceof BudgetExhausted ? "exhausted" : err instanceof InvalidReply ? "invalid" : undefined;
      if (!outcome) throw err;
      onCall({ ...call, outcome, note: (err as Error).message.slice(0, 300) });
      if (i === ladder.length - 1) throw err;
    }
  }
  throw new Error("unreachable");
}

const LINE = /^(ROOT|FINDING)\s*:\s*(.+?)\s*\[([^\]]*)\]\s*\.?$/i;

export function parseClaims(text: string, cells: Set<string>): Claim[] {
  const claims = text.split("\n")
    .map((l) => l.replace(/[*_`#>]+/g, " ").replace(/^\s*(?:[-•]|\d+[.)])\s*/, "").trim().match(LINE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m): Claim => ({
      kind: m[1].toUpperCase() === "ROOT" ? "root-cause" : "finding",
      claim: m[2].trim(),
      // A claim must cite at least one real cell: the cell's query is the claim's evidence.
      cells: m[3].split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter((c) => cells.has(c)),
    }))
    .filter((c) => c.claim && c.cells.length);
  if (!claims.some((c) => c.kind === "root-cause")) throw new InvalidReply(`no ROOT line citing a real cell in: ${text.slice(0, 200)}`);
  return claims;
}

export async function runRootCause(ai: Chat, evidence: Evidence[], onCall: (c: ModelCall) => void): Promise<Claim[]> {
  const cells = new Set(evidence.map((e) => e.cell));
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: evidence.map((e) => `[${e.cell}] ${e.report}`).join("\n") },
  ];
  return askWithLadder(ai, "RCA", messages, (text) => parseClaims(text, cells), onCall);
}
