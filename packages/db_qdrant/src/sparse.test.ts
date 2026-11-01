import { expect, test, describe } from "bun:test";
import { sparseEncode } from "./sparse.ts";

describe("sparseEncode", () => {
  test("empty / stopword-only text → empty sparse vector", () => {
    expect(sparseEncode("")).toEqual({ indices: [], values: [] });
    expect(sparseEncode("the and of to")).toEqual({ indices: [], values: [] });
  });

  test("parallel indices/values arrays of equal length", () => {
    const v = sparseEncode("progressive overload drives hypertrophy");
    expect(v.indices.length).toBe(v.values.length);
    expect(v.indices.length).toBeGreaterThan(0);
  });

  test("repeated terms accumulate term frequency", () => {
    const v = sparseEncode("protein protein protein");
    expect(v.indices).toHaveLength(1);
    expect(v.values[0]).toBe(3);
  });

  test("deterministic across calls", () => {
    const a = sparseEncode("creatine monohydrate 5 g per day");
    const b = sparseEncode("creatine monohydrate 5 g per day");
    expect(a).toEqual(b);
  });

  test("keeps numeric tokens (dosages matter)", () => {
    const v = sparseEncode("1.6 g/kg protein");
    // "1", "6", "g", "kg", "protein" → at least the digits survive.
    expect(v.indices.length).toBeGreaterThanOrEqual(4);
  });

  test("different text → different token sets", () => {
    const a = sparseEncode("sleep recovery");
    const b = sparseEncode("hydration performance");
    expect(a.indices).not.toEqual(b.indices);
  });
});
