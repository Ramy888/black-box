// Resets the incident, runs the refund agent for real through Nightshift, then ships
// its traces to Zetaris as a JSON source. Run: npm run culprit
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { meterlessFromEnv } from "../server/ai/provider.ts";
import { runRefundAgent } from "../server/culprit/agent.ts";
import { zetarisFromEnv } from "../server/data/zetaris.ts";
import { INCIDENT_AT } from "./generate.ts";
import { shipToZetaris, shopPool, zx } from "./load.ts";

try { process.loadEnvFile(".env"); } catch {}
const db = shopPool();
try {
  await db.query("TRUNCATE refunds, tool_calls");
  const runId = "run-0417";
  let done = 0;
  const traces = await runRefundAgent({
    db, ai: meterlessFromEnv(), runId, now: INCIDENT_AT,
    onTrace: (t) => process.stdout.write(`\r${++done} decisions (${t.request_id} ${t.decision} via ${t.routed_model})   `),
  });
  console.log();
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bb-")), "agent_traces.json");
  // A JSON array, not JSON lines: Zetaris's JSON filestore reads only the first object of a JSON-lines file.
  fs.writeFileSync(tmp, JSON.stringify(traces, null, 1) + "\n");
  const tracesPath = shipToZetaris(tmp, "agent_traces.json");
  await zx("DROP LIGHTNING DATABASE TABLE BB_FILES.agent_traces").catch(() => {});
  await zx(`CREATE LIGHTNING FILESTORE TABLE agent_traces FROM BB_FILES FORMAT JSON OPTIONS (PATH "${tracesPath}", inferSchema "true", multiLine "true")`);
  const approved = traces.filter((t) => t.decision === "approve").length;
  console.log(`refund agent: ${traces.length} decisions, ${approved} refunds paid`);
  const { rows } = await zetarisFromEnv().query(`SELECT count(*) FROM SHOP_PG.refunds f JOIN SHOP_PG.orders o ON o.id = f.order_id
    JOIN SHOP_PG.policy_versions p ON p.valid_to IS NULL JOIN BB_FILES.agent_traces t ON t.request_id = f.request_id
    WHERE datediff(timestamp '${INCIDENT_AT.toISOString().slice(0, 19).replace("T", " ")}', o.delivered_at) > p.max_return_days`);
  console.log(`zetaris (Postgres + JSON traces): ${rows[0][0]} refunds paid outside the live policy`);
} finally {
  await db.end();
}
