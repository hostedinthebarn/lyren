/**
 * A port of CPython's `random.Random` (MT19937 seeded by init_by_array) for the
 * parts the Python tests use: random(), shuffle() and sample(). Test and measurement
 * code only, never shipped. It exists so the TypeScript tests and measurements
 * replay the exact shuffles and noise of the Python originals, which makes the
 * question counts directly comparable.
 */
const N = 624;
const M = 397;

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("seed must be a uint32");
    this.initByArray([seed]);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (((mt[i]! ^ Math.imul(prev, 1664525)) >>> 0) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (((mt[i]! ^ Math.imul(prev, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private twist(): void {
    const mt = this.mt;
    const mag = (y: number): number => (y & 1 ? 0x9908b0df : 0);
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
      mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ mag(y);
    }
    for (; kk < N - 1; kk++) {
      const y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
      mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ mag(y);
    }
    const y = (mt[N - 1]! & 0x80000000) | (mt[0]! & 0x7fffffff);
    mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ mag(y);
    this.mti = 0;
  }

  /** genrand_uint32 */
  uint32(): number {
    if (this.mti >= N) this.twist();
    let y = this.mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A float in [0, 1) with 53 bits, as random.random(). */
  random(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** getrandbits(k) for 0 < k <= 32. */
  getrandbits(k: number): number {
    return this.uint32() >>> (32 - k);
  }

  /** _randbelow_with_getrandbits: a uniform integer in [0, n). */
  randbelow(n: number): number {
    const k = Math.floor(Math.log2(n)) + 1; // n.bit_length()
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** In-place Fisher-Yates, as random.shuffle(). */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      [x[i], x[j]] = [x[j]!, x[i]!];
    }
  }

  /** random.sample(population, k), pool branch only (small populations). */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(3 * k) / Math.log(4));
    if (n > setsize) throw new RangeError("only the pool branch of sample() is ported");
    const pool = [...population];
    const result: T[] = new Array<T>(k);
    for (let i = 0; i < k; i++) {
      const j = this.randbelow(n - i);
      result[i] = pool[j]!;
      pool[j] = pool[n - i - 1]!;
    }
    return result;
  }
}
