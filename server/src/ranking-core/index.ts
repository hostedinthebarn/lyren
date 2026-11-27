// Pairwise ranking engine for Lyren: a thin adapter over engine.ts, which is which-first's
// packages/ranking-core/src/engine.ts copied verbatim (see README.md for the commit). Keep engine.ts
// byte-identical to the source so a resync is a plain copy; Lyren's needs live here.
//
// What the adapter adds:
//  - Answers about unknown items, self-pairs and nonsense winners are dropped before the engine sees them
//    (the engine assumes clean input and would throw on a winner it doesn't know).
//  - nextPair can be limited to some items (`askAbout`), for a set whose deleted tasks stay in the result but
//    are no longer asked about. Only answers between those items count for the next question.
//  - rank returns one row per item with its position, score and win/loss/tie counts.

import { comparison, dedupe, nextPair as engineNextPair, rank as engineRank, type Comparison } from './engine';

/** One answer: `winner` is `a`, `b`, or null for a tie. The order of a and b does not matter. */
export interface Answer {
  a: number;
  b: number;
  winner: number | null;
}

export interface RankedItem {
  id: number;
  /** 1 = first. Every item has its own position. */
  position: number;
  /** 0-100 display score (the engine's logistic of the Bradley-Terry strength). */
  score: number;
  wins: number;
  losses: number;
  ties: number;
}

/** The answers usable for these items, as engine comparisons, latest answer per pair. */
function clean(items: ReadonlySet<number>, answers: readonly Answer[]): Comparison<number>[] {
  const out: Comparison<number>[] = [];
  for (const x of answers) {
    if (x.a === x.b || !items.has(x.a) || !items.has(x.b)) continue;
    if (x.winner !== null && x.winner !== x.a && x.winner !== x.b) continue;
    out.push(comparison(x.a, x.b, x.winner));
  }
  return dedupe(out);
}

/**
 * The next pair to ask, or null when the order is settled. `askAbout` limits the question to those items
 * (default: all); items are taken in ascending id order so the choice is stable.
 */
export function nextPair(
  items: readonly number[],
  answers: readonly Answer[],
  askAbout: readonly number[] = items,
): [number, number] | null {
  const known = new Set(items);
  const ask = [...new Set(askAbout)].filter((id) => known.has(id)).sort((x, y) => x - y);
  return engineNextPair(ask, clean(new Set(ask), answers));
}

/** Every item in order, best first, as the engine ranks them (input in ascending id order). */
export function rank(items: readonly number[], answers: readonly Answer[]): RankedItem[] {
  const ids = [...new Set(items)].sort((x, y) => x - y);
  const cs = clean(new Set(ids), answers);
  const result = engineRank(ids, cs);
  const stat = new Map(ids.map((id) => [id, { wins: 0, losses: 0, ties: 0 }]));
  for (const c of cs) {
    if (c.winner === null) {
      stat.get(c.a)!.ties++;
      stat.get(c.b)!.ties++;
    } else {
      stat.get(c.winner)!.wins++;
      stat.get(c.winner === c.a ? c.b : c.a)!.losses++;
    }
  }
  return result.order.map((id, i) => ({ id, position: i + 1, score: result.scores.get(id)!, ...stat.get(id)! }));
}
