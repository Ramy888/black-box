// The Counterpart (CNT): a customer-success VP cross-examines the finding before anyone
// signs a guardrail. CNT asks pointed questions about specific ledger rows; RCA answers,
// and an answer that cites no real ledger row or evidence cell marks that claim weak.

import type { ChatMessage } from "../ai/provider.ts";
import type { LedgerRow } from "./investigate.ts";
import { askWithLadder, InvalidReply, type Chat, type ModelCall } from "./root-cause.ts";
import type { Evidence } from "./witness.ts";

export interface Exchange { target: string; question: string; answer: string; cites: string[]; weak: boolean }

export type CrossExamEvent =
  | { type: "mode"; mode: "live" | "replay"; reason?: string }
  | { type: "model"; call: ModelCall }
  | { type: "exchange"; exchange: Exchange }
  | { type: "crossexam-done"; asked: number; weak: string[] }
  | { type: "crossexam-error"; message: string };

const ASK = `You are CNT, VP of Customer Success, cross-examining an incident finding before a guardrail is signed.
You care about customers who were refunded and customers who will be refused. Ask the questions a sceptical executive would ask.
Reply with 2 or 3 lines and nothing else, one question per line, each aimed at one ledger row:
Q [L2]: <one question>`;

const ANSWER = `You are RCA, answering a cross-examination. Answer only from the ledger and evidence given.
Reply with one line and nothing else:
A: <one or two sentences> [cites]
[cites] lists the ledger rows and evidence cells your answer relies on, for example [L3, A2]. If the evidence does not answer the question, say so and cite nothing: [].`;

export function parseQuestions(text: string, rows: Set<string>): { target: string; question: string }[] {
  const qs = text.split("\n")
    .map((l) => l.replace(/[*_`#>]+/g, " ").trim().match(/^Q\s*\[\s*(L\d+)\s*\]\s*:?\s*(.+)$/i))
    .filter((m): m is RegExpMatchArray => m !== null && rows.has(m[1].toUpperCase()))
    .map((m) => ({ target: m[1].toUpperCase(), question: m[2].trim() }))
    .slice(0, 3);
  if (!qs.length) throw new InvalidReply(`no "Q [L#]:" lines aimed at a surviving claim in: ${text.slice(0, 200)}`);
  return qs;
}

export function parseAnswer(text: string, valid: Set<string>): { answer: string; cites: string[] } {
  const m = text.replace(/[*_`#>]+/g, " ").match(/A\s*:\s*(.+?)\s*\[([^\]]*)\]\s*\.?\s*$/ims);
  if (!m) throw new InvalidReply(`no "A: ... [cites]" line in: ${text.slice(0, 200)}`);
  return { answer: m[1].trim(), cites: m[2].split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter((c) => valid.has(c)) };
}

export async function crossExamine({ ai, ledger, evidence, onCall, onExchange }: {
  ai: Chat; ledger: LedgerRow[]; evidence: Evidence[]; onCall: (c: ModelCall) => void; onExchange: (x: Exchange) => void;
}): Promise<Exchange[]> {
  const standing = ledger.filter((r) => r.status === "survives");
  const ledgerText = standing.map((r) => `[${r.id}] ${r.claim} (cells ${r.cells.join(", ")})`).join("\n");
  const asked = await askWithLadder(ai, "CNT", [{ role: "system", content: ASK }, { role: "user", content: `Ledger:\n${ledgerText}` }],
    (text) => parseQuestions(text, new Set(standing.map((r) => r.id))), onCall);

  const valid = new Set([...standing.map((r) => r.id), ...evidence.map((e) => e.cell)]);
  const out: Exchange[] = [];
  for (const q of asked) {
    // Only the questioned claim's own evidence: a smaller prompt keeps Nemotron's reasoning inside Nightshift's time limit.
    const cited = new Set(standing.find((r) => r.id === q.target)!.cells);
    const messages: ChatMessage[] = [
      { role: "system", content: ANSWER },
      { role: "user", content: `Ledger:\n${ledgerText}\nEvidence:\n${evidence.filter((e) => cited.has(e.cell)).map((e) => `[${e.cell}] ${e.report}`).join("\n")}\nQuestion about ${q.target}: ${q.question}` },
    ];
    const a = await askWithLadder(ai, "RCA", messages, (text) => parseAnswer(text, valid), onCall);
    // An answer with no real citation leaves the claim it was aimed at unsupported under questioning.
    const x: Exchange = { ...q, ...a, weak: a.cites.length === 0 };
    out.push(x);
    onExchange(x);
  }
  return out;
}
