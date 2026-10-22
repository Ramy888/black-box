import { describe, expect, it } from "vitest";
import { BANDS, generateScenario, INCIDENT_AT, toCsv } from "./generate.ts";

const ageDays = (d: Date) => (INCIDENT_AT.getTime() - d.getTime()) / 86_400_000;

describe("scenario", () => {
  it("is deterministic for a seed", () => {
    expect(generateScenario(417)).toEqual(generateScenario(417));
  });

  it("plants exactly 40 requests that only the stale 30-day policy would approve", () => {
    const s = generateScenario();
    const ages = s.refundRequests.map((r) => ageDays(s.orders.find((o) => o.id === r.order_id)!.delivered_at));
    expect(ages.filter((a) => a > 14 && a <= 30)).toHaveLength(BANDS.stalePolicy);
    expect(ages.filter((a) => a <= 14)).toHaveLength(BANDS.inPolicy);
    expect(ages.filter((a) => a > 30)).toHaveLength(BANDS.tooOld);
  });

  it("has no duplicate payment refs, so the duplicate-ID rumour is false", () => {
    const refs = generateScenario().payments.map((p) => p.provider_ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("has exactly one live policy version: 14 days", () => {
    const live = generateScenario().policyVersions.filter((p) => p.valid_to === null);
    expect(live).toEqual([expect.objectContaining({ version: 2, max_return_days: 14 })]);
  });

  it("quotes CSV fields that contain commas or quotes", () => {
    expect(toCsv([{ a: 'x, "y"', b: 1 }])).toBe('a,b\n"x, ""y""",1\n');
  });
});
