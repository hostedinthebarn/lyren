import { comparison, nextPair, rank, type Comparison, type Ranking } from "../../src/ranking-core/engine";
import { PyRandom } from "./pyrandom";

/**
 * Drive the engine against a hidden order: truth maps each item to its true
 * position (lower = better). With `noise`, each answer is flipped with that
 * probability. Returns the final ranking and the number of questions asked.
 * Same as `run` in the Python tests, including its random stream.
 */
export function run(
  items: readonly string[],
  truth: ReadonlyMap<string, number>,
  { noise = 0, seed = 0, cap = 10_000 }: { noise?: number; seed?: number; cap?: number } = {},
): { ranking: Ranking<string>; questions: number } {
  const rnd = new PyRandom(seed);
  const cs: Comparison<string>[] = [];
  let q = 0;
  while (q < cap) {
    const pair = nextPair(items, cs);
    if (pair === null) break;
    const [a, b] = pair;
    let w = truth.get(a)! < truth.get(b)! ? a : b;
    if (rnd.random() < noise) w = w === a ? b : a;
    cs.push(comparison(a, b, w));
    q++;
  }
  return { ranking: rank(items, cs), questions: q };
}

export function itemsOf(n: number): string[] {
  return Array.from({ length: n }, (_, k) => `i${k}`);
}

export function truthOf(order: readonly string[]): Map<string, number> {
  return new Map(order.map((it, k) => [it, k]));
}

/** The order used by the Python tests and measure.py for this seed. */
export function shuffledOrder(n: number, seed: number): string[] {
  const order = itemsOf(n);
  new PyRandom(seed).shuffle(order);
  return order;
}
