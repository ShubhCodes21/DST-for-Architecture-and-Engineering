// Small hand-built SVG charts (no library): themed through CSS variables, responsive via viewBox.
import React, { useState } from "react";

export interface Series { name: string; values: (number | null)[]; color: string; dashed?: boolean; band?: { lo: number[]; hi: number[] } }

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};

export function LineChart({ series, labels, yFmt, height = 220, yMin, yMax, ariaLabel, xTitle }:
  { series: Series[]; labels: (string | number)[]; yFmt: (v: number) => string; height?: number; yMin?: number; yMax?: number; ariaLabel: string; xTitle?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, L = 56, R = 12, T = 12, B = 30;
  const all = series.flatMap((s) => [...s.values.filter((v): v is number => v !== null && Number.isFinite(v)), ...(s.band ? [...s.band.lo, ...s.band.hi].filter(Number.isFinite) : [])]);
  const lo = yMin ?? Math.min(0, ...all), hi = yMax ?? niceMax(Math.max(...all, 1e-9));
  const n = labels.length, x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R)), y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
  const step = Math.max(1, Math.ceil(n / 8));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const i = Math.round(((px - L) / (W - L - R)) * (n - 1)); setHover(i >= 0 && i < n ? i : null); }}>
        {ticks.map((t, k) => <g key={k}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 6} y={y(t) + 4} className="tick" textAnchor="end">{yFmt(t)}</text></g>)}
        {labels.map((l, i) => (i % step === 0 || i === n - 1) ? <text key={i} x={x(i)} y={H - 10} className="tick" textAnchor="middle">{l}</text> : null)}
        {series.map((s) => s.band && (
          <path key={s.name + "b"} d={`M${s.band.hi.map((v, i) => `${x(i)},${y(v)}`).join("L")}L${s.band.lo.map((v, i) => `${x(i)},${y(v)}`).reverse().join("L")}Z`} fill={s.color} opacity={0.16} />
        ))}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : `${x(i)},${y(v)}`));
          let d = "", pen = false;
          pts.forEach((p) => { if (p) { d += (pen ? "L" : "M") + p; pen = true; } else pen = false; });
          return <path key={s.name} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" />;
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="cursor" />}
        {hover !== null && series.map((s) => s.values[hover] !== null && Number.isFinite(s.values[hover] as number) ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] as number)} r={3.5} fill={s.color} /> : null)}
      </svg>
      <div className="legend">
        {series.map((s) => <span key={s.name}><i style={{ background: s.color, opacity: s.dashed ? 0.6 : 1 }} />{s.name}{hover !== null && s.values[hover] !== null ? <b> {yFmt(s.values[hover] as number)}</b> : null}{s.band && hover !== null ? <em> ({yFmt(s.band.lo[hover])}–{yFmt(s.band.hi[hover])})</em> : null}</span>)}
        {hover !== null && <span className="muted">{xTitle ?? ""} {labels[hover]}</span>}
      </div>
    </div>
  );
}

export function Bars({ groups, labels, yFmt, height = 200, ariaLabel, line }:
  { groups: { name: string; values: number[]; color: string }[]; labels: (string | number)[]; yFmt: (v: number) => string; height?: number; ariaLabel: string; line?: { name: string; values: number[]; color: string } }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, L = 56, R = 12, T = 12, B = 30;
  const n = labels.length;
  const totals = labels.map((_, i) => groups.reduce((a, g) => a + (g.values[i] || 0), 0));
  const hi = niceMax(Math.max(...totals, ...(line?.values ?? [0]), 1e-9));
  const bw = (W - L - R) / n, y = (v: number) => T + (1 - v / hi) * (H - T - B);
  const step = Math.max(1, Math.ceil(n / 10));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, k) => <g key={k}><line x1={L} x2={W - R} y1={y(f * hi)} y2={y(f * hi)} className="grid" /><text x={L - 6} y={y(f * hi) + 4} className="tick" textAnchor="end">{yFmt(f * hi)}</text></g>)}
        {labels.map((l, i) => {
          let acc = 0;
          return <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
            {groups.map((g) => { const v = g.values[i] || 0; const r = <rect key={g.name} x={L + i * bw + bw * 0.15} y={y(acc + v)} width={bw * 0.7} height={Math.max(0, y(acc) - y(acc + v))} fill={g.color} opacity={hover === null || hover === i ? 1 : 0.55} />; acc += v; return r; })}
            {(i % step === 0 || i === n - 1) && <text x={L + i * bw + bw / 2} y={H - 10} className="tick" textAnchor="middle">{l}</text>}
          </g>;
        })}
        {line && <path d={line.values.map((v, i) => `${i ? "L" : "M"}${L + i * bw},${y(v)}H${L + (i + 1) * bw}`).join("")} fill="none" stroke={line.color} strokeWidth={2} strokeDasharray="5 3" />}
      </svg>
      <div className="legend">
        {groups.map((g) => <span key={g.name}><i style={{ background: g.color }} />{g.name}{hover !== null ? <b> {yFmt(g.values[hover] || 0)}</b> : null}</span>)}
        {line && <span><i style={{ background: line.color }} />{line.name}{hover !== null ? <b> {yFmt(line.values[hover] || 0)}</b> : null}</span>}
        {hover !== null && <span className="muted">Year {labels[hover]}</span>}
      </div>
    </div>
  );
}

/** One horizontal stacked bar of counts by category (condition bands). */
export function StackBar({ parts, total, fmt }: { parts: { name: string; value: number; color: string }[]; total?: number; fmt?: (v: number) => string }) {
  const t = total ?? parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="stackbar">
      <div className="bar" role="img" aria-label={parts.map((p) => `${p.name}: ${p.value}`).join(", ")}>
        {parts.map((p) => p.value > 0 && <span key={p.name} style={{ width: `${(p.value / t) * 100}%`, background: p.color }} title={`${p.name}: ${fmt ? fmt(p.value) : p.value}`} />)}
      </div>
      <div className="legend">{parts.map((p) => <span key={p.name}><i style={{ background: p.color }} />{p.name} <b>{fmt ? fmt(p.value) : p.value}</b></span>)}</div>
    </div>
  );
}

export function Spark({ values, color = "var(--primary)", w = 96, h = 26 }: { values: number[]; color?: string; w?: number; h?: number }) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
  const d = v.map((x, i) => `${i ? "L" : "M"}${(i / (v.length - 1)) * (w - 2) + 1},${h - 2 - ((x - lo) / r) * (h - 4)}`).join("");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><path d={d} fill="none" stroke={color} strokeWidth={1.6} /></svg>;
}

/** ECS profile strip: one cell per year coloured by condition score. */
export function EcsStrip({ values }: { values: number[] }) {
  const col = (e: number) => (e <= 0 ? "var(--surface-2)" : e < 2 ? "var(--c-vg)" : e < 3 ? "var(--c-g)" : e < 4 ? "var(--c-f)" : e < 5 ? "var(--c-p)" : "var(--c-vp)");
  return <span className="ecsstrip" aria-label="Condition score by year">{values.map((e, i) => <i key={i} style={{ background: col(e) }} title={`Year ${i}: ECS ${e.toFixed(1)}`} />)}</span>;
}
