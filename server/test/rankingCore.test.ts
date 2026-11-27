import { describe, expect, it } from 'vitest';
import { nextPair, rank, type Answer } from '../src/ranking-core';

// A seeded shuffle, so the runs repeat.
function shuffled(n: number, seed: number): number[] {
  let s = seed;
  const next = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const a = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Ask until nothing is left, answering from `truth` (index 0 = best); the answers and the question count. */
function run(truth: number[], wrong = (_n: number) => false) {
  const items = [...truth].sort((a, b) => a - b);
  const pos = new Map(truth.map((id, i) => [id, i]));
  const answers: Answer[] = [];
  let asked = 0;
  for (;;) {
    const pair = nextPair(items, answers);
    if (!pair) break;
    const [a, b] = pair;
    const better = pos.get(a)! < pos.get(b)! ? a : b;
    answers.push({ a, b, winner: wrong(asked) ? (better === a ? b : a) : better });
    asked++;
    if (asked > 1000) throw new Error('does not stop');
  }
  return { items, answers, asked };
}

describe('ranking-core', () => {
  it('finds a known order of 5 items', () => {
    const truth = [3, 1, 5, 2, 4];
    const { items, answers } = run(truth);
    expect(rank(items, answers).map((r) => r.id)).toEqual(truth);
  });

  it('finds known orders of 10 items for several shuffles, in far fewer questions than every pair', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const truth = shuffled(10, seed);
      const { items, answers, asked } = run(truth);
      expect(rank(items, answers).map((r) => r.id)).toEqual(truth);
      expect(asked).toBeLessThan(45);
    }
  });

  it('keeps 20 items well under every pair (190)', () => {
    let total = 0;
    for (let seed = 1; seed <= 10; seed++) total += run(shuffled(20, seed)).asked;
    expect(total / 10).toBeLessThan(80); // the information floor is about 61
  });

  it('never asks a pair whose order follows from earlier answers', () => {
    const answers: Answer[] = [
      { a: 1, b: 2, winner: 1 },
      { a: 2, b: 3, winner: 2 },
    ];
    expect(nextPair([1, 2, 3], answers)).toBeNull();
  });

  it('returns null for one item and for none', () => {
    expect(nextPair([1], [])).toBeNull();
    expect(nextPair([], [])).toBeNull();
  });

  it('lets a repeated pair override the earlier answer (the undo)', () => {
    const items = [1, 2];
    const first: Answer[] = [{ a: 1, b: 2, winner: 1 }];
    expect(rank(items, first).map((r) => r.id)).toEqual([1, 2]);
    const again = [...first, { a: 2, b: 1, winner: 2 }];
    expect(rank(items, again).map((r) => r.id)).toEqual([2, 1]);
  });

  it('counts a tie as asked, with no order implied', () => {
    const items = [1, 2, 3];
    const answers: Answer[] = [{ a: 1, b: 2, winner: null }];
    const pair = nextPair(items, answers);
    expect(pair).not.toBeNull();
    expect(pair).not.toEqual([1, 2]);
    const r = rank(items, answers);
    expect(r.find((x) => x.id === 1)!.ties).toBe(1);
  });

  it('ignores answers about unknown items and nonsense winners', () => {
    const r = rank([1, 2], [{ a: 1, b: 9, winner: 9 }, { a: 1, b: 2, winner: 7 }]);
    expect(r.every((x) => x.wins === 0 && x.losses === 0)).toBe(true);
  });

  it('survives contradictory answers (a cycle) and still stops', () => {
    const answers: Answer[] = [
      { a: 1, b: 2, winner: 1 },
      { a: 2, b: 3, winner: 2 },
      { a: 3, b: 1, winner: 3 },
    ];
    expect(nextPair([1, 2, 3], answers)).toBeNull();
    expect(rank([1, 2, 3], answers)).toHaveLength(3);
  });

  it('stops with wrong answers mixed in', () => {
    const { asked } = run(shuffled(20, 7), (n) => n % 10 === 3);
    expect(asked).toBeLessThan(190);
  });

  it('can leave deleted items out of the questions but keep them in the ranking', () => {
    const answers: Answer[] = [{ a: 1, b: 2, winner: 2 }];
    expect(nextPair([1, 2, 3], answers, [1, 3])).toEqual([1, 3]);
    expect(rank([1, 2, 3], answers).map((r) => r.id)[0]).toBe(2);
  });

  it('gives scores between 0 and 100, falling with position (the engine maps strength through a logistic)', () => {
    const { items, answers } = run([1, 2, 3, 4]);
    const r = rank(items, answers);
    for (const x of r) {
      expect(x.score).toBeGreaterThan(0);
      expect(x.score).toBeLessThan(100);
    }
    for (let i = 1; i < r.length; i++) expect(r[i]!.score).toBeLessThan(r[i - 1]!.score);
  });
});
