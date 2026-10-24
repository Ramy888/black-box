// Programmatic entry point: one JSON input in, one JSON output plus a trace out. The same
// agents the UI streams, without the UI. Used by `npm run agent -- --input <file>` and POST /api/run.

import path from "node:path";
import { investigate, type InvestigationEvent } from "./agents/investigate.ts";
import { runSkeptic } from "./agents/skeptic.ts";
import { runWitness, WITNESSES, type Evidence, type Query } from "./agents/witness.ts";
import type { Chat, ModelCall } from "./agents/root-cause.ts";
import { runAirlock, type AirlockEvent } from "./gate/airlock.ts";
import { signContract, type Contract } from "./gate/contract.ts";
import type pg from "pg";
import fs from "node:fs";

export type RunInput =
  | { task: "investigate"; incident: "BB-0417"; question?: string }
  | { task: "challenge"; incident: "BB-0417"; claim: string }
  | { task: "airlock"; incident: "BB-0417"; approver?: string };

export type TraceLine = { t_ms: number } & (InvestigationEvent | AirlockEvent | { type: "input"; input: RunInput });

export interface RunDeps {
  query: Query; ai: Chat; replay: boolean;
  /** The refund agent's model for a live airlock (the investigation part may come from a recording). */
  culpritAi?: Chat;
  /** Needed for the airlock task only: the shop DB pool and the HMAC key. */
  pool?: pg.Pool; key?: string;
  airlockRecording?: string;
}

const modelLine = (c: ModelCall) => ({ agent: c.callsign, budget: c.budget, outcome: c.outcome, model: c.receipt?.routed_model ?? null, from_cache: c.receipt?.from_cache ?? null, ms: c.receipt?.ms ?? null });

export async function runTask(input: RunInput, deps: RunDeps) {
  if (input.incident !== "BB-0417") throw new Error(`Unknown incident ${input.incident}; this repo ships the seeded incident BB-0417.`);
  const started = Date.now();
  const trace: TraceLine[] = [{ t_ms: 0, type: "input", input }];
  const emit = (e: InvestigationEvent | AirlockEvent) => trace.push({ t_ms: Date.now() - started, ...e });
  const mode = deps.replay ? "replay (recorded live run)" : "live";

  if (input.task === "investigate") {
    const { ledger, contract } = await investigate({ query: deps.query, ai: deps.ai, emit });
    return {
      output: {
        task: input.task, mode, question: input.question ?? "Why did the refund agent pay refunds it should not have?",
        root_cause: ledger.find((r) => r.kind === "root-cause")?.claim ?? null,
        ledger: ledger.map((r) => ({ id: r.id, by: r.by, kind: r.kind, claim: r.claim, cells: r.cells, status: r.status, skeptic: r.verdict?.why ?? null, zetaris_queries: r.sql.length })),
        proposed_guardrail: contract ? { id: contract.id, clause: contract.clause, evidence: contract.evidence } : null,
        model_calls: trace.flatMap((e) => (e.type === "model" ? [modelLine(e.call)] : [])),
      },
      trace,
    };
  }

  if (input.task === "challenge") {
    // A user's own hypothesis goes to the Skeptic with every witness's evidence, exactly like a reported ticket.
    const evidence: Evidence[] = [];
    for (const w of WITNESSES) evidence.push(...(await runWitness(w, deps.query, (e) => emit({ type: "evidence", evidence: e }))));
    const claim = { id: "U1", claim: input.claim, cells: evidence.map((e) => e.cell) };
    const [verdict] = await runSkeptic({
      query: deps.query, ai: deps.ai, evidence, claims: [claim],
      onEvidence: (e) => { evidence.push(e); emit({ type: "evidence", evidence: e }); },
      onCall: (call) => emit({ type: "model", call }),
      onVerdict: (v) => emit({ type: "verdict", verdict: v }),
    });
    return {
      output: {
        task: input.task, mode, claim: input.claim, verdict: verdict.status, decided_by: verdict.cells, why: verdict.why,
        evidence_reproduced: verdict.reproduced,
        probes: evidence.filter((e) => e.by === "SKP").map((e) => ({ cell: e.cell, report: e.report })),
        model_calls: trace.flatMap((e) => (e.type === "model" ? [modelLine(e.call)] : [])),
      },
      trace,
    };
  }

  // airlock: REM's proposal from an investigation, signed by the approver named in the input
  // (the CLI's stand-in for the human click), then the 40 bad requests replayed through the gate.
  const { contract } = await investigate({ query: deps.query, ai: deps.ai, emit: () => {} });
  if (!contract) throw new Error("No surviving root cause, so REM proposed no guardrail to sign.");
  if (!deps.key) throw new Error("The airlock task needs the contract signing key.");
  const signed: Contract = await signContract(contract, deps.key, input.approver ?? "CLI operator", new Date());
  let done: Extract<AirlockEvent, { type: "airlock-done" }>;
  if (deps.replay) {
    const events = JSON.parse(fs.readFileSync(deps.airlockRecording!, "utf8")) as AirlockEvent[];
    for (const e of events) emit(e.type === "airlock-start" ? { ...e, contract_id: signed.id, signer: signed.approved_by!, signature: signed.signature!, live: false } : e);
    done = events.find((e) => e.type === "airlock-done") as typeof done;
  } else {
    if (!deps.pool) throw new Error("The live airlock task needs the shop database.");
    done = await runAirlock({ pool: deps.pool, ai: deps.culpritAi ?? deps.ai, contract: signed, key: deps.key, emit });
  }
  return {
    output: {
      task: input.task, mode, guardrail: { id: signed.id, clause: signed.clause, signed_by: signed.approved_by, hmac: `${signed.signature!.slice(0, 16)}…` },
      attempted: done.attempted, blocked: done.blocked, payouts_executed: done.payouts, sealed_transaction: done.sealed,
      agent_still_decided_approve: trace.filter((e) => e.type === "attempt" && e.decision === "approve").length,
    },
    trace,
  };
}

export const EXAMPLES_DIR = path.join(import.meta.dirname, "..", "examples");
