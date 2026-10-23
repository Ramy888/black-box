import { Hono } from "hono";
import { INCIDENT_AT } from "../scenario/generate.ts";
import { zetarisFromEnv } from "./data/zetaris.ts";
import { loadFlightRows, replayFlight } from "./engines/world-model.ts";

export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "black-box" }));

app.get("/api/flight", async (c) => {
  try {
    return c.json(await replayFlight(await loadFlightRows(zetarisFromEnv()), INCIDENT_AT));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
