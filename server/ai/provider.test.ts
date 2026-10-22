import { describe, expect, it, vi } from "vitest";
import { createMeterless, MeterlessError, normalizeBaseUrl } from "./provider.ts";

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
    expect(out).toEqual({ text: "hi", model: "nvidia/nemotron" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer t-test");
    expect(h["meterless-app"]).toBe("black-box");
    expect(h["meterless-scope"]).toBe("user");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "meterless/auto", messages: [{ role: "user", content: "hello" }] });
  });

  it("names the runtime error on a failed chat", async () => {
    const fetch = vi.fn(async () => json(503, { error: "no lane" }));
    await expect(createMeterless({ ...base, fetch }).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/HTTP 503.*no lane/);
  });
});
