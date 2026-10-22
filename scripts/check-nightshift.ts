// Live check: runtime status, then one text request through Nightshift. Run: npm run check:nightshift [model]
import { meterlessFromEnv } from "../server/ai/provider.ts";

try { process.loadEnvFile(".env"); } catch {}
const ai = meterlessFromEnv();
const { state, models } = await ai.status();
console.log(`Meterless Runtime ${ai.baseUrl}: ${state}`);
console.log(`Models: ${models.join(", ")}`);
if (state !== "online") process.exit(1);
const model = process.argv[2] ?? "meterless/auto";
const reply = await ai.chat({ model, messages: [{ role: "user", content: "Reply with exactly: black box online" }], maxTokens: 20 });
console.log(`Asked ${model}; answered by ${reply.model}: ${reply.text}`);
