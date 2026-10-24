// Meterless Runtime provider (Nightshift), implementing the official POWER prompt
// "Add Meterless as a provider": OpenAI-compatible API, ids are routing modes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class MeterlessError extends Error {}
/** Nemotron spent its whole token budget reasoning (empty reply) or ran past Nightshift's upstream timeout. */
export class BudgetExhausted extends MeterlessError {}

export type Role = "system" | "user" | "assistant";
export interface ChatMessage { role: Role; content: string }
export type RuntimeState = "online" | "unauthorized" | "offline";

/** The parts of Meterless's compute receipt we show. Streamed replies carry no phases, so their token fields are null. */
export interface Receipt {
  routed_model: string; from_cache: boolean; cache_status: string | null;
  tokens_out: number | null; tokens_per_s: number | null; cost_usd: number | null; ms: number;
}
export interface ChatResult { text: string; model: string; receipt: Receipt }

const APP_ID = "black-box";
const TIMEOUT_MS = 180_000; // model loads can take minutes

export function normalizeBaseUrl(input: string): string {
  const withScheme = /^https?:\/\//.test(input) ? input : `http://${input}`;
  return `${new URL(withScheme).origin}/v1`;
}

export interface MeterlessOptions {
  baseUrl?: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];
// NVIDIA's free endpoint rate-limits; Nightshift passes that through as 429 or as 502 "nvidia_429".
const isRateLimited = (status: number, body: string) => status === 429 || /_429\b|"status":\s*429/.test(body);
// Nemotron always reasons first: an empty reply means max_tokens ran out mid-thought; 499 / request_aborted is
// Nightshift cutting off a call that reasoned too long (~45 s non-streamed, longer when streamed).
const isBudgetExhausted = (status: number, body: string) => status === 499 || /_empty_response|request_aborted/.test(body);

function toReceipt(m: any, model: string, ms: number): Receipt {
  const phase = m?.phases?.[0];
  return {
    routed_model: String(m?.routed_model ?? model), from_cache: Boolean(m?.from_cache), cache_status: m?.cache?.status ?? null,
    tokens_out: phase?.tokensOut ?? null, tokens_per_s: phase?.outputTps ? Math.round(phase.outputTps) : null,
    cost_usd: m?.cost?.actual_usd ?? null, ms,
  };
}

/** Collects an SSE chat stream into one reply. Streaming keeps long reasoning alive past Nightshift's non-streamed timeout. */
function readStream(text: string, model: string, ms: number): ChatResult {
  let content = "", routed = model, meta: any, error: any;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const j = JSON.parse(line.slice(6));
    content += j.choices?.[0]?.delta?.content ?? "";
    if (j.model && j.model !== "meterless/auto") routed = j.model;
    meta = j.meterless ?? meta;
    error = j.error ?? error;
  }
  if (error) throw new (isBudgetExhausted(0, JSON.stringify(error)) ? BudgetExhausted : MeterlessError)(`stream error: ${JSON.stringify(error).slice(0, 300)}`);
  if (!content) throw new BudgetExhausted("stream ended with no reply");
  return { text: content, model: routed, receipt: toReceipt(meta, routed, ms) };
}

export function createMeterless({ baseUrl = "http://127.0.0.1:8088", token, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: MeterlessOptions) {
  if (!token || token === "rt-local") {
    throw new MeterlessError("Meterless Runtime token missing. Set METERLESS_RUNTIME_TOKEN or METERLESS_TOKEN_FILE (Nightshift's runtime-token).");
  }
  const base = normalizeBaseUrl(baseUrl);
  const headers = { Authorization: `Bearer ${token}`, "meterless-app": APP_ID };

  async function status(): Promise<{ state: RuntimeState; models: string[] }> {
    let res: Response;
    try {
      res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
    } catch {
      return { state: "offline", models: [] };
    }
    if (res.status === 401 || res.status === 403) return { state: "unauthorized", models: [] };
    if (!res.ok) return { state: "offline", models: [] };
    const ids: string[] = ((await res.json())?.data ?? []).map((m: { id: string }) => m.id);
    return { state: ids.some((id) => id.startsWith("meterless/")) ? "online" : "offline", models: ids };
  }

  async function chat({ messages, model = "meterless/auto", maxTokens, stream = false }: { messages: ChatMessage[]; model?: string; maxTokens?: number; stream?: boolean }): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { ...headers, "meterless-scope": "user", "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(stream ? { stream: true } : {}) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new MeterlessError(`Cannot reach Meterless Runtime at ${base}: ${(err as Error).message}`);
      }
      const text = await res.text();
      if (res.ok && stream) return readStream(text, model, Date.now() - started);
      if (res.ok) {
        const out = JSON.parse(text);
        const routed = String(out?.model ?? model);
        return { text: String(out?.choices?.[0]?.message?.content ?? ""), model: routed, receipt: toReceipt(out?.meterless, routed, Date.now() - started) };
      }
      if (isRateLimited(res.status, text) && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new (isBudgetExhausted(res.status, text) ? BudgetExhausted : MeterlessError)(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  return { status, chat, baseUrl: base };
}

const DEFAULT_TOKEN_FILE = path.join(os.homedir(), "Library", "Application Support", "ai.meterless.nightshift.m1m4", "runtime-token");

export function meterlessFromEnv(env = process.env) {
  const file = env.METERLESS_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const token = env.METERLESS_RUNTIME_TOKEN || (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
  return createMeterless({ baseUrl: env.METERLESS_BASE_URL || undefined, token });
}
