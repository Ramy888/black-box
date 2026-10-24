# Sponsor technology in Black Box

How each sponsor technology does real work in Black Box, where it lives in the code, and the test that proves it.

## Zetaris: the data layer for every piece of evidence

Every fact an agent relies on is a SQL query sent to the local Zetaris platform over its REST API (`POST /api/v1.0/sql-editor/sqls/run`, client in `server/data/zetaris.ts`). Nothing reads the shop database directly to build evidence.

The incident spans three sources registered in Zetaris by `npm run reset` (`scenario/load.ts`):

| Zetaris source | Kind | What it holds |
|---|---|---|
| `SHOP_PG` | Postgres datasource (`CREATE DATASOURCE`, tables registered) | orders, refunds, payments, refund requests, policy versions |
| `BB_FILES.agent_traces` | Lightning filestore table, JSON | the refund agent's 132 decisions: prompt policy, model, reason |
| `BB_FILES.ops_tickets` | Lightning filestore table, CSV | the tickets filed after the incident, including the false lead |

Queries cross sources in one statement. Two examples:

- **B2** (witness WIT·2) joins the agent's JSON traces to Postgres refunds and the live policy: which reasons did the agent give for the refunds it paid past the live window?
- **S1** (the Skeptic's probe) joins the tickets CSV to the payments table: the ticket says "duplicate payment IDs"; 132 payments carry 132 distinct provider refs.

The flight recorder reads all three sources through Zetaris as well. The Skeptic re-runs every cited Zetaris query itself and strikes any claim whose rows do not reproduce.

*Tests:* `server/data/zetaris.test.ts` (client contract and errors); `npm run demo:check` asserts the Skeptic's re-runs reproduce.

## Meterless: two engines in working features, and Nightshift as the AI provider

### World Model engine: the flight recorder and the guardrail store

- **What it does here:** the incident's 137 events (policy versions, the agent's decisions, tickets) are written into the World Model's append-only event log in time order and replayed on the flight-recorder strip. Which policy was live at the incident comes from the engine's **point-in-time fold** (`view("snapshot").entityAt(policy, 2026-10-21T10:00Z)`): v2, 14 days. That number decides which 40 payouts turn red. Code: `server/engines/world-model.ts`.
- **Second feature:** every human approval of a guardrail is a World Model event persisted to its local store (`server/gate/store.ts`); the gate reads the latest signed contract from it.
- **Tests:** `server/engines/world-model.test.ts`. The replay is in time order with increasing `seq`; the point-in-time fold returns 14 days at the incident and 30 days on 1 Oct; bad payouts are found by comparing numbers, not strings (this test was shown to fail when the strings bug is put back).

### H-MEM engine: memory of signed findings, with provenance

- **What it does here:** when a human signs a guardrail, the finding is stored in H-MEM as a long-term factual memory whose provenance holds the ledger rows, evidence cells and the exact Zetaris queries. The next investigation recalls it first and shows "Remembered from BB-0417". Code: `server/engines/hmem.ts`.
- **Tests:** `server/engines/hmem.test.ts`. A fresh instance recalls the persisted finding with its ledger rows and queries; nothing is recalled before a finding is signed.

### Nightshift: the app's primary AI provider

- Black Box talks to the Meterless Runtime at `127.0.0.1:8088/v1` (OpenAI-compatible), implemented from the official Power Prompt in `server/ai/provider.ts`. The runtime token is read from Nightshift's runtime-token file; the NVIDIA key lives only in Nightshift → Providers.
- Every reply's **compute receipt** is kept: routed model, cache status, cost. The UI and the run traces show which model handled each request, and replies served from Nightshift's exact cache are labelled "cache".
- Calls stream, because Nightshift ends non-streamed calls that reason for longer than about 45 s. A run-out (`_empty_response`) or a cut-off is typed as `BudgetExhausted`, which drives the thinking-budget ladder.
- **Tests:** `server/ai/provider.test.ts` (19 tests: headers, receipts, streaming, rate-limit retries, budget exhaustion).

## NVIDIA: Nemotron does the reasoning, and its budget is visible

- **Model:** NVIDIA Nemotron 3.5 Lightning (`nvidia/nemotron-3.5-lightning-30b-a3b`), through Nightshift, on lane 1.
- **Where it contributes:** the refund agent itself (the culprit), the **Root-Cause** agent (names the cause and cites evidence), the **Skeptic** (verdict per claim) and the **Counterpart** (cross-examination questions and RCA's answers).
- **The thinking budget:** Nemotron always reasons before it answers, so `max_tokens` is the real thinking budget. A call that runs out climbs a ladder (2,048 → 4,096 → 8,192 tokens), and every refutation makes the next Skeptic round start a rung higher. The meter in the UI says why the budget rose; the recorded run shows both kinds of climb.
- Every trace line names the model that answered (`routed_model` from the Nightshift receipt).

## Cursor (with Space XAI)

Not used. Cursor became optional on 22 Oct (HackOS announcement; Official Rules §8.1). Black Box was built with Claude Code.

## What was unique about our use of the sponsor technologies

- **Zetaris is the evidence, not a data source behind a chatbot.** Every claim in the ledger carries the Zetaris queries behind it, and a second agent re-runs them before the claim is allowed to stand.
- **The World Model is the flight recorder.** The answer to "which policy was live at that moment" is the engine's own point-in-time fold over the event log, not a field we set. The same engine records the human's signature on the fix.
- **Nemotron's reasoning budget is part of the product.** The budget rises when Nemotron runs out and when the Skeptic refutes a claim, and the UI shows why: the cost of being sceptical is visible.
- **The fix is proven against the real failure.** The Airlock replays the 40 bad requests through the real Nemotron refund agent with the signed guardrail in front of the payout tool: the agent still says "approve" 40 times, and the guardrail pays 0.
