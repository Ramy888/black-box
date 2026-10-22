// Meterless Runtime provider (Nightshift), implementing the official POWER prompt
// "Add Meterless as a provider": OpenAI-compatible API, ids are routing modes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class MeterlessError extends Error {}

export type Role = "system" | "user" | "assistant";
export interface ChatMessage { role: Role; content: string }
export type RuntimeState = "online" | "unauthorized" | "offline";

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

  async function chat({ messages, model = "meterless/auto", maxTokens }: { messages: ChatMessage[]; model?: string; maxTokens?: number }) {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { ...headers, "meterless-scope": "user", "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new MeterlessError(`Cannot reach Meterless Runtime at ${base}: ${(err as Error).message}`);
      }
      const text = await res.text();
      if (res.ok) {
        const out = JSON.parse(text);
        return { text: String(out?.choices?.[0]?.message?.content ?? ""), model: String(out?.model ?? model) };
      }
      if (isRateLimited(res.status, text) && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new MeterlessError(`HTTP ${res.status}: ${text.slice(0, 500)}`);
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
