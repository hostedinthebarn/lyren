// Port of the Python tests/test_engine.py, test for test, plus the TypeScript-only checks at the end.
import { describe, expect, it } from "vitest";
import {
  bradleyTerry,
  comparison as C,
  dedupe,
  determined,
  nextPair,
  pairKey,
  rank,
  withoutPair,
} from "../../src/ranking-core/engine";
import { itemsOf, run, shuffledOrder, truthOf } from "./harness";
import { PyRandom } from "./pyrandom";

describe("ranking engine (ported from Python)", () => {
  it("full round robin recovers a known order", () => {
    const items = ["a", "b", "c", "d", "e"];
    const cs = items.flatMap((x, i) => items.slice(i + 1).map((y) => C(x, y, x)));
    expect(rank(items, cs).order).toEqual(items);
  });

  it("undefeated and winless items stay finite and ordered", () => {
    const s = bradleyTerry(["a", "b", "c"], [C("a", "b", "a"), C("b", "c", "b")]);
    expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
    expect(s.get("b")!).toBeGreaterThan(s.get("c")!);
    for (const v of s.values()) expect(Math.abs(v)).toBeLessThan(20);
  });

  it("cyclic data still ranks every item, no crash", () => {
    const items = ["a", "b", "c", "d"];
    const cs = [C("a", "d", "a"), C("a", "c", "a"), C("b", "a", "b"), C("c", "d", "c"), C("d", "b", "d")];
    const r = rank(items, cs);
    expect(new Set(r.order)).toEqual(new Set(items));
    expect(r.order).toHaveLength(items.length);
  });

  it("a tie is half a win", () => {
    const s = bradleyTerry(["a", "b"], [C("a", "b", null)]);
    expect(Math.abs(s.get("a")! - s.get("b")!)).toBeLessThan(1e-9);
  });

  it("a repeated pair overrides the earlier answer, and withoutPair undoes it", () => {
    const cs = [C("a", "b", "a"), C("b", "a", "b")];
    expect(dedupe(cs).map((c) => c.winner)).toEqual(["b"]);
    expect(withoutPair(cs, "a", "b")).toEqual([]);
  });

  it("a transitive pair is not asked", () => {
    const cs = [C("a", "b", "a"), C("b", "c", "b")];
    expect(determined(["a", "b", "c"], cs, "a", "c")).toBe(true);
    expect(nextPair(["a", "b", "c"], cs)).toBeNull();
  });

  it("nextPair is null for a single item", () => {
    expect(nextPair(["a"], [])).toBeNull();
  });

  it("adaptive questions recover a hidden order", () => {
    const items = itemsOf(20);
    const truth = truthOf(new PyRandom(1).sample(items, 20));
    const { ranking, questions } = run(items, truth);
    expect(ranking.order).toEqual([...items].sort((x, y) => truth.get(x)! - truth.get(y)!));
    expect(questions).toBeLessThan(190); // fewer than n(n-1)/2
  });

  it("twenty items stay within the question budget", () => {
    // Measured, see scripts/measure.ts: mean ~62 on noiseless answers.
    const qs: number[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const order = shuffledOrder(20, seed);
      const { ranking, questions } = run(itemsOf(20), truthOf(order));
      expect(ranking.order).toEqual(order);
      qs.push(questions);
    }
    expect(qs.reduce((x, y) => x + y, 0) / qs.length).toBeLessThanOrEqual(70);
  });

  it("noisy answers terminate and mostly agree", () => {
    const items = itemsOf(20);
    const truth = truthOf(items);
    const { ranking, questions } = run(items, truth, { noise: 0.1, seed: 3 });
    expect(questions).toBeLessThanOrEqual(190);
    const pos = new Map(ranking.order.map((it, k) => [it, k]));
    const meanShift = items.reduce((acc, i) => acc + Math.abs(pos.get(i)! - truth.get(i)!), 0) / 20;
    expect(meanShift).toBeLessThan(3);
  });
});

describe("TypeScript-only checks", () => {
  it("comparison() rejects a self-comparison and a stray winner", () => {
    expect(() => C("a", "a")).toThrow(RangeError);
    expect(() => C("a", "b", "c")).toThrow(RangeError);
    expect(C("a", "b").winner).toBeNull();
  });

  it("pairKey is unordered and tells numbers from strings", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
    expect(pairKey(1, 2)).not.toBe(pairKey("1", "2"));
    expect(pairKey("a,b", "c")).not.toBe(pairKey("a", "b,c"));
  });

  it("works with numeric ids", () => {
    const r = rank([1, 2, 3], [C(3, 1, 3), C(1, 2, 1)]);
    expect(r.order).toEqual([3, 1, 2]);
  });

  it("scores run 0-100, 50 for no answers, and higher for the winner", () => {
    expect(rank(["a", "b"], []).scores.get("a")).toBe(50);
    const r = rank(["a", "b"], [C("a", "b", "a")]);
    expect(r.scores.get("a")!).toBeGreaterThan(50);
    expect(r.scores.get("b")!).toBeLessThan(50);
    expect(r.compared.get("a")).toBe(1);
  });

  it("ignores comparisons naming items not in the list", () => {
    const r = rank(["a", "b"], [C("a", "z", "z"), C("a", "b", "b")]);
    expect(r.order).toEqual(["b", "a"]);
  });

  it("the Python random port reproduces CPython's streams", () => {
    // Reference values from CPython 3: random.Random(seed) with these calls.
    const r0 = new PyRandom(0);
    const l = Array.from({ length: 20 }, (_, k) => k);
    r0.shuffle(l);
    expect(l).toEqual([10, 18, 16, 14, 0, 17, 11, 2, 3, 9, 5, 7, 4, 19, 6, 15, 8, 1, 13, 12]);
    expect(r0.random()).toBe(0.3101475693193326);
    expect(new PyRandom(1).sample(Array.from({ length: 20 }, (_, k) => k), 20)).toEqual([
      4, 18, 2, 8, 3, 7, 12, 14, 13, 10, 6, 15, 1, 16, 0, 9, 19, 17, 5, 11,
    ]);
    const r2 = new PyRandom(12345);
    expect([r2.getrandbits(32), r2.getrandbits(32), r2.getrandbits(32)]).toEqual([1789368711, 3146859322, 43676229]);
    expect(r2.random()).toBe(0.8201747225612886);
  });
});
