// Command-line entry point: npm run agent -- --input examples/example_2.challenge.json
// Writes <input>.output.json and <input>.trace.jsonl next to the input. Live when the services
// are up (and records the run), otherwise replays the recording; the output says which.
import fs from "node:fs";
import { mode, runDeps } from "../server/app.ts";
import { runTask, type RunInput } from "../server/run.ts";

try { process.loadEnvFile(".env"); } catch {}
const file = process.argv[process.argv.indexOf("--input") + 1];
if (!process.argv.includes("--input") || !file) { console.error("usage: npm run agent -- --input <examples/example_N.*.json> [--replay]"); process.exit(2); }
if (process.argv.includes("--replay")) process.env.BLACKBOX_REPLAY = "1";

const input = JSON.parse(fs.readFileSync(file, "utf8")) as RunInput;
const { reason } = await mode();
const deps = await runDeps(input);
let code = 0;
try {
  const { output, trace } = await runTask(input, deps);
  deps.saveRecording?.();
  const base = file.replace(/\.json$/, "");
  fs.writeFileSync(`${base}.output.json`, JSON.stringify(output, null, 2) + "\n");
  fs.writeFileSync(`${base}.trace.jsonl`, trace.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(JSON.stringify(output, null, 2));
  console.error(`\n${output.mode}${reason ? ` (${reason})` : ""} · wrote ${base}.output.json and ${base}.trace.jsonl (${trace.length} trace lines)`);
} catch (err) {
  console.error(`run failed: ${(err as Error).message}`);
  code = 1;
} finally {
  await deps.pool?.end();
  process.exit(code); // the service check keeps a DB pool open; exit explicitly
}
