import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BudgetExhausted, type ChatResult } from "../ai/provider.ts";
import { recording, replaying } from "../replay.ts";
import { investigate, type InvestigationEvent } from "./investigate.ts";
import { InvalidReply, parseClaims } from "./root-cause.ts";
import { parseVerdict, PROBES } from "./skeptic.ts";
import { WITNESSES } from "./witness.ts";
import { runTask } from "../run.ts";

// Zetaris-shaped answers (all strings) keyed by the cell whose query asks for them.
const ROWS: Record<string, unknown[][]> = {
  A1: [["1", "30", "2026-01-01 00:00:00.0", "2026-10-18 00:00:00.0", "launch"], ["2", "14", "2026-10-18 00:00:00.0", null, "FIN-212"]],
  A2: [["40", "69422.000000000000000000", "15", "29"]],
  B1: [["Refunds are allowed within 30 days of delivery.", "nvidia/nemotron", "off", "132"]],
  B2: [["Within 30-day refund window", "30"], ["Within 30-day window", "10"]],
  C1: [["OPS-881", "Finance", "Refund payouts spiked today"], ["OPS-882", "Support", "Payments provider returning duplicate IDs?"]],
  S1: [["OPS-882", "132", "132"]],
  S2: [["120", "120"]],
};
const bySql = new Map([...WITNESSES.flatMap((w) => w.surveys), ...PROBES].map((s) => [s.sql, ROWS[s.cell]] as const));
const query = async (sql: string) => ({ rows: bySql.get(sql)! });
const sqlOf = (cell: string) => [...WITNESSES.flatMap((w) => w.surveys), ...PROBES].find((s) => s.cell === cell)!.sql;

const RCA_REPLY = [
  "**ROOT:** The agent's prompt kept the 30-day policy after v2 cut it to 14 days. [A1, B1]",
  "- FINDING: 40 refunds, 69,422 EGP, were paid past the live window. [A2]",
  "FINDING: Made up. [Z9]",
].join("\n");
const ok = (text: string): ChatResult => ({ text, model: "nvidia/nemotron", receipt: { routed_model: "nvidia/nemotron", from_cache: false, cache_status: "miss", tokens_out: 1900, tokens_per_s: 100, cost_usd: 0, ms: 17000 } });

// SKP strikes the reported rumour and lets the rest stand, like the real run.
const skeptic = async (o: any) => ok(o.messages[1].content.includes("Reported by")
  ? "VERDICT: STRUCK [S1, S2]\nWHY: 132 payments carry 132 distinct refs, so there are no duplicates."
  : "**VERDICT:** SURVIVES [A1]\nWHY: The cited evidence shows it.");
const route = (rca: (o: any) => Promise<ChatResult>, skp = skeptic) => ({ chat: vi.fn((o: any) => (o.messages[0].content.startsWith("You are RCA") ? rca : skp)(o)) });
const modelCalls = (events: InvestigationEvent[], callsign: string) =>
  events.flatMap((e) => (e.type === "model" && e.call.callsign === callsign ? [e.call] : []));

async function run(rca: (o: any) => Promise<ChatResult>, skp = skeptic, q = query) {
  const events: InvestigationEvent[] = [];
  const out = await investigate({ query: q, ai: route(rca, skp), emit: (e) => events.push(e) });
  return { ...out, events };
}

describe("investigation", () => {
  it("files the false lead as reported, then RCA claims that carry their cells' Zetaris queries", async () => {
    const { ledger, events } = await run(async () => ok(RCA_REPLY));
    expect(ledger.map((r) => [r.kind, r.by, r.cells])).toEqual([
      ["reported", "WIT·3", ["C1"]],
      ["root-cause", "RCA", ["A1", "B1"]],
      ["finding", "RCA", ["A2"]],
    ]);
    expect(ledger[0].claim).toBe("Reported by Support in OPS-882: Payments provider returning duplicate IDs?");
    expect(ledger[1].sql).toEqual(WITNESSES.flatMap((w) => w.surveys).filter((s) => ["A1", "B1"].includes(s.cell)).map((s) => s.sql));
    expect(ledger[1].sources).toEqual(["SHOP_PG · Postgres", "BB_FILES.agent_traces · JSON"]);
    expect(events.filter((e) => e.type === "handoff").map((e) => (e as any).from).sort()).toEqual(["RCA", "SKP", "WIT·1", "WIT·2", "WIT·3"]);
  });

  it("has SKP strike the reported false lead with its own probes, and let the RCA claims stand", async () => {
    const { ledger, events } = await run(async () => ok(RCA_REPLY));
    expect(ledger.map((r) => [r.id, r.status])).toEqual([["L1", "struck"], ["L2", "survives"], ["L3", "survives"]]);
    expect(ledger[0].verdict).toMatchObject({ by: "SKP", cells: ["S1", "S2"], reproduced: true });
    expect(events.filter((e) => e.type === "evidence").map((e) => (e as any).evidence.cell)).toEqual(expect.arrayContaining(["S1", "S2"]));
    expect(events.at(-1)).toMatchObject({ type: "done", claims: 3, survives: 2, struck: 1 });
  });

  it("has REM propose a guardrail from the surviving root cause, citing the survivors", async () => {
    const { contract, events } = await run(async () => ok(RCA_REPLY));
    expect(contract).toMatchObject({ id: "GC-0417-1", proposed_by: "REM", evidence: ["L2", "L3", "A1", "B1", "A2"] });
    expect(contract!.context).toContain("Live policy at proposal: v2, 14 days.");
    expect(contract!.signature).toBeUndefined();
    expect(events.some((e) => e.type === "contract")).toBe(true);
  });

  it("starts every round after a strike one rung higher, and says why", async () => {
    const { events } = await run(async () => ok(RCA_REPLY));
    expect(modelCalls(events, "SKP").map((c) => [c.budget, c.raised_by])).toEqual([[2048, undefined], [4096, "SKP struck L1"], [4096, "SKP struck L1"]]);
  });

  it("never starts a round on the top rung, however many strikes", async () => {
    const strikeAll = async () => ok("VERDICT: STRUCK [S1]\nWHY: Not shown.");
    const { events } = await run(async () => ok(RCA_REPLY), strikeAll);
    expect(modelCalls(events, "SKP").map((c) => [c.budget, c.raised_by])).toEqual([[2048, undefined], [4096, "SKP struck L1"], [4096, "SKP struck L1, L2"]]);
  });

  it("strikes a claim whose evidence does not reproduce, without asking the model", async () => {
    const runs = new Map<string, number>();
    const drifting = async (sql: string) => {
      runs.set(sql, (runs.get(sql) ?? 0) + 1);
      return sql === sqlOf("A2") && runs.get(sql)! > 1 ? { rows: [["39", "68000", "15", "29"]] } : query(sql);
    };
    const { ledger, events } = await run(async () => ok(RCA_REPLY), skeptic, drifting);
    expect(ledger[2].verdict).toMatchObject({ status: "struck", reproduced: false, cells: ["A2"] });
    expect(modelCalls(events, "SKP")).toHaveLength(2);
  });

  it("writes witness reports from the rows, with numbers formatted", async () => {
    const { evidence } = await run(async () => ok(RCA_REPLY));
    expect(evidence.find((e) => e.cell === "A2")!.report).toBe("40 refunds totalling 69,422 EGP were paid for orders delivered 15 to 29 days before the incident, past the live return window.");
    expect(evidence.find((e) => e.cell === "A1")!.report).toContain("Policy v2 allows 14 days from 2026-10-18 and is live");
  });

  it("climbs the budget ladder when Nemotron runs out of tokens, streaming the top rung", async () => {
    let calls = 0;
    const { events } = await run(async (o) => { if (calls++ === 0) throw new BudgetExhausted("empty"); expect(o).toMatchObject({ maxTokens: 4096, stream: true }); return ok(RCA_REPLY); });
    expect(modelCalls(events, "RCA").map((c) => [c.budget, c.outcome])).toEqual([[2048, "exhausted"], [4096, "ok"]]);
  });

  it("climbs the ladder for a fresh answer when the reply is unusable", async () => {
    const replies = ["The root cause is the policy.", RCA_REPLY];
    const { ledger, events } = await run(async () => ok(replies.shift()!));
    expect(ledger.filter((r) => r.by === "RCA")).toHaveLength(2);
    expect(modelCalls(events, "RCA").map((c) => [c.budget, c.outcome])).toEqual([[2048, "invalid"], [4096, "ok"]]);
  });

  it("replays a recorded run to the same ledger, failures included", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bb-rec-")), "rec.json");
    const rec = recording(file);
    let calls = 0;
    const live = await investigate({ query: rec.query(query), ai: rec.ai(route(async () => { if (calls++ === 0) throw new BudgetExhausted("empty"); return ok(RCA_REPLY); })), emit: () => {} });
    rec.save();
    const tape = replaying(file, 0);
    const replayed = await investigate({ query: tape.query, ai: tape.ai, emit: () => {} });
    expect(replayed.ledger).toEqual(live.ledger);
  });
});

describe("parseClaims", () => {
  it("reads ROOT and FINDING lines, ignoring markdown and dropping claims without a real cell", () => {
    const claims = parseClaims(RCA_REPLY, new Set(["A1", "A2", "B1"]));
    expect(claims.map((c) => [c.kind, c.cells])).toEqual([["root-cause", ["A1", "B1"]], ["finding", ["A2"]]]);
    expect(claims[0].claim).toBe("The agent's prompt kept the 30-day policy after v2 cut it to 14 days.");
  });

  it("rejects a reply with no usable ROOT line", () => {
    expect(() => parseClaims("FINDING: x [A1]", new Set(["A1"]))).toThrow(InvalidReply);
  });
});

describe("parseVerdict", () => {
  const valid = new Set(["C1", "S1", "S2"]);
  it("reads a strike and the cells that decide it", () => {
    expect(parseVerdict("**VERDICT:** STRUCK [S1, s2, Z9]\nWHY: No duplicates.", valid)).toEqual({ status: "struck", cells: ["S1", "S2"], why: "No duplicates." });
  });
  it("rejects a strike that cites no real evidence, or a reply without WHY", () => {
    expect(() => parseVerdict("VERDICT: STRUCK [Z9]\nWHY: trust me", valid)).toThrow(InvalidReply);
    expect(() => parseVerdict("VERDICT: SURVIVES [C1]", valid)).toThrow(InvalidReply);
  });
});

describe("run entry point", () => {
  it("challenges a user's own claim: witnesses, probes, a Skeptic verdict, and which model answered", async () => {
    const { output, trace } = await runTask({ task: "challenge", incident: "BB-0417", claim: "Refunds were paid twice." }, { query, ai: route(async () => ok(RCA_REPLY)), replay: false });
    expect(output).toMatchObject({ task: "challenge", verdict: "survives", evidence_reproduced: true });
    expect((output as any).probes.map((p: any) => p.cell)).toEqual(["S1", "S2"]);
    expect((output as any).model_calls).toEqual([expect.objectContaining({ agent: "SKP", model: "nvidia/nemotron", outcome: "ok" })]);
    expect(trace[0]).toMatchObject({ type: "input" });
  });

  it("rejects an incident it does not ship", async () => {
    await expect(runTask({ task: "investigate", incident: "BB-9999" as "BB-0417" }, { query, ai: route(async () => ok(RCA_REPLY)), replay: false })).rejects.toThrow(/Unknown incident/);
  });
});
