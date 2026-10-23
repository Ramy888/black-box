import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { INCIDENT_AT } from "../scenario/generate.ts";
import { investigate, type InvestigationEvent } from "./agents/investigate.ts";
import { meterlessFromEnv } from "./ai/provider.ts";
import { zetarisFromEnv } from "./data/zetaris.ts";
import { loadFlightRows, replayFlight } from "./engines/world-model.ts";
import { recording, replaying } from "./replay.ts";

export const RECORDING = path.join(import.meta.dirname, "..", "data", "recordings", "bb-0417.json");

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
app.get("/api/investigate", (c) => streamSSE(c, async (stream) => {
  // Writes are chained so a burst emitted in one tick is flushed before the stream closes.
  let flushed = Promise.resolve();
  const send = (e: InvestigationEvent) => {
    const data = JSON.stringify(e); // serialised now: later events may update the same objects
    flushed = flushed.then(() => stream.writeSSE({ data }));
  };
  const replay = process.env.BLACKBOX_REPLAY === "1";
  try {
    const rec = replay ? undefined : recording(RECORDING);
    const zx = replay ? undefined : zetarisFromEnv();
    const deps = replay ? replaying(RECORDING) : { query: rec!.query((sql) => zx!.query(sql)), ai: rec!.ai(meterlessFromEnv()) };
    await send({ type: "mode", mode: replay ? "replay" : "live" });
    await investigate({ ...deps, emit: (e) => void send(e) });
    rec?.save();
  } catch (err) {
    void send({ type: "error", message: (err as Error).message });
  }
  await flushed;
}));
