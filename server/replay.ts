// Recordings for reproducible judging: a live run records every Zetaris answer and every
// Nightshift reply (failures too); replay mode serves them back, labelled, so the demo
// runs without Nightshift or Zetaris and takes the same path the live run took.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BudgetExhausted, MeterlessError, type ChatResult } from "./ai/provider.ts";
import type { Chat } from "./agents/root-cause.ts";
import type { Query } from "./agents/witness.ts";

type Outcome = { ok: true; value: unknown; ms: number } | { ok: false; error: { name: string; message: string }; ms: number };

const keyOf = (kind: string, input: unknown) => `${kind}:${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;

export function recording(file: string) {
  const tape: Record<string, Outcome> = {};
  const rec = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const value = await run();
      tape[key] = { ok: true, value, ms: Date.now() - started };
      return value;
    } catch (err) {
      tape[key] = { ok: false, error: { name: (err as Error).constructor.name, message: (err as Error).message }, ms: Date.now() - started };
      throw err;
    }
  };
  return {
    query: (live: Query): Query => (sql) => rec(keyOf("sql", sql), () => live(sql)),
    ai: (live: Chat): Chat => ({ chat: (o) => rec(keyOf("chat", o), () => live.chat(o)) }),
    save() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tape, null, 1) + "\n");
    },
  };
}

/** Serves a recording. `pace` scales the recorded latency so the UI still streams; 0 replays instantly. */
export function replaying(file: string, pace = 0.25) {
  if (!fs.existsSync(file)) throw new Error(`No recording at ${file}. Run one live investigation first.`);
  const tape: Record<string, Outcome> = JSON.parse(fs.readFileSync(file, "utf8"));
  const play = async <T>(key: string, what: string): Promise<T> => {
    const o = tape[key];
    if (!o) throw new Error(`Replay has no recording for this ${what}; the recording is from a different run.`);
    if (pace) await new Promise((r) => setTimeout(r, Math.min(o.ms * pace, 2500)));
    if (o.ok) return o.value as T;
    throw new (o.error.name === "BudgetExhausted" ? BudgetExhausted : MeterlessError)(o.error.message);
  };
  return {
    query: ((sql) => play(keyOf("sql", sql), "query")) as Query,
    ai: { chat: (o) => play<ChatResult>(keyOf("chat", o), "model call") } as Chat,
  };
}
