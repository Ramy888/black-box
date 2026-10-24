import { describe, expect, it, vi } from "vitest";
import { BudgetExhausted, createMeterless, MeterlessError, normalizeBaseUrl } from "./provider.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normalizeBaseUrl", () => {
  it.each([
    ["127.0.0.1:8088", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1"],
    ["http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1"],
    ["http://localhost:8088/v1/models", "http://localhost:8088/v1"],
    ["http://localhost:8088/healthz", "http://localhost:8088/v1"],
    ["http://localhost:8088/v1/v1", "http://localhost:8088/v1"],
  ])("%s -> %s", (input, out) => expect(normalizeBaseUrl(input)).toBe(out));
});

describe("meterless provider", () => {
  const base = { baseUrl: "http://127.0.0.1:8088", token: "t-test" };

  it("rejects the rt-local placeholder token", () => {
    expect(() => createMeterless({ ...base, token: "rt-local" })).toThrow(MeterlessError);
  });

  it("reports online with the meterless routing ids", async () => {
    const fetch = vi.fn(async () => json(200, { data: [{ id: "meterless/auto" }, { id: "webllm/x" }] }));
    expect(await createMeterless({ ...base, fetch }).status()).toEqual({ state: "online", models: ["meterless/auto", "webllm/x"] });
  });

  it("reports unauthorized, not offline, on 401", async () => {
    const fetch = vi.fn(async () => json(401, { error: "nope" }));
    expect((await createMeterless({ ...base, fetch }).status()).state).toBe("unauthorized");
  });

  it("reports offline when the runtime is unreachable", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect((await createMeterless({ ...base, fetch }).status()).state).toBe("offline");
  });

  it("sends auth, app and scope headers and returns the reply text", async () => {
    const fetch = vi.fn(async () => json(200, { model: "nvidia/nemotron", choices: [{ message: { content: "hi" } }] }));
    const out = await createMeterless({ ...base, fetch }).chat({ messages: [{ role: "user", content: "hello" }] });
    expect(out).toMatchObject({ text: "hi", model: "nvidia/nemotron" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer t-test");
    expect(h["meterless-app"]).toBe("black-box");
    expect(h["meterless-scope"]).toBe("user");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "meterless/auto", messages: [{ role: "user", content: "hello" }] });
  });

  it("retries a rate-limited chat with backoff, then succeeds", async () => {
    const replies = [
      json(502, { error: { meterless_detail: 'nvidia_429: {"status":429}' } }),
      json(429, { error: "slow down" }),
      json(200, { model: "nvidia/nemotron", choices: [{ message: { content: "ok" } }] }),
    ];
    const fetch = vi.fn(async () => replies.shift()!);
    const sleep = vi.fn(async (_ms: number) => {});
    const out = await createMeterless({ ...base, fetch, sleep }).chat({ messages: [{ role: "user", content: "x" }] });
    expect(out.text).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it("gives up after the last rate-limited attempt", async () => {
    const fetch = vi.fn(async () => json(429, { error: "slow down" }));
    const ai = createMeterless({ ...base, fetch, sleep: async () => {} });
    await expect(ai.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/HTTP 429/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("names the runtime error on a failed chat", async () => {
    const fetch = vi.fn(async () => json(503, { error: "no lane" }));
    await expect(createMeterless({ ...base, fetch }).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/HTTP 503.*no lane/);
  });

  it("returns the compute receipt: routed model, tokens, cache", async () => {
    const fetch = vi.fn(async () => json(200, {
      model: "nvidia/nemotron", choices: [{ message: { content: "ok" } }],
      meterless: { routed_model: "nvidia/nemotron", from_cache: true, cache: { status: "exact" }, cost: { actual_usd: 0 }, phases: [{ tokensOut: 812, outputTps: 86.4 }] },
    }));
    const { receipt } = await createMeterless({ ...base, fetch }).chat({ messages: [{ role: "user", content: "x" }] });
    expect(receipt).toMatchObject({ routed_model: "nvidia/nemotron", from_cache: true, cache_status: "exact", tokens_out: 812, tokens_per_s: 86, cost_usd: 0 });
  });

  it.each([
    [502, { error: { meterless_detail: "nvidia/nemotron-3.5_empty_response" } }],
    [499, { error: { code: "request_aborted" } }],
  ])("types a %s run-out-of-budget reply as BudgetExhausted", async (status, body) => {
    const fetch = vi.fn(async () => json(status, body));
    await expect(createMeterless({ ...base, fetch }).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(BudgetExhausted);
  });

  const sse = (...chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });

  it("collects a streamed reply and its receipt", async () => {
    const fetch = vi.fn(async () => sse(
      { model: "meterless/auto", choices: [{ delta: { content: "Hel" } }] },
      { model: "nvidia/nemotron", choices: [{ delta: { content: "lo" } }] },
      { model: "nvidia/nemotron", meterless: { routed_model: "nvidia/nemotron", from_cache: false } },
    ));
    const out = await createMeterless({ ...base, fetch }).chat({ messages: [{ role: "user", content: "x" }], stream: true, maxTokens: 4096 });
    expect(out).toMatchObject({ text: "Hello", model: "nvidia/nemotron", receipt: { from_cache: false, tokens_out: null } });
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ stream: true, max_tokens: 4096 });
  });

  it("types an empty or errored stream as BudgetExhausted", async () => {
    const ai = (r: () => Response) => createMeterless({ ...base, fetch: vi.fn(async () => r()) });
    const msg = { messages: [{ role: "user" as const, content: "x" }], stream: true };
    await expect(ai(() => sse({ error: { message: "/nemotron_empty_response" } })).chat(msg)).rejects.toBeInstanceOf(BudgetExhausted);
    await expect(ai(() => sse({ error: { code: "request_aborted" } })).chat(msg)).rejects.toBeInstanceOf(BudgetExhausted);
    await expect(ai(() => sse({ model: "nvidia/nemotron", choices: [{ delta: {} }] })).chat(msg)).rejects.toBeInstanceOf(BudgetExhausted);
  });
});
