import { describe, expect, it } from "vitest";
import { parseDecision, STALE_POLICY } from "./agent.ts";

describe("refund agent", () => {
  it("still carries the stale 30-day policy (the planted bug)", () => {
    expect(STALE_POLICY).toContain("30 days");
  });

  it("reads the decision JSON even with text around it", () => {
    expect(parseDecision('Sure. {"decision":"approve","reason":"within 30 days"} done')).toEqual({ decision: "approve", reason: "within 30 days" });
  });

  it("denies when the reply is not valid JSON", () => {
    expect(parseDecision("I think yes").decision).toBe("deny");
  });

  it("treats any unknown decision value as deny", () => {
    expect(parseDecision('{"decision":"maybe"}').decision).toBe("deny");
  });
});
