// Proves the investigation end to end: at least 3 RCA claims plus the reported false lead,
// and every claim's Zetaris query re-runs to the same rows. `--replay` uses the recording.
import { investigate } from "../server/agents/investigate.ts";
import { meterlessFromEnv } from "../server/ai/provider.ts";
import { RECORDING } from "../server/app.ts";
import { zetarisFromEnv } from "../server/data/zetaris.ts";
import { replaying } from "../server/replay.ts";

try { process.loadEnvFile(".env"); } catch {}
const replay = process.argv.includes("--replay") || process.env.BLACKBOX_REPLAY === "1";
const deps = replay ? replaying(RECORDING, 0) : (() => { const zx = zetarisFromEnv(); return { query: (sql: string) => zx.query(sql), ai: meterlessFromEnv() }; })();

const { evidence, ledger } = await investigate({ ...deps, emit: () => {} });
const failures: string[] = [];
for (const row of ledger) {
  for (const cell of row.cells) {
    const e = evidence.find((x) => x.cell === cell)!;
    const again = (await deps.query(e.sql)).rows;
    const same = JSON.stringify(again) === JSON.stringify(e.rows);
    console.log(`${same ? "ok  " : "FAIL"} ${row.id} ${row.by.padEnd(5)} ${cell} ${String(again.length).padStart(2)} rows  ${row.claim.slice(0, 90)}`);
    if (!same) failures.push(`${row.id} ${cell}: re-run returned different rows`);
  }
}
const rca = ledger.filter((r) => r.by === "RCA").length;
const reported = ledger.filter((r) => r.kind === "reported").length;
if (rca < 3) failures.push(`expected at least 3 RCA claims, got ${rca}`);
if (reported < 1) failures.push("expected the reported false lead in the ledger");
console.log(`\n${replay ? "replay" : "live"}: ${ledger.length} ledger rows (${rca} RCA, ${reported} reported)`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("demo:check passed");
