import { describe, expect, test } from "bun:test";
import { pickTurnTier } from "./agent.ts";

const tagged = (msg: string) =>
  `[State: date=2026-10-20 · language=en]\n[Today: 2026-10-20]\n\n${msg}`;

describe("pickTurnTier", () => {
  test.each([
    "checkout my actrive workout plan and latest porpotions tell me if you feel like its enough",
    "should I bulk or cut?",
    "why am I not losing weight",
    "build me a 4 day split",
    "is my protein enough",
    "compare my plan to my measurements",
    "τι λες για το πρόγραμμά μου;",
    "πρέπει να φάω περισσότερο;",
  ])("deep: %s", (msg) => {
    expect(pickTurnTier(tagged(msg))).toBe("deep");
  });

  test.each([
    "log 200g chicken breast",
    "what's left today",
    "add 40g oats to breakfast",
    "hi",
    "show my plan",
    "I weighed 82.4 this morning",
    "έφαγα 2 αυγά",
  ])("fast: %s", (msg) => {
    expect(pickTurnTier(tagged(msg))).toBe("fast");
  });

  test("context tags alone never make a turn deep", () => {
    // "plan" in the State tag must not trip the matcher.
    expect(pickTurnTier('[State: workout plan "Program for strength"]\n\nhi')).toBe("fast");
  });

  test("photos and long messages go deep", () => {
    expect(
      pickTurnTier([
        { kind: "text", text: "[Today: 2026-10-20]" },
        { kind: "image", source: { kind: "url", url: "https://x/y.jpg" } },
      ]),
    ).toBe("deep");
    expect(pickTurnTier("x ".repeat(200))).toBe("deep");
  });

  test("LLM_TIERING=off sends everything deep", () => {
    process.env.LLM_TIERING = "off";
    try {
      expect(pickTurnTier("log 200g rice")).toBe("deep");
    } finally {
      delete process.env.LLM_TIERING;
    }
  });
});
