import { describe, expect, it, vi } from "vitest";
import { createZetaris, ZetarisError } from "./zetaris.ts";

const opts = { url: "http://localhost:8888/api/v1.0/", apiKey: "k-test", orgId: "1" };

function fakeFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } }));
}

describe("zetaris client", () => {
  it("posts SQL to the SQL editor run route with auth and org headers", async () => {
    const fetch = fakeFetch(200, JSON.stringify({ data: [[1, "a"]] }));
    await createZetaris({ ...opts, fetch }).query("SELECT 1", 5);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8888/api/v1.0/sql-editor/sqls/run");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k-test");
    expect(headers["X-Org-ID"]).toBe("1");
    expect(JSON.parse(init.body as string)).toMatchObject({ sql: "SELECT 1", source: "SqlEditor", limit: 5 });
  });

  it("returns the rows from the data field", async () => {
    const z = createZetaris({ ...opts, fetch: fakeFetch(200, JSON.stringify({ data: [[40, "returned"]] })) });
    expect((await z.query("SELECT 1")).rows).toEqual([[40, "returned"]]);
  });

  it("treats a missing data field as no rows", async () => {
    const z = createZetaris({ ...opts, fetch: fakeFetch(200, "{}") });
    expect((await z.query("SELECT 1")).rows).toEqual([]);
  });

  it("surfaces the Zetaris message on an HTTP error", async () => {
    const z = createZetaris({ ...opts, fetch: fakeFetch(400, '{"message":"Table not found: orders"}') });
    await expect(z.query("SELECT * FROM orders")).rejects.toThrow(/HTTP 400.*Table not found: orders/);
  });

  it("names the host when Zetaris is unreachable", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(createZetaris({ ...opts, fetch }).query("SELECT 1")).rejects.toThrow(/Cannot reach http:\/\/localhost:8888/);
  });

  it("refuses to run without an API key", () => {
    expect(() => createZetaris({ ...opts, apiKey: "" })).toThrow(ZetarisError);
  });
});
