import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import pg from "pg";
import { INCIDENT_AT } from "../scenario/generate.ts";
import { shopPool } from "../scenario/load.ts";
import { crossExamine, type CrossExamEvent } from "./agents/counterpart.ts";
import { investigate } from "./agents/investigate.ts";
import { meterlessFromEnv } from "./ai/provider.ts";
import { zetarisFromEnv } from "./data/zetaris.ts";
import { loadFlightRows, replayFlight } from "./engines/world-model.ts";
import { AIRLOCK_RUN, runAirlock, type AirlockEvent } from "./gate/airlock.ts";
import { signContract, signingKey, type Contract } from "./gate/contract.ts";
import { guardrailStore } from "./gate/store.ts";
import { recording, replaying } from "./replay.ts";

export const RECORDING = path.join(import.meta.dirname, "..", "data", "recordings", "bb-0417.json");
export const CROSSEXAM_RECORDING = path.join(import.meta.dirname, "..", "data", "recordings", "crossexam-0417.json");
export const AIRLOCK_RECORDING = path.join(import.meta.dirname, "..", "data", "recordings", `${AIRLOCK_RUN}.json`);
const isReplay = () => process.env.BLACKBOX_REPLAY === "1";

// Contracts REM proposed in this process; the server signs only these, by id.
const proposals = new Map<string, Contract>();
// The last finished investigation in this process, which the Counterpart cross-examines.
let lastInvestigation: Awaited<ReturnType<typeof investigate>> | undefined;
const store = guardrailStore();
let pool: pg.Pool | undefined;

/** Streams events as SSE. Writes are chained and serialised at send time, so a burst emitted
 *  in one tick is flushed in order before the stream closes, even if objects change later. */
function sse<E>(c: Context, run: (send: (e: E) => void) => Promise<void>, onError: (message: string) => E) {
  return streamSSE(c, async (stream) => {
    let flushed = Promise.resolve();
    const send = (e: E) => {
      const data = JSON.stringify(e);
      flushed = flushed.then(() => stream.writeSSE({ data }));
    };
    try { await run(send); } catch (err) { send(onError((err as Error).message)); }
    await flushed;
  });
}

export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "black-box" }));

app.get("/api/flight", async (c) => {
  try {
    return c.json(await replayFlight(await loadFlightRows(zetarisFromEnv()), INCIDENT_AT));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// Live runs record every Zetaris answer and model reply; BLACKBOX_REPLAY=1 serves the last recording instead.
app.get("/api/investigate", (c) => sse(c, async (send) => {
  const replay = isReplay();
  const rec = replay ? undefined : recording(RECORDING);
  const zx = replay ? undefined : zetarisFromEnv();
  const deps = replay ? replaying(RECORDING) : { query: rec!.query((sql) => zx!.query(sql)), ai: rec!.ai(meterlessFromEnv()) };
  send({ type: "mode", mode: replay ? "replay" : "live" });
  const out = await investigate({ ...deps, emit: send });
  if (out.contract) proposals.set(out.contract.id, out.contract);
  lastInvestigation = out;
  rec?.save();
}, (message) => ({ type: "error", message })));

// Cross-examination by the Counterpart, a separate step with its own recording.
app.get("/api/crossexam", (c) => sse<CrossExamEvent>(c, async (send) => {
  if (!lastInvestigation) throw new Error("Run Investigate first; the Counterpart cross-examines its ledger.");
  const replay = isReplay();
  const rec = replay ? undefined : recording(CROSSEXAM_RECORDING);
  const ai = replay ? replaying(CROSSEXAM_RECORDING).ai : rec!.ai(meterlessFromEnv());
  send({ type: "mode", mode: replay ? "replay" : "live" });
  const exchanges = await crossExamine({ ai, ...lastInvestigation, onCall: (call) => send({ type: "model", call }), onExchange: (exchange) => send({ type: "exchange", exchange }) });
  send({ type: "crossexam-done", asked: exchanges.length, weak: exchanges.filter((x) => x.weak).map((x) => x.target) });
  rec?.save();
}, (message) => ({ type: "crossexam-error", message })));

app.get("/api/contract", async (c) => c.json({ approved: (await store).latest() ?? null }));

// "Approve and sign": a human signs a proposal REM made; the signature is an HMAC over the contract.
app.post("/api/contract/:id/approve", async (c) => {
  const proposal = proposals.get(c.req.param("id"));
  if (!proposal) return c.json({ error: "No such proposal in this session. Run Investigate first." }, 404);
  const signed = await signContract(proposal, signingKey(), process.env.APPROVER_ROLE || "On-call lead", new Date());
  await (await store).record(signed);
  return c.json({ approved: signed });
});

// The Airlock replays the bad requests with the signed guardrail active. Live runs are recorded;
// replay mode serves the recorded attempts under the contract signed in this session.
app.get("/api/airlock", (c) => sse<AirlockEvent>(c, async (send) => {
  const contract = (await store).latest();
  if (!contract) throw new Error("No signed guardrail yet. Approve and sign the contract first.");
  if (isReplay()) {
    if (!fs.existsSync(AIRLOCK_RECORDING)) throw new Error("No Airlock recording yet. Run one live Airlock first.");
    for (const e of JSON.parse(fs.readFileSync(AIRLOCK_RECORDING, "utf8")) as AirlockEvent[]) {
      send(e.type === "airlock-start" ? { ...e, contract_id: contract.id, signer: contract.approved_by!, signature: contract.signature! } : e);
      if (e.type === "attempt") await new Promise((r) => setTimeout(r, 90));
    }
    return;
  }
  const events: AirlockEvent[] = [];
  pool ??= shopPool();
  await runAirlock({ pool, ai: meterlessFromEnv(), contract, key: signingKey(), emit: (e) => { events.push(e); send(e); } });
  fs.mkdirSync(path.dirname(AIRLOCK_RECORDING), { recursive: true });
  fs.writeFileSync(AIRLOCK_RECORDING, JSON.stringify(events, null, 1) + "\n");
}, (message) => ({ type: "airlock-error", message })));
