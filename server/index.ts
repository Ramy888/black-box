import { serve } from "@hono/node-server";
import { app } from "./app.ts";

try { process.loadEnvFile(".env"); } catch {}

const port = Number(process.env.PORT ?? 8799);
// Bound to 127.0.0.1 so another server on this port fails loudly instead of answering half the requests.
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`black-box server on http://127.0.0.1:${port}`));
