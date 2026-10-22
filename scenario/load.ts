// Loads the scenario into the shop database, ships file sources to Zetaris's shared
// folder, and registers every source in Zetaris. Safe to re-run. Run: npm run scenario:load
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { zetarisFromEnv } from "../server/data/zetaris.ts";
import { generateScenario, toCsv } from "./generate.ts";

try { process.loadEnvFile(".env"); } catch {}

export const ZETARIS_CONTAINER = process.env.ZETARIS_DRIVER_CONTAINER ?? "zetaris-driver-1";
export const SHARED_DIR = "/home/zetaris/customer-data/shared/blackbox";

export function shopPool() {
  return new pg.Pool({ host: "127.0.0.1", port: Number(process.env.SHOP_DB_PORT ?? 55432), database: "shop", user: "shop", password: process.env.SHOP_DB_PASSWORD });
}

/** Copies a local file into Zetaris's shared folder so filestore tables can read it. */
export function shipToZetaris(localPath: string, name: string) {
  execFileSync("docker", ["exec", ZETARIS_CONTAINER, "mkdir", "-p", SHARED_DIR]);
  execFileSync("docker", ["cp", localPath, `${ZETARIS_CONTAINER}:${SHARED_DIR}/${name}`]);
  execFileSync("docker", ["exec", "-u", "0", ZETARIS_CONTAINER, "chmod", "-R", "a+rX", SHARED_DIR]);
  return `file://${SHARED_DIR}/${name}`;
}

/** Runs a Zetaris statement, tolerating "already exists" so loads are idempotent. */
export async function zx(sql: string) {
  try {
    return await zetarisFromEnv().query(sql);
  } catch (err) {
    if (/already exist/i.test((err as Error).message)) return { rows: [] };
    throw err;
  }
}

async function loadShopDb() {
  const s = generateScenario();
  const pool = shopPool();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(fs.readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8"));
    const insert = async (table: string, rows: Record<string, unknown>[]) => {
      for (const r of rows) {
        const cols = Object.keys(r);
        await db.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
      }
    };
    await insert("customers", s.customers);
    await insert("orders", s.orders);
    await insert("payments", s.payments);
    await insert("policy_versions", s.policyVersions);
    await insert("refund_requests", s.refundRequests);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
  return s;
}

async function registerInZetaris(opsTicketsPath: string) {
  const password = process.env.SHOP_DB_PASSWORD;
  if (!password) throw new Error("SHOP_DB_PASSWORD is not set in .env");
  const port = process.env.SHOP_DB_PORT ?? "55432";
  await zx(`CREATE DATASOURCE SHOP_PG DESCRIBE BY "Demo shop operational database, PostgreSQL" OPTIONS (
    jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://host.docker.internal:${port}/shop",
    username "shop", password "${password}", fetchsize "1000")`);
  for (const t of ["customers", "orders", "payments", "policy_versions", "refund_requests", "refunds", "tool_calls"]) {
    await zx(`REGISTER DATASOURCE TABLE '${t}' FROM SHOP_PG`);
  }
  await zx(`CREATE LIGHTNING DATABASE BB_FILES DESCRIBE BY "Black Box file sources, ops tickets and agent traces"`);
  await zx(`CREATE LIGHTNING FILESTORE TABLE ops_tickets FROM BB_FILES FORMAT CSV OPTIONS (PATH "${opsTicketsPath}", inferSchema "true", header "true")`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const s = await loadShopDb();
  console.log(`shop-db: ${s.orders.length} orders, ${s.refundRequests.length} refund requests, ${s.policyVersions.length} policy versions`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bb-")), "ops_tickets.csv");
  fs.writeFileSync(tmp, toCsv(s.opsTickets));
  const opsPath = shipToZetaris(tmp, "ops_tickets.csv");
  await registerInZetaris(opsPath);
  const { rows } = await zetarisFromEnv().query("SELECT count(*) FROM SHOP_PG.refund_requests");
  const { rows: t } = await zetarisFromEnv().query("SELECT count(*) FROM BB_FILES.ops_tickets");
  console.log(`zetaris: SHOP_PG.refund_requests=${rows[0][0]}, BB_FILES.ops_tickets=${t[0][0]}`);
}
