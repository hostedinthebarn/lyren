// Pairwise ranking engine: Bradley-Terry with adaptive pair selection. Pure: no I/O, no Lyren imports.
// See README.md in this folder: this is a re-implementation of which-first's packages/ranking-core, not a
// verbatim copy, until Primary swaps in the real files.

/** One answer: `winner` is `a`, `b`, or null for a tie. The order of a and b does not matter. */
export interface Answer {
  a: number;
  b: number;
  winner: number | null;
}

export interface RankedItem {
  id: number;
  /** 1 = first. Every item has its own position, ties in strength broken by id. */
  position: number;
  /** 0-100 display score, from the strengths. */
  score: number;
  wins: number;
  losses: number;
  ties: number;
}

const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** The answers about items we know, one per unordered pair: a later answer replaces an earlier one. */
export function dedupe(items: readonly number[], answers: readonly Answer[]): Answer[] {
  const known = new Set(items);
  const byPair = new Map<string, Answer>();
  for (const x of answers) {
    if (x.a === x.b || !known.has(x.a) || !known.has(x.b)) continue;
    if (x.winner !== null && x.winner !== x.a && x.winner !== x.b) continue;
    byPair.set(key(x.a, x.b), x);
  }
  return [...byPair.values()];
}

/** beats[i][j]: item i is above item j by a chain of decisive answers (transitive closure). */
function closure(n: number, index: Map<number, number>, answers: readonly Answer[]): boolean[][] {
  const beats = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (const x of answers) {
    if (x.winner === null) continue;
    const w = index.get(x.winner)!;
    const l = index.get(x.winner === x.a ? x.b : x.a)!;
    beats[w]![l] = true;
  }
  for (let k = 0; k < n; k++) {
    const bk = beats[k]!;
    for (let i = 0; i < n; i++) {
      if (!beats[i]![k]) continue;
      const bi = beats[i]!;
      for (let j = 0; j < n; j++) if (bk[j]) bi[j] = true;
    }
  }
  return beats;
}

/** Log-strengths by Bradley-Terry MM iteration; a virtual opponent of strength 1 keeps them finite. */
function logStrengths(n: number, index: Map<number, number>, answers: readonly Answer[]): number[] {
  const wins = new Array<number>(n).fill(0.5); // half a win against the virtual opponent
  const games: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const tally = new Map<string, [number, number, number]>();
  for (const x of answers) {
    const i = index.get(x.a)!;
    const j = index.get(x.b)!;
    if (x.winner === null) {
      wins[i]! += 0.5;
      wins[j]! += 0.5;
    } else wins[index.get(x.winner)!]! += 1;
    tally.set(`${i}:${j}`, [i, j, 1]);
  }
  for (const [i, j] of tally.values()) {
    games[i]!.push([j, 1]);
    games[j]!.push([i, 1]);
  }
  let p = new Array<number>(n).fill(1);
  for (let iter = 0; iter < 200; iter++) {
    const next = p.map((pi, i) => {
      let denom = 1 / (pi + 1); // the virtual game
      for (const [j, c] of games[i]!) denom += c / (pi + p[j]!);
      return wins[i]! / denom;
    });
    const mean = Math.exp(next.reduce((s, v) => s + Math.log(v), 0) / n);
    const normalized = next.map((v) => v / mean);
    const delta = Math.max(...normalized.map((v, i) => Math.abs(Math.log(v) - Math.log(p[i]!))));
    p = normalized;
    if (delta < 1e-9) break;
  }
  return p.map(Math.log);
}

/**
 * The next pair to ask, or null when nothing is left to ask. Pairs already answered, or whose order follows from
 * chained answers, are skipped; of the rest the pair with the closest strengths is chosen (ids break ties).
 * `askAbout` limits which items a question may name (default all): the others still count through their answers.
 */
export function nextPair(
  items: readonly number[],
  answers: readonly Answer[],
  askAbout: readonly number[] = items,
): [number, number] | null {
  const ids = [...new Set(items)].sort((x, y) => x - y);
  const index = new Map(ids.map((id, i) => [id, i]));
  const clean = dedupe(ids, answers);
  const beats = closure(ids.length, index, clean);
  const answered = new Set(clean.map((x) => key(x.a, x.b)));
  const strength = logStrengths(ids.length, index, clean);
  const ask = [...new Set(askAbout)].filter((id) => index.has(id)).sort((x, y) => x - y);
  let best: [number, number] | null = null;
  let bestGap = Infinity;
  for (let x = 0; x < ask.length; x++) {
    for (let y = x + 1; y < ask.length; y++) {
      const a = ask[x]!;
      const b = ask[y]!;
      const i = index.get(a)!;
      const j = index.get(b)!;
      if (answered.has(key(a, b)) || beats[i]![j] || beats[j]![i]) continue;
      const gap = Math.abs(strength[i]! - strength[j]!);
      if (gap < bestGap - 1e-12) {
        bestGap = gap;
        best = [a, b];
      }
    }
  }
  return best;
}

/**
 * Every item in order: by how many items it is above through chained answers, then by strength, then by id, so a
 * settled ranking always matches the answers.
 */
export function rank(items: readonly number[], answers: readonly Answer[]): RankedItem[] {
  const ids = [...new Set(items)].sort((x, y) => x - y);
  const index = new Map(ids.map((id, i) => [id, i]));
  const clean = dedupe(ids, answers);
  const beats = closure(ids.length, index, clean);
  const strength = logStrengths(ids.length, index, clean);
  const stat = ids.map(() => ({ wins: 0, losses: 0, ties: 0 }));
  for (const x of clean) {
    const i = index.get(x.a)!;
    const j = index.get(x.b)!;
    if (x.winner === null) {
      stat[i]!.ties++;
      stat[j]!.ties++;
    } else {
      stat[index.get(x.winner)!]!.wins++;
      stat[index.get(x.winner === x.a ? x.b : x.a)!]!.losses++;
    }
  }
  const lo = Math.min(...strength);
  const hi = Math.max(...strength);
  const order = ids
    .map((id, i) => ({ id, i, above: beats[i]!.filter(Boolean).length }))
    .sort((x, y) => y.above - x.above || strength[y.i]! - strength[x.i]! || x.id - y.id);
  return order.map(({ id, i }, pos) => ({
    id,
    position: pos + 1,
    score: hi === lo ? 50 : Math.round(((strength[i]! - lo) / (hi - lo)) * 1000) / 10,
    ...stat[i]!,
  }));
}
