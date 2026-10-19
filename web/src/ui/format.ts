export const gbp = (v: number | null | undefined, dp?: number) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e9) return `${s}£${(a / 1e9).toFixed(dp ?? 2)}bn`;
  if (a >= 1e6) return `${s}£${(a / 1e6).toFixed(dp ?? 1)}m`;
  if (a >= 1e3) return `${s}£${(a / 1e3).toFixed(dp ?? 0)}k`;
  return `${s}£${a.toFixed(dp ?? 0)}`;
};
export const gbpFull = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const n0 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : Math.round(v).toLocaleString("en-GB"));
export const n1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(1));
export const n2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(2));
export const pct = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(dp)}%`);
export const signed = (v: number, f: (x: number) => string) => (v > 0 ? "+" : v < 0 ? "−" : "±") + f(Math.abs(v)).replace(/^[−-]/, "");
export const when = (iso: string) => { try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };
export const sciBand = (v: number) => (v >= 90 ? "Very good" : v >= 80 ? "Good" : v >= 65 ? "Fair" : v >= 40 ? "Poor" : "Very poor");
export const bandVar = (b: string) => ({ "Very good": "var(--c-vg)", "Very Good": "var(--c-vg)", Good: "var(--c-g)", Fair: "var(--c-f)", Poor: "var(--c-p)", "Very poor": "var(--c-vp)", "Very Poor": "var(--c-vp)" } as Record<string, string>)[b] ?? "var(--muted)";
export function toCsv(rows: Record<string, any>[], cols?: string[]): string {
  const c = cols ?? (rows.length ? Object.keys(rows[0]) : []);
  const esc = (v: unknown) => { if (v === null || v === undefined) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [c.join(","), ...rows.map((r) => c.map((k) => esc(r[k])).join(","))].join("\n");
}
