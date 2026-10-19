// Shared helpers for the browser engine: Excel semantics, tables, the VBA random generator.
// Mirrors dst_engine (Python). Every behaviour here is covered by web/test/engine.test.mjs.

export type Row = Record<string, any>;
export interface Table { columns: string[]; rows: any[][] }

export function toRows(t: Table | undefined | null): Row[] {
  if (!t) return [];
  return t.rows.map((r) => {
    const o: Row = {};
    t.columns.forEach((c, i) => (o[c] = r[i]));
    return o;
  });
}

/** Text key the way Excel compares text: case-insensitive; blank for null. */
export function key(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isNaN(v)) return "";
  return String(v).toLowerCase();
}

/** Excel arithmetic treats blanks and text as 0. */
export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Excel ROUND: half away from zero, at 15 significant digits (8.825 -> 8.83). */
export function xlRound(x: number, digits = 0): number {
  const f = Math.pow(10, digits);
  const a = Math.abs(x) * f;
  const r = Math.floor(Math.round(a * 1e6) / 1e6 + 0.5) / f;
  return x < 0 ? -r : r;
}

/** A value as Excel compares it: rounded to 15 significant digits. */
export function xlCmp(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const scale = Math.pow(10, 14 - mag);
  return Math.round(x * scale) / scale;
}

/** Excel ROUNDDOWN(x, 1) for x >= 0, tolerant of binary representation. */
export function xlRoundDown1(x: number): number {
  return Math.floor(Math.round(x * 10 * 1e9) / 1e9) / 10;
}

/** VBA Rnd(-10); Randomize 0; Rnd() x n  -  SAVI's Ref99 draws, bit for bit. */
export function vbaRndDraws(n: number): Float64Array {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat32(0, -10, true);
  const b = buf.getUint32(0, true);
  let seed = ((b & 0xffffff) + (b >>> 24)) & 0xffffff;
  const lcg = (s: number) => Number((BigInt(s) * 0x43fd43fdn + 0xc39ec3n) & 0xffffffn);
  seed = lcg(seed);
  // Randomize 0: middle 16 bits from the double bits of 0 (all zero)
  seed = seed & 0xff0000ff;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    seed = lcg(seed);
    out[i] = seed / 16777216;
  }
  return out;
}

/** Small deterministic PRNG (mulberry32) for Monte Carlo runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export function percentile(values: number[], p: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** Excel LOOKUP on ascending thresholds: factor of the largest threshold <= amount. */
export function bandLookup(thr: number[], fac: number[], amount: number): number {
  let i = -1;
  for (let k = 0; k < thr.length; k++) if (thr[k] <= amount) i = k;
  return i >= 0 ? fac[i] : NaN;
}

export async function sha256Hex(text: string): Promise<string> {
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return "fnv-" + (h >>> 0).toString(16);
  }
}
