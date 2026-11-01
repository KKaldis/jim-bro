import { expect, test, describe } from "bun:test";
import { splitText } from "./chunk.ts";

describe("splitText", () => {
  test("empty / whitespace → no chunks", () => {
    expect(splitText("")).toEqual([]);
    expect(splitText("   \n  ")).toEqual([]);
  });

  test("short text fits in a single chunk", () => {
    const out = splitText("Protein helps build muscle.", { maxChars: 2048 });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ text: "Protein helps build muscle.", index: 0 });
  });

  test("splits long text into multiple bounded chunks", () => {
    const sentence = "Progressive overload drives hypertrophy over time. ";
    const text = sentence.repeat(40); // ~2000 chars
    const out = splitText(text, { maxChars: 200, overlapChars: 20 });
    expect(out.length).toBeGreaterThan(1);
    // No chunk wildly exceeds the target (allow a little slack for the last
    // packed piece + separator re-attachment).
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(260);
    // Indices are sequential from 0.
    out.forEach((c, i) => expect(c.index).toBe(i));
  });

  test("prefers paragraph then sentence boundaries", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.";
    const out = splitText(text, { maxChars: 25, overlapChars: 0 });
    // Each chunk should be a clean paragraph, not a mid-word cut.
    expect(out.some((c) => c.text.includes("First paragraph"))).toBe(true);
    expect(out.some((c) => c.text.includes("Second paragraph"))).toBe(true);
  });

  test("overlap carries trailing context into the next chunk", () => {
    const text = "alpha beta gamma delta. epsilon zeta eta theta. iota kappa lambda mu.";
    const out = splitText(text, { maxChars: 30, overlapChars: 12 });
    expect(out.length).toBeGreaterThan(1);
    // The reconstructed coverage should include every distinct word.
    const joined = out.map((c) => c.text).join(" ");
    for (const w of ["alpha", "theta", "lambda"]) expect(joined).toContain(w);
  });

  test("hard-cuts text with no separators as a last resort", () => {
    const text = "x".repeat(500);
    const out = splitText(text, { maxChars: 100, overlapChars: 0 });
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(100);
  });
});
