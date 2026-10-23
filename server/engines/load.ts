// Engine loader, adapted from the Meterless agentathon starter. `npm run setup`
// vendors the official H-MEM and World Model references into vendor/ (gitignored);
// the startup line names which source loaded, so nobody debugs the wrong copy.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type EngineName = "hmem" | "world-model";

export async function loadEngine(name: EngineName): Promise<{ mod: Record<string, any>; source: string }> {
  const entry = path.join(root, "vendor", name, "src", "index.ts");
  if (!fs.existsSync(entry)) {
    throw new Error(`Meterless engine "${name}" not found at vendor/${name}. Run: npm run setup`);
  }
  // A plain path on POSIX: Vite (vitest) cannot load a file:// URL whose path has spaces.
  const spec = process.platform === "win32" ? pathToFileURL(entry).href : entry;
  return { mod: await import(spec), source: `vendor/${name}` };
}
