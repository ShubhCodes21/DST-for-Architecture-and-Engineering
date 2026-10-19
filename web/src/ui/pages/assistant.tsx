import React, { useEffect, useRef, useState } from "react";
import { useApp } from "../app";
import { ask, Grounding, Tier, ToolCall } from "../ai";
import { getAccessCode, setAccessCode } from "../hosted";

let pending: string | null = null;
export const setPendingQuestion = (q: string) => { pending = q; };

interface Msg { role: "user" | "assistant"; content: string; grounding?: Grounding; tools?: ToolCall[]; ms?: number; error?: string; run_id?: string; review?: any; streaming?: boolean; trace?: string; tier?: string }

const SUGGEST = [
  "What is the value of the stock for the WGA return?",
  "Why is the top structure first in the programme?",
  "Which bridges are at risk of traffic restrictions?",
  "What happens to condition if the long-term budget is £4m a year?",
  "Draft three bullets for my manager on the 5-year programme",
  "Which asset group is in the worst condition?",
];

/** Render the answer with each figure marked traced / derived / untraced. */
function Marked({ text, g }: { text: string; g?: Grounding }) {
  if (!g || !g.figures.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let pos = 0;
  [...g.figures].sort((a, b) => a.index - b.index).forEach((f, i) => {
    const at = text.indexOf(f.text, pos);
    if (at < 0) return;
    out.push(text.slice(pos, at));
    out.push(<mark key={i} className={f.status} title={f.status === "traced" ? "Found in a tool result" : f.status === "derived" ? "Sum, difference or ratio of tool results" : "Not found in any tool result"}>{f.text}</mark>);
    pos = at + f.text.length;
  });
  out.push(text.slice(pos));
  return <>{out}</>;
}

function md(text: string, g?: Grounding) {
  // light formatting: **bold** stays as text markers removed; bullets kept as lines
  return <Marked text={text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "")} g={g} />;
}

export function Assistant() {
  const { st, caps, go, setReview, toast } = useApp();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<Tier>("default");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const ctl = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (pending && caps.sample) { const p = pending; pending = null; send(p); } else if (pending) setQ(pending); }, [caps.sample]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [msgs.length, msgs[msgs.length - 1]?.content]);

  const send = async (text: string) => {
    if (!caps.sample || busy || !text.trim()) return;
    const history = msgs.filter((m) => !m.error && !m.streaming).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "", streaming: true, tier }]);
    setQ(""); setBusy(true); setTools([]);
    ctl.current = new AbortController();
    let review: any = null;
    try {
      const r = await ask(caps.sample, history, text, { tier, signal: ctl.current.signal, useTools: caps.tools,
        onText: (t) => setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: t } : x))),
        onTool: () => setTools((t) => [...t]), onReview: (rv) => { review = rv; } });
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: r.text, streaming: false, grounding: r.trace.grounding, tools: r.trace.tools, ms: r.trace.ms, run_id: r.trace.run_id, review, trace: r.trace.id } : x)));
    } catch (e: any) {
      const copy: Record<string, string> = window.__dstHosted ? { not_granted: "This deployment needs an access code for the AI features. Enter it in the panel on the right and ask again.", sampling_disabled: "AI is switched off on this server (it has no access code configured). Everything else on the page works.", rate_limited: "Too many requests just now - wait a minute and try again.", cancelled: "Stopped." } as Record<string, string> : { not_granted: "Claude was not allowed for this page. You can allow it from the artifact's permissions and ask again.", rate_limited: "Too many requests just now - wait a minute and try again.", cancelled: "Stopped.", sampling_disabled: "Claude is not available on this account.", tools_unavailable: "This view cannot run page tools." };
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: e?.text ?? "", streaming: false, error: copy[e?.code] ?? `Something went wrong (${e?.code ?? "error"}).` } : x)));
    } finally { setBusy(false); }
  };

  if (!caps.sample) {
    return (
      <div className="card" style={{ maxWidth: 760 }}>
        <h2>Ask the data</h2>
        <p style={{ marginTop: 8 }}>Questions in plain English are answered by Claude, which reads this plan only through the engine's tools and must trace every figure it quotes. {window.__dstHosted ? "AI is not configured for this deployment (no AI endpoint)." : "That needs the claude.ai viewer; it is not available in this view."}</p>
        <p className="muted small" style={{ marginTop: 8 }}>Everything else on this page (valuation, programme, plan, workflow with a rule-based note) works without AI.</p>
      </div>
    );
  }
  return (
    <div className="grid g-main">
      <div className="stack">
        {msgs.length === 0 && (
          <div className="card tint">
            <h2>Ask about the plan</h2>
            <p className="small" style={{ marginTop: 6 }}>Claude answers from the engine's numbers for run <span className="mono">{st.run?.run_id}</span>. Every figure in an answer is checked against the tool results: <mark className="traced">traced</mark>, <mark className="derived">derived</mark> (a sum, difference or ratio) or <mark className="untraced">untraced</mark>. It can prepare scenarios and inspection reviews but cannot approve anything.</p>
            <div className="suggest" style={{ marginTop: 12 }}>{SUGGEST.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        <div className="chat" aria-live="polite">
          {msgs.map((m, i) => m.role === "user" ? <div key={i} className="msg user">{m.content}</div> : (
            <div key={i} className="msg ai">
              <div className="row tight" style={{ marginBottom: 6 }}>
                <span className="badge ai">Claude</span>
                {m.streaming && !m.content && <span className="small muted"><span className="spin" /> Thinking and reading the engine…</span>}
                {m.grounding && <span className={`badge ${m.grounding.untraced ? "bad" : "ok"}`}>{m.grounding.checked ? (m.grounding.untraced ? `${m.grounding.untraced} of ${m.grounding.checked} figures untraced` : `${m.grounding.checked}/${m.grounding.checked} figures traced`) : "No figures to check"}</span>}
                {m.run_id && <span className="chip">Run {m.run_id}</span>}
                {m.ms && <span className="tiny muted">{(m.ms / 1000).toFixed(1)} s · {m.tier}</span>}
              </div>
              {m.content && <div className="body">{md(m.content, m.grounding)}</div>}
              {m.error && <div className="note warn small" style={{ marginTop: 6 }}>{m.error}</div>}
              {(m.streaming ? tools : m.tools ?? []).length > 0 && <div className="toolcalls">{(m.streaming ? tools : m.tools!).map((t, k) => <span key={k} className={`badge ${t.ok ? "" : "bad"}`} title={JSON.stringify(t.args)}>{t.ms ? "✓" : <span className="spin" />} {t.name}{t.ms ? ` · ${Math.round(t.ms)} ms` : ""}</span>)}</div>}
              {m.review && <div className="note ok small" style={{ marginTop: 8 }}><div className="row spread"><span>Inspection review prepared for <b className="mono">{m.review.record.structure_id}</b> (draft {m.review.draft_id}). It needs your approval.</span><button className="btn sm primary" onClick={() => { setReview(m.review); go("workflow"); }}>Open in workflow</button></div></div>}
            </div>
          ))}
          <div ref={end} />
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(q); }}>
          <textarea value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(q); } }} placeholder="Ask about value, condition, the programme or a what-if…" aria-label="Question" rows={2} />
          {busy ? <button className="btn" type="button" onClick={() => ctl.current?.abort()}>Stop</button> : <button className="btn primary" type="submit" disabled={!q.trim()}>Ask</button>}
        </form>
      </div>
      <div className="stack">
        <div className="card">
          <header><h2>How answers are made</h2></header>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>Claude reads your question and picks engine tools (portfolio summary, structure search, priority explanation, programme, long-term plan, scenario, inspection review).</li>
            <li>The tools run here, in your browser, on run <span className="mono">{st.run?.run_id}</span>. Claude never sees the raw inventory.</li>
            <li>Every number in the reply is checked against the tool results before you see the badge.</li>
            <li>Nothing is changed: scenarios are what-ifs, inspection reviews wait for your approval.</li>
          </ol>
          <div className="row tight" style={{ marginTop: 12 }}>
            <label className="small muted">Model <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}><option value="quick">Fast</option><option value="default">Balanced</option><option value="complex">Most capable</option></select></label>
            {msgs.length > 0 && <button className="btn sm ghost" onClick={() => { setMsgs([]); toast("Conversation cleared."); }}>Clear chat</button>}
            {!caps.tools && <span className="badge warn">Tools unavailable: answers use a summary only</span>}
          </div>
          {window.__dstHosted && <AccessCode />}
          <div>
          </div>
        </div>
        <div className="card tint small">Uses your own Claude usage. The first question asks permission. Traces of each answer (tools, latency, grounding) are in <button className="btn sm ghost" onClick={() => go("governance")}>Audit & agent ops</button>.</div>
      </div>
    </div>
  );
}

function AccessCode() {
  const [v, setV] = useState(getAccessCode());
  const [saved, setSaved] = useState(false);
  return (
    <form className="row tight" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); setAccessCode(v.trim()); setSaved(true); }}>
      <label className="small muted">Access code <input type="password" value={v} onChange={(e) => { setV(e.target.value); setSaved(false); }} aria-label="AI access code" style={{ width: 140 }} /></label>
      <button className="btn sm" type="submit">{saved ? "Saved" : "Save"}</button>
    </form>
  );
}
