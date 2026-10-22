// Live check: one query through the local Zetaris REST API. Run: npm run check:zetaris
import { zetarisFromEnv } from "../server/data/zetaris.ts";

process.loadEnvFile?.(".env");
const sql = process.argv[2] ?? "SELECT 1 AS ok";
const { rows } = await zetarisFromEnv().query(sql, 5);
console.log(`Zetaris OK: ${rows.length} row(s) for: ${sql}`);
console.log(JSON.stringify(rows, null, 2));
