// Proves the investigation end to end (Checkpoint C): the Skeptic re-ran every claim's
// Zetaris queries and they reproduced, it struck the reported false lead, and the root
// cause plus at least 3 claims survive. Then Checkpoint D's climax: REM proposes a guardrail,
// it is signed, and the Airlock replay pays 0 of the 40 bad refunds. `--replay` uses the recordings.
import fs from "node:fs";
import { investigate } from "../server/agents/investigate.ts";
import { meterlessFromEnv } from "../server/ai/provider.ts";
import { AIRLOCK_RECORDING, RECORDING } from "../server/app.ts";
import { runAirlock, type AirlockEvent } from "../server/gate/airlock.ts";
import { signContract, signingKey } from "../server/gate/contract.ts";
import { shopPool } from "../scenario/load.ts";
import { zetarisFromEnv } from "../server/data/zetaris.ts";
import { replaying } from "../server/replay.ts";

try { process.loadEnvFile(".env"); } catch {}
const replay = process.argv.includes("--replay") || process.env.BLACKBOX_REPLAY === "1";
const deps = replay ? replaying(RECORDING, 0) : (() => { const zx = zetarisFromEnv(); return { query: (sql: string) => zx.query(sql), ai: meterlessFromEnv() }; })();

const { ledger, contract } = await investigate({ ...deps, emit: () => {} });
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

if (!contract) failures.push("REM proposed no guardrail");
else {
  const signed = await signContract(contract, signingKey(), "demo:check", new Date());
  let done: Extract<AirlockEvent, { type: "airlock-done" }> | undefined;
  if (replay) {
    const events = JSON.parse(fs.readFileSync(AIRLOCK_RECORDING, "utf8")) as AirlockEvent[];
    done = events.find((e) => e.type === "airlock-done") as typeof done;
  } else {
    const pool = shopPool();
    try { done = await runAirlock({ pool, ai: (deps as any).ai, contract: signed, key: signingKey(), emit: () => {} }); } finally { await pool.end(); }
  }
  console.log(`airlock (${replay ? "recorded" : "live"}): ${done?.blocked}/${done?.attempted} blocked, ${done?.payouts} payouts executed`);
  if (!done) failures.push("the Airlock did not finish");
  else {
    if (done.payouts !== 0) failures.push(`the Airlock let ${done.payouts} payouts through`);
    if (done.attempted !== 40 || done.blocked !== 40) failures.push(`expected 40 of 40 blocked, got ${done.blocked} of ${done.attempted}`);
  }
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("demo:check passed");
