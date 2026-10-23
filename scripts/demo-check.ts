// Proves the investigation end to end (Checkpoint C): the Skeptic re-ran every claim's
// Zetaris queries and they reproduced, it struck the reported false lead, and the root
// cause plus at least 3 claims survive. `--replay` uses the recording.
import { investigate } from "../server/agents/investigate.ts";
import { meterlessFromEnv } from "../server/ai/provider.ts";
import { RECORDING } from "../server/app.ts";
import { zetarisFromEnv } from "../server/data/zetaris.ts";
import { replaying } from "../server/replay.ts";

try { process.loadEnvFile(".env"); } catch {}
const replay = process.argv.includes("--replay") || process.env.BLACKBOX_REPLAY === "1";
const deps = replay ? replaying(RECORDING, 0) : (() => { const zx = zetarisFromEnv(); return { query: (sql: string) => zx.query(sql), ai: meterlessFromEnv() }; })();

const { ledger } = await investigate({ ...deps, emit: () => {} });
const failures: string[] = [];
for (const r of ledger) {
  const v = r.verdict;
  console.log(`${r.id} ${r.by.padEnd(5)} ${r.kind.padEnd(10)} ${(r.status + (v ? ` [${v.cells.join(",")}]` : "")).padEnd(22)} ${r.claim.slice(0, 80)}`);
  if (!v) failures.push(`${r.id}: no Skeptic verdict`);
  else if (!v.reproduced) failures.push(`${r.id}: cited evidence did not reproduce when SKP re-ran it`);
}
const survivors = ledger.filter((r) => r.status === "survives");
if (!ledger.some((r) => r.kind === "reported")) failures.push("the reported false lead is missing from the ledger");
for (const r of ledger.filter((x) => x.kind === "reported" && x.status !== "struck")) failures.push(`${r.id}: the false lead was not struck by SKP`);
if (!ledger.some((r) => r.kind === "root-cause" && r.status === "survives")) failures.push("the root cause did not survive the Skeptic");
if (survivors.length < 3) failures.push(`expected at least 3 surviving claims, got ${survivors.length}`);
console.log(`\n${replay ? "replay" : "live"}: ${survivors.length} survive, ${ledger.length - survivors.length} struck by SKP`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("demo:check passed");
