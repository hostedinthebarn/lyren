/**
 * Pairwise ranking: Bradley-Terry scores and adaptive pair selection.
 *
 * Pure functions over plain data. No I/O, no clock, no runtime dependencies.
 * Ported from the Python `ranking_core` (HL-4), which replaced the HA prioritization
 * plugin (v0.2.0). That plugin scored wins / total_compared and offered every one of
 * the n(n-1)/2 pairs.
 *
 * A comparison is (a, b, winner). winner is a or b, or null for a tie ("equal").
 * A repeated pair overrides the earlier answer (same rule as the HA plugin), which
 * doubles as undo: re-record the pair, or drop it with `withoutPair`.
 */

/** An item is identified by a primitive id, compared with `===` (as Map keys are). */
export type Item = string | number;

export interface Comparison<T extends Item = Item> {
  readonly a: T;
  readonly b: T;
  /** a, b, or null for a tie. */
  readonly winner: T | null;
}

export interface Ranking<T extends Item = Item> {
  /** Best first. Known order first, then strength, then comparison count, then input order. */
  readonly order: T[];
  /** 0-100 display score: the log-strength mapped through a logistic, one decimal. */
  readonly scores: Map<T, number>;
  /** Bradley-Terry log-strength, mean 0. */
  readonly strengths: Map<T, number>;
  /** How many (deduplicated) comparisons each item has been in. */
  readonly compared: Map<T, number>;
}

export interface BradleyTerryOptions {
  /** Half-win-half-loss games against a virtual average opponent, added to every item. */
  prior?: number;
  iterations?: number;
  tol?: number;
}

/** Build a comparison, rejecting self-comparisons and a winner that isn't a, b or null. */
export function comparison<T extends Item>(a: T, b: T, winner: T | null = null): Comparison<T> {
  if (a === b) throw new RangeError("cannot compare an item with itself");
  if (winner !== null && winner !== a && winner !== b) throw new RangeError("winner must be a, b or null");
  return Object.freeze({ a, b, winner });
}

function itemKey(x: Item): string {
  return `${typeof x}:${String(x)}`;
}

/** The unordered pair {a, b} as a string key, the same for (a, b) and (b, a). */
export function pairKey(a: Item, b: Item): string {
  const ka = itemKey(a);
  const kb = itemKey(b);
  return JSON.stringify(ka < kb ? [ka, kb] : [kb, ka]);
}

/** Keep the latest answer per pair, in the order the latest answers were given. */
export function dedupe<T extends Item>(comparisons: Iterable<Comparison<T>>): Comparison<T>[] {
  const latest = new Map<string, Comparison<T>>();
  for (const c of comparisons) {
    const k = pairKey(c.a, c.b);
    latest.delete(k);
    latest.set(k, c);
  }
  return [...latest.values()];
}

/** Every comparison except those of the pair {a, b}: the undo. */
export function withoutPair<T extends Item>(comparisons: Iterable<Comparison<T>>, a: T, b: T): Comparison<T>[] {
  const k = pairKey(a, b);
  return [...comparisons].filter((c) => pairKey(c.a, c.b) !== k);
}

function countCompared<T extends Item>(items: readonly T[], cs: readonly Comparison<T>[]): Map<T, number> {
  const cnt = new Map<T, number>(items.map((it) => [it, 0]));
  for (const c of cs) {
    const ca = cnt.get(c.a);
    if (ca !== undefined) cnt.set(c.a, ca + 1);
    const cb = cnt.get(c.b);
    if (cb !== undefined) cnt.set(c.b, cb + 1);
  }
  return cnt;
}

/**
 * Log-strengths (mean 0) by minorise-maximise.
 *
 * `prior` adds that many half-win-half-loss games against a virtual average
 * opponent to every item. It keeps undefeated and winless items finite and
 * makes the fit unique, so a handful of answers never produces infinities.
 * Ties count as half a win each.
 */
export function bradleyTerry<T extends Item>(
  items: readonly T[],
  comparisons: Iterable<Comparison<T>>,
  { prior = 0.5, iterations = 200, tol = 1e-9 }: BradleyTerryOptions = {},
): Map<T, number> {
  const idx = new Map<T, number>();
  items.forEach((it, i) => idx.set(it, i));
  const n = items.length;
  const wins: number[] = new Array<number>(n).fill(prior * 0.5);
  const games: [number, number][][] = Array.from({ length: n }, () => []); // (opponent, count)
  const pairN = new Map<string, [number, number, number]>(); // "i,j" -> [i, j, count]
  for (const c of dedupe(comparisons)) {
    const i = idx.get(c.a);
    const j = idx.get(c.b);
    if (i === undefined || j === undefined) continue;
    if (c.winner === null) {
      wins[i]! += 0.5;
      wins[j]! += 0.5;
    } else if (c.winner === c.a) {
      wins[i]! += 1.0;
    } else {
      wins[j]! += 1.0;
    }
    const k = `${i},${j}`;
    const prev = pairN.get(k);
    pairN.set(k, [i, j, (prev?.[2] ?? 0) + 1]);
  }
  for (const [i, j, m] of pairN.values()) {
    games[i]!.push([j, m]);
    games[j]!.push([i, m]);
  }

  let p: number[] = new Array<number>(n).fill(1.0);
  for (let it = 0; it < iterations; it++) {
    const next: number[] = [];
    for (let i = 0; i < n; i++) {
      const pi = p[i]!;
      let denom = prior / (pi + 1.0); // virtual opponent of strength 1
      for (const [j, m] of games[i]!) denom += m / (pi + p[j]!);
      next.push(denom > 0 ? wins[i]! / denom : pi);
    }
    // normalise to geometric mean 1
    let logSum = 0;
    for (const x of next) logSum += Math.log(x);
    const g = n ? Math.exp(logSum / n) : 1.0;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] = next[i]! / g;
      delta = Math.max(delta, Math.abs(Math.log(next[i]!) - Math.log(p[i]!)));
    }
    p = next;
    if (delta < tol) break;
  }
  const out = new Map<T, number>();
  for (const [itm, i] of idx) out.set(itm, Math.log(p[i]!));
  return out;
}

/**
 * beats(x) = every item x is known to rank above, by chaining answers.
 * Ties are no information for chaining (they never imply an order).
 * A contradiction (a cycle) is handled by ignoring the back edge.
 */
function closure<T extends Item>(items: readonly T[], comparisons: Iterable<Comparison<T>>): Map<T, Set<T>> {
  const beats = new Map<T, Set<T>>(items.map((it) => [it, new Set<T>()]));
  for (const c of dedupe(comparisons)) {
    if (c.winner === null || !beats.has(c.a) || !beats.has(c.b)) continue;
    const loser = c.winner === c.a ? c.b : c.a;
    beats.get(c.winner)!.add(loser);
  }
  const memo = new Map<T, Set<T>>();
  const reach = (x: T, stack: ReadonlySet<T>): Set<T> => {
    const hit = memo.get(x);
    if (hit) return hit;
    const out = new Set<T>();
    const inner = new Set(stack).add(x);
    for (const y of beats.get(x)!) {
      if (stack.has(y) || y === x) continue;
      out.add(y);
      for (const z of reach(y, inner)) out.add(z);
    }
    memo.set(x, out);
    return out;
  };
  const result = new Map<T, Set<T>>();
  for (const x of beats.keys()) result.set(x, reach(x, new Set()));
  return result;
}

/** True if the order of a and b is already implied by the answers so far. */
export function determined<T extends Item>(
  items: readonly T[],
  comparisons: Iterable<Comparison<T>>,
  a: T,
  b: T,
): boolean {
  const cs = [...comparisons];
  const k = pairKey(a, b);
  if (dedupe(cs).some((c) => pairKey(c.a, c.b) === k)) return true;
  const cl = closure(items, cs);
  return Boolean(cl.get(a)?.has(b) || cl.get(b)?.has(a));
}

/**
 * The most useful question to ask next, or null when the order is settled.
 *
 * Skips any pair whose order already follows from earlier answers (a>b, b>c
 * makes a>c free), which is what brings the count down from n(n-1)/2 to
 * roughly n log n. Among the open pairs it prefers the one whose current
 * strengths are closest (the most uncertain), then the least-asked items,
 * then the earliest in the list.
 */
export function nextPair<T extends Item>(
  items: readonly T[],
  comparisons: Iterable<Comparison<T>>,
): [T, T] | null {
  const cs = dedupe(comparisons);
  if (items.length < 2) return null;
  const cl = closure(items, cs);
  const asked = new Set(cs.map((c) => pairKey(c.a, c.b)));
  const cnt = countCompared(items, cs);
  const s = bradleyTerry(items, cs);
  let best: [T, T] | null = null;
  let bestKey: [number, number, number] | null = null;
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (asked.has(pairKey(a, b)) || cl.get(a)!.has(b) || cl.get(b)!.has(a)) continue;
      const key: [number, number, number] = [Math.abs(s.get(a)! - s.get(b)!), cnt.get(a)! + cnt.get(b)!, i];
      if (bestKey === null || lexLess(key, bestKey)) {
        bestKey = key;
        best = [a, b];
      }
    }
  }
  return best;
}

function lexLess(x: readonly number[], y: readonly number[]): boolean {
  for (let i = 0; i < x.length; i++) {
    if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  }
  return false;
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Rank the items. Known order first (items beaten minus items beaten by, via
 * chained answers), so a settled ranking always matches the answers; then BT
 * strength, then comparison count, then input order.
 */
export function rank<T extends Item>(items: readonly T[], comparisons: Iterable<Comparison<T>>): Ranking<T> {
  const list = [...items];
  const cs = dedupe(comparisons);
  const s = bradleyTerry(list, cs);
  const cnt = countCompared(list, cs);
  const pos = new Map<T, number>();
  list.forEach((it, i) => pos.set(it, i));
  const cl = closure(list, cs);
  const above = new Map<T, number>(list.map((it) => [it, 0]));
  for (const x of list) for (const y of cl.get(x)!) above.set(y, above.get(y)! + 1);
  const net = new Map<T, number>(list.map((x) => [x, cl.get(x)!.size - above.get(x)!]));
  const sortKey = (x: T): number[] => [-net.get(x)!, -round(s.get(x)!, 9), -cnt.get(x)!, pos.get(x)!];
  const order = [...list].sort((x, y) => {
    const kx = sortKey(x);
    const ky = sortKey(y);
    return lexLess(kx, ky) ? -1 : lexLess(ky, kx) ? 1 : 0;
  });
  const scores = new Map<T, number>(list.map((it) => [it, round(100.0 / (1.0 + Math.exp(-s.get(it)!)), 1)]));
  return { order, scores, strengths: s, compared: cnt };
}
