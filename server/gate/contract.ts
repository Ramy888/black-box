// Guardrail contracts: a machine-checkable rule plus an HMAC over its canonical JSON.
// A human signs it; the gate refuses any contract whose signature does not match, so
// nothing activates unsigned and a single changed byte breaks it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEngine } from "../engines/load.ts";

export interface GuardrailRule {
  tool: "issue_refund";
  /** Refund only if days since delivery <= this live value, read when the gate checks, never baked in. */
  require: "days_since_delivery <= live_policy.max_return_days";
  live_source: "SHOP_PG.policy_versions WHERE valid_to IS NULL";
}

export interface Contract {
  id: string; case_id: string; proposed_by: "REM"; proposed_at: string;
  clause: string; rule: GuardrailRule; context: string; evidence: string[];
  approved_by?: string; approved_at?: string; signature?: string;
}

export class ContractInvalid extends Error {}

const canonical = async (c: Contract) => {
  const { signature: _drop, ...body } = c;
  return (await loadEngine("world-model")).mod.canonicalJson(body) as string;
};
const hmac = (key: string, text: string) => crypto.createHmac("sha256", key).update(text).digest("hex");

export async function signContract(c: Contract, key: string, signer: string, at: Date): Promise<Contract> {
  const approved: Contract = { ...c, approved_by: signer, approved_at: at.toISOString() };
  return { ...approved, signature: hmac(key, await canonical(approved)) };
}

export async function verifyContract(c: Contract, key: string): Promise<boolean> {
  if (!c.signature || !c.approved_by) return false;
  const expected = Buffer.from(hmac(key, await canonical(c)), "hex");
  const given = Buffer.from(c.signature, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface GateResult { allow: boolean; contract_id: string; clause?: string }

/** The only rule this gate knows how to enforce; a signed contract with any other rule is refused, not ignored. */
const ENFORCED: GuardrailRule = { tool: "issue_refund", require: "days_since_delivery <= live_policy.max_return_days", live_source: "SHOP_PG.policy_versions WHERE valid_to IS NULL" };

/**
 * Builds the gate for one run: the contract must verify and carry the enforced rule; then each refund is
 * checked against the live window, read on every check (as the signed rule says), never baked in.
 */
export async function activateGate(c: Contract, key: string, liveMaxDays: () => number | Promise<number>) {
  if (!(await verifyContract(c, key))) throw new ContractInvalid(`Contract ${c.id} is unsigned or altered; the gate will not activate.`);
  if (JSON.stringify(c.rule) !== JSON.stringify(ENFORCED)) throw new ContractInvalid(`Contract ${c.id} has a rule this gate does not enforce; refusing to activate.`);
  return async ({ days_since_delivery }: { days_since_delivery: number }): Promise<GateResult> =>
    days_since_delivery <= (await liveMaxDays()) ? { allow: true, contract_id: c.id } : { allow: false, contract_id: c.id, clause: c.clause };
}

/** CONTRACT_SIGNING_KEY from .env, else a key generated once into data/runtime (gitignored). Never printed. */
export function signingKey(env = process.env, dir = path.join(import.meta.dirname, "..", "..", "data", "runtime")): string {
  if (env.CONTRACT_SIGNING_KEY) return env.CONTRACT_SIGNING_KEY;
  const file = path.join(dir, "signing.key");
  fs.mkdirSync(dir, { recursive: true });
  try {
    // "wx" creates the file only if it does not exist, so two first requests cannot both write a key.
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    console.log(`generated a contract signing key in ${path.relative(process.cwd(), file)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const key = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new ContractInvalid(`${file} is not a 32-byte hex key; delete it to generate a new one.`);
  return key;
}
