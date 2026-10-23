import { serve } from "@hono/node-server";
import { app } from "./app.ts";

try { process.loadEnvFile(".env"); } catch {}

const port = Number(process.env.PORT ?? 8799);
serve({ fetch: app.fetch, port }, () => console.log(`black-box server on http://127.0.0.1:${port}`));
