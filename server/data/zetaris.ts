// Zetaris REST client. Mirrors the official contract in zetaris/getting-started
// (scripts/zetaris_sql.py RestChannel): POST {base}/sql-editor/sqls/run, rows in `data`.

export class ZetarisError extends Error {}

export type Row = unknown[];

export interface ZetarisOptions {
  url: string;
  apiKey: string;
  orgId?: string;
  fetch?: typeof globalThis.fetch;
}

export function createZetaris({ url, apiKey, orgId = "1", fetch = globalThis.fetch }: ZetarisOptions) {
  if (!apiKey) throw new ZetarisError("ZETARIS_API_KEY is empty. Create a key in the Zetaris web UI and put it in .env.");
  const base = url.replace(/\/$/, "");

  async function query(sql: string, limit = 1000): Promise<{ rows: Row[] }> {
    let res: Response;
    try {
      res = await fetch(`${base}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Org-ID": orgId,
          "X-Request-ID": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: crypto.randomUUID(), sql, source: "SqlEditor", limit }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ZetarisError(`Cannot reach ${base}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new ZetarisError(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    const out = text ? JSON.parse(text) : null;
    return { rows: Array.isArray(out?.data) ? out.data : [] };
  }

  return { query };
}

export function zetarisFromEnv(env = process.env) {
  return createZetaris({
    url: env.ZETARIS_API_URL ?? "http://localhost:8888/api/v1.0",
    apiKey: env.ZETARIS_API_KEY ?? "",
    orgId: env.ZETARIS_ORG_ID ?? "1",
  });
}
