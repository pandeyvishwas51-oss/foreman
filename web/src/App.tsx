import { useEffect, useMemo, useRef, useState } from "react";
import { Agents } from "./Agents.tsx";
import { Ledger } from "./Ledger.tsx";
import { Feed } from "./Feed.tsx";
import { Ring, type Answer } from "./Ring.tsx";
import { Flower, Mascot, type Mood } from "./Mascot.tsx";
import type { State } from "./types.ts";
import { inr, pctOf } from "./types.ts";

type Phase = "idle" | "collect" | "auction" | "payout" | "done";

// Numbers glide to their new value instead of jumping.
function useGlide(value: number): number {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const from = shown, to = value, start = performance.now();
    if (from === to) return;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 700), e = 1 - (1 - k) ** 3;
      setShown(Math.round(from + (to - from) * e));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

function Kpi({ label, value, note }: { label: string; value: number; note: string }) {
  return <div><dt className="mono">( {label} )</dt><dd>{inr(useGlide(value))}</dd><span className="mono">{note}</span></div>;
}

// Where things are on the page, relative to the sheet the actor walks on.
function anchorRect(sel: string): DOMRect | null {
  const root = document.getElementById("root"), el = document.querySelector(sel);
  if (!root || !el) return null;
  const r = el.getBoundingClientRect(), b = root.getBoundingClientRect();
  return new DOMRect(r.left - b.left, r.top - b.top, r.width, r.height);
}
type Spot = { x: number; y: number; s: number; flip: boolean; mood: Mood; shout: string | null };
const HOME: Spot = { x: 0, y: 0, s: 1, flip: false, mood: "idle", shout: null };

async function post(path: string): Promise<string | null> {
  const res = await fetch(path, { method: "POST" });
  if (res.ok) return null;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`;
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const s = (await (await fetch("/api/state")).json()) as State; if (alive) setState(s); } catch { /* server away; try again */ }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const act = async (path: string) => { setActing(true); setProblem(await post(path)); setActing(false); };

  const view = useMemo(() => {
    if (!state?.chit) return null;
    const c = state.chit;
    const running = Boolean(state.busy && (state.busy.includes("month") || state.busy.includes("chit")));
    const month = running ? c.month_done + 1 : Math.max(1, c.month_done);
    const ev = state.events.filter((e) => e.month === month);
    const kinds = new Set(ev.map((e) => e.kind));
    const draw = state.draws.find((d) => d.month === month) ?? null;
    const phase: Phase = !ev.length && !draw ? "idle" : kinds.has("minutes") ? "done" : kinds.has("hammer") ? "payout" : kinds.has("auction") || kinds.has("collected") ? "auction" : "collect";
    const monthBids = state.bids.filter((b) => b.month === month);
    const answers = new Map<string, Answer>();
    const late = new Set(state.collections.filter((x) => x.month === month && x.status !== "paid").map((x) => x.member));
    for (const b of monthBids) answers.set(b.member, b.wants ? { kind: "bid", label: `bids ${b.max_discount_pct}%` } : { kind: "pass", label: "passes" });
    const thinking: string[] = [];
    if (phase === "auction" && !draw) {
      for (const m of state.members) {
        if (m.is_foreman || m.prized_month !== null || answers.has(m.id)) continue;
        if (late.has(m.id)) answers.set(m.id, { kind: "late", label: "in arrears" }); else { answers.set(m.id, { kind: "thinking", label: "" }); thinking.push(m.id); }
      }
    }
    const paid = state.collections.filter((x) => x.status === "paid").reduce((s, x) => s + x.amount, 0);
    const prizes = state.payouts.filter((p) => p.kind === "prize").reduce((s, p) => s + p.amount, 0);
    const commission = state.payouts.filter((p) => p.kind === "commission").reduce((s, p) => s + p.amount, 0);
    const shares = state.draws.reduce((s, d) => s + d.share * c.members, 0);
    const pot = draw ? draw.prize : (state.instalment ?? 0) * c.members;
    return { c, running, month, phase, draw, answers, thinking, paid, prizes, commission, shares, pot };
  }, [state]);

  // Hathi walks to wherever the work is: round the ring while instalments come in, to the pot for the auction,
  // the hammer, to the winner with the prize, then to the minutes. The month's events become scenes, and each
  // scene is held long enough to be watched, however fast the server went. Positions are measured from the page.
  const [spot, setSpot] = useState<Spot>(HOME);
  const [heroFocused, setHeroFocused] = useState(true);
  const [walking, setWalking] = useState(false);
  const [playing, setPlaying] = useState(0);
  const sceneStart = useRef(0);
  const tour = useRef(0);
  const goTo = (sel: string, s: number, mood: Mood, shout: string | null, dx = 0, dy = 0, ax = 0.5) => {
    const r = anchorRect(sel);
    if (!r) return;
    setSpot((prev) => {
      const x = r.left + r.width * ax + dx, y = r.bottom + dy;
      return { x, y, s, flip: x < prev.x - 20, mood, shout };
    });
  };
  const monthNow = view?.month ?? 0, drawNow = view?.draw ?? null;
  const scenes = useMemo(() => {
    const out: { k: "collect" | "auction" | "hammer" | "prize" | "minutes" | "complete" }[] = [];
    const push = (k: (typeof out)[number]["k"]) => { if (out.at(-1)?.k !== k) out.push({ k }); };
    for (const e of (state?.events ?? []).filter((e) => e.month === monthNow)) {
      if (e.kind === "info" || e.kind === "debit" || e.kind === "link") push("collect");
      else if (e.kind === "auction") push("auction");
      else if (e.kind === "hammer") { push("hammer"); push("prize"); }
      else if (e.kind === "minutes") push("minutes");
      else if (e.kind === "done") push("complete");
    }
    return out;
  }, [state?.events, monthNow]);
  const HOLD: Record<string, number> = { collect: 5600, auction: 2200, hammer: 1400, prize: 3600, minutes: 2600, complete: 0 };
  useEffect(() => {
    if (state?.busy) { setPlaying(0); sceneStart.current = Date.now(); }
    else { setPlaying(99); sceneStart.current = 0; } // a month already over when the page opened is not replayed
  }, [monthNow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => {
      setPlaying((i) => {
        const cur = scenes[i];
        if (!cur) return i;
        if (i + 1 < scenes.length && Date.now() - sceneStart.current >= HOLD[cur.k]) { sceneStart.current = Date.now(); return i + 1; }
        return i;
      });
    }, 250);
    return () => clearInterval(id);
  }, [scenes]); // eslint-disable-line react-hooks/exhaustive-deps
  const scene = scenes[Math.min(playing, scenes.length - 1)]?.k ?? null;
  const sceneDone = scene !== null && playing >= scenes.length - 1 && !state?.busy && Date.now() - sceneStart.current >= HOLD[scene];
  const paidIds = useMemo(() => (state?.collections ?? []).filter((x) => x.month === monthNow && x.status === "paid").map((x) => x.member), [state?.collections, monthNow]);
  const paidCount = paidIds.length;
  const [, bump] = useState(0);
  useEffect(() => { const id = setInterval(() => bump((n) => n + 1), 700); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!state?.chit) return;
    const key = ++tour.current;
    const members = state.members;
    if (state.chit.status === "complete") { goTo(".stage-slot", 1, "done", "every rupee accounted for", 0, 0); return; }
    if (!scene || sceneDone) { goTo(".stage-slot", 1, "idle", null, 0, 0); return; }
    if (scene === "collect") {
      const ids = paidIds.length ? paidIds : members.map((m) => m.id);
      let i = 0;
      const step = () => {
        if (tour.current !== key) return;
        goTo(`[data-anchor="seat:${ids[i % ids.length]}"]`, 0.42, "collect", `+${inr(state.instalment ?? 0)}`, -74, -6);
        i++;
        if (i < ids.length) setTimeout(step, 520);
      };
      step();
      return;
    }
    if (scene === "auction") { goTo('[data-anchor="pot"]', 0.5, "auction", `${state.bids.filter((b) => b.month === monthNow).length} agents answered`, 118, -58); return; }
    if (scene === "hammer") { goTo('[data-anchor="pot"]', 0.5, "payout", "sold!", 118, -58); return; }
    if (scene === "prize" && drawNow) {
      const winnerId = drawNow.winner === "foreman" ? members.find((m) => m.is_foreman)?.id : drawNow.winner;
      goTo(`[data-anchor="seat:${winnerId}"]`, 0.46, "payout", `${inr(drawNow.prize)} to ${members.find((m) => m.id === winnerId)?.name.split(" ")[0]}`, -78, -4);
      return;
    }
    if (scene === "minutes") { goTo(".said-minutes .bubble", 0.4, "done", "minutes written", -64, 6, 0); return; }
  }, [scene, sceneDone, monthNow, paidCount, drawNow?.month, state?.chit?.status, state?.bids.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setWalking(true); const t = setTimeout(() => setWalking(false), 1250); return () => clearTimeout(t); }, [spot.x, spot.y]);
  useEffect(() => { if (scene === "collect") document.getElementById("agents")?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [scene === "collect", monthNow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const onResize = () => setSpot((p) => ({ ...p })); window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize); }, []);
  // The block nearest the middle of the screen is in focus; the others blur and sink back, like a camera racking focus.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const blocks = [...document.querySelectorAll<HTMLElement>("[data-block]")];
      const mid = window.innerHeight * 0.45;
      let best: HTMLElement | null = null, bestD = Infinity;
      for (const b of blocks) {
        const r = b.getBoundingClientRect();
        const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
        if (d < bestD) { bestD = d; best = b; }
      }
      for (const b of blocks) b.classList.toggle("is-focus", b === best);
      setHeroFocused(Boolean(best && best.classList.contains("hero")));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const id = setInterval(update, 1000);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); clearInterval(id); if (raf) cancelAnimationFrame(raf); };
  }, []);
  // Sections slide in as they scroll into view.
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -12% 0px" });
    const scan = () => document.querySelectorAll("[data-reveal]:not(.in)").forEach((el) => io.observe(el));
    scan();
    const id = setInterval(scan, 1500);
    return () => { clearInterval(id); io.disconnect(); };
  }, []);

  if (!state || !view) return <main className="page loading">Loading FOREMAN…</main>;
  const { c, running, month, phase, draw, answers, thinking, paid, prizes, commission, shares, pot } = view;
  const mood: Mood = c.status === "complete" ? "done" : spot.mood;
  const headline = c.status === "setup" ? "THE CHIT" : c.status === "complete" ? "SETTLED" : `MONTH|${String(Math.min(c.month_done + (running ? 1 : 0), c.members)).padStart(2, "0")}`;
  const mandates = state.members.filter((m) => m.mandate_status === "active").length;
  const complete = c.status === "complete";
  const stepState = (i: number) => (phase === "idle" ? "" : ["collect", "auction", "payout", "done"].indexOf(phase) > i ? "is-done" : ["collect", "auction", "payout", "done"].indexOf(phase) === i ? (running || phase !== "done" ? "is-active" : "is-done") : "");
  const winnerName = draw ? (draw.winner === "foreman" ? "the foreman" : state.members.find((m) => m.id === draw.winner)?.name) : null;
  const retryable = state.payouts.filter((p) => p.kind === "prize" && (p.status === "failed" || p.status === "reversed")).map((p) => p.month).filter((mo, i, a) => a.indexOf(mo) === i && !state.payouts.some((p) => p.month === mo && p.kind === "prize" && ["sent", "processing", "processed", "pending"].includes(p.status)));

  return (
    <>
      <div className={`actor${walking ? " is-walking" : ""}${spot.flip ? " is-left" : ""}`} style={{ transform: `translate(${spot.x}px, ${spot.y}px)` }} aria-hidden="true">
        <div className="actor-in" style={{ transform: `translate(-50%, -100%) scale(${spot.s})` }}>
          {spot.shout && <span className="shout mono">{spot.shout}</span>}
          <div className="actor-flip"><Mascot mood={spot.mood} /></div>
          {spot.mood === "payout" && <div className="burst" key={`burst-${month}`}>{Array.from({ length: 7 }, (_, i) => <Flower key={i} className={`pop pop-${i + 1}`} size={34 + (i % 3) * 14} petals={5 + (i % 2)} />)}</div>}
        </div>
      </div>
      {c.status !== "setup" && (
        <div className={`dock${heroFocused ? "" : " is-shown"}`}>
          <span className="mono">( {c.name.toUpperCase()} ) + ( MONTH {Math.min(c.month_done + (running ? 1 : 0), c.members)} / {c.members} )</span>
          {c.status === "running" && <button className="pill pill-small" disabled={acting || Boolean(state.busy)} onClick={() => act("/api/month")}>{running ? state.busy : `Run month ${c.month_done + 1}`}{!running && state.dueNext != null && <small>{inr(state.dueNext)} due per ticket</small>}</button>}
          {c.status === "running" && !running && <button className="pill pill-small pill-ghost" disabled={acting || Boolean(state.busy)} onClick={() => act("/api/run-all")}>Whole chit</button>}
          {complete && <span className="pill pill-small pill-red">Chit complete</span>}
        </div>
      )}
      <div className="ticker" aria-hidden="true"><div>{Array.from({ length: 2 }, (_, k) => <span key={k}>+ ( CHIT FUND ) ( AI AGENTS ) + ( RAZORPAY MANDATES ) ( OPEN AUCTION ) + ( SHARE OF DISCOUNT ) ( RAZORPAYX PAYOUT ) + ( CHIT FUNDS ACT 1982 ) ( MINUTES OF THE DRAW ) </span>)}</div></div>
      <header className="nav">
        <span className="wordmark">FOREMAN</span>
        <nav className="mono">{[["#chit", "CHIT"], ["#agents", "AGENTS"], ["#outcomes", "OUTCOMES"], ["#ledger", "LEDGER"]].map(([h, l]) => <a key={h} href={h}><i>(</i> {l} <i>)</i></a>)}</nav>
        <span className="mono nav-right">+ ( {state.rails === "simulated" ? "RAZORPAY SIMULATED" : "RAZORPAY TEST MODE"} ) ( {state.agents === "claude" ? "CLAUDE AGENTS" : "RULE-BASED AGENTS"} )</span>
      </header>

      <section className="hero" id="chit" data-block aria-label="The chit">
        <h1 className="giant" aria-label={headline.replace("|", " ")} key={headline}>
          {headline.split("").map((ch, i) => ch === "|" || ch === " " ? <span key={i} className="ch ch-space" /> : <span key={i} className={`ch${i >= headline.indexOf("|") && headline.includes("|") ? " ch-heat" : ""}`} style={{ animationDelay: `${0.9 + i * 0.045}s` }}>{ch}</span>)}
        </h1>
        <div className="panel panel-yellow hero-panel">
          <span className="rail rail-l mono" aria-hidden="true"><span className="rail-track">{"+ ( CHIT ) ( AUCTION ) + ( SHARE OF DISCOUNT ) + ( RAZORPAY ) ".repeat(4)}</span></span>
          <span className="rail rail-r mono" aria-hidden="true"><span className="rail-track">{"+ ( MANDATE ) ( PAYOUT ) + ( MINUTES OF THE DRAW ) + ( HATHI ) ".repeat(4)}</span></span>
          <Flower className="deco deco-1 burst-load" size={120} />
          <Flower className="deco deco-2 burst-load" size={70} petals={5} />
          <svg className="deco deco-3 burst-load" viewBox="0 0 64 60" width="64" height="60" aria-hidden="true"><path d="M32 58 C8 42 0 30 0 18 A14 14 0 0 1 32 12 A14 14 0 0 1 64 18 C64 30 56 42 32 58 Z" /></svg>
          <div className="hero-copy">
            <p className="mono heat">+ ( {c.name.toUpperCase()} ) + ( {inr(c.gross)} OVER {c.members} MONTHS ) + ( {inr(state.instalment ?? 0)} A MONTH ) + ( COMMISSION {c.commissionPct}% ) + ( CEILING {c.maxDiscountPct}% ) +</p>
            <p className="lede">{c.members - 1} subscribers. One agent each. Agents bid, code settles, Razorpay moves the money.</p>
            <div className="controls">
              {c.status === "setup" && <button className="pill" disabled={acting || Boolean(state.busy)} onClick={() => act("/api/start")}>Open the chit on Razorpay</button>}
              {c.status === "running" && <button className="pill" disabled={acting || Boolean(state.busy)} onClick={() => act("/api/month")}>{running ? state.busy : `Run month ${c.month_done + 1}`}{!running && state.dueNext != null && <small>{inr(state.dueNext)} due per ticket</small>}</button>}
              {c.status === "running" && !running && <button className="pill pill-ghost" disabled={acting || Boolean(state.busy)} onClick={() => act("/api/run-all")}>Run the whole chit</button>}
              {complete && <span className="pill pill-red">Chit complete</span>}
              {retryable.map((mo) => <button key={mo} className="pill pill-ghost" disabled={acting || Boolean(state.busy)} onClick={() => act(`/api/retry/${mo}`)}>Send month {mo} prize again</button>)}
              {c.status !== "setup" && <button className="pill pill-ghost" disabled={acting || Boolean(state.busy)} onClick={() => act("/api/reset")}>Start over</button>}
            </div>
          </div>
          <div className="stage">
            <div className="stage-slot" aria-hidden="true" />
            <p className="mono stage-label">{{ idle: "( HATHI, THE FOREMAN )", collect: "( HATHI IS COLLECTING )", auction: "( HATHI RUNS THE AUCTION )", payout: "( HATHI PAYS THE PRIZE )", done: "( HATHI WRITES THE MINUTES )" }[mood]}</p>
          </div>
          <dl className="kpis">
            <Kpi label="COLLECTED" value={paid} note={`${state.collections.filter((x) => x.status === "paid").length} INSTALMENTS IN`} />
            <Kpi label="PRIZES PAID" value={prizes} note={`${state.payouts.filter((p) => p.kind === "prize" && p.status === "processed").length} CONFIRMED BY BANK`} />
            <Kpi label="RETURNED AS SHARES" value={shares} note="OFF NEXT INSTALMENTS" />
            <Kpi label="COMMISSION" value={commission} note={`${c.commissionPct}% OF GROSS, RETAINED`} />
            <div className="meter" aria-label={`${c.month_done} of ${c.members} months done`}>{Array.from({ length: c.members }, (_, i) => <i key={i} className={i < c.month_done ? "m-done" : i === c.month_done && running ? "m-live" : ""} />)}</div>
          </dl>
        </div>
        {state.rails === "simulated" && <p className="mono strip">( SIMULATED RAZORPAY + RULE-BASED AGENTS ) + ( WITH TEST KEYS AND A MODEL THE SAME CODE MOVES TEST MONEY AND THE AGENTS THINK FOR THEMSELVES )</p>}
        {state.rails === "razorpay-test-no-x" && <p className="mono strip">( RAZORPAY TEST MODE: CUSTOMERS, MANDATES, DEBITS, PAYMENT LINKS, CONTACTS AND FUND ACCOUNTS ARE REAL ) + ( THE PRIZE PAYOUT RUNS ON THE SIMULATED RAIL: RAZORPAYX NEEDS A BUSINESS CURRENT ACCOUNT THIS MERCHANT DOES NOT HAVE )</p>}
        {state.rails === "razorpay-test-links" && <p className="mono strip">( RAZORPAY TEST MODE: CUSTOMERS, ORDERS, CHECKOUT PAYMENTS, CONTACTS AND FUND ACCOUNTS ARE REAL ) + ( THIS MERCHANT HAS NO RECURRING-DEBIT OR RAZORPAYX ACCESS, SO SUBSCRIBERS PAY EACH INSTALMENT AT RAZORPAY CHECKOUT AND THE PRIZE PAYOUT RUNS ON THE SIMULATED RAIL )</p>}
      </section>

      <main className="page">
        {problem && <p className="problem mono" role="alert">( PROBLEM ) {problem}</p>}
        {c.status === "running" && mandates < state.members.length && (
          <p className="notice mono">( {mandates} OF {state.members.length} MANDATES AUTHORISED ) {state.rails !== "simulated" ? "OPEN EACH SUBSCRIBER'S REGISTRATION LINK (ALL TICKETS TAB) AND AUTHORISE IT WITH A RAZORPAY TEST CARD; UNTIL THEN THAT TICKET PAYS BY PAYMENT LINK." : "THE SIMULATED SUBSCRIBERS AUTHORISE THEIRS IN A MOMENT."}</p>
        )}

        <section className="what" data-reveal data-block aria-label="What Hathi does">
          <span className="mono what-cap what-cap-1">EVERY MONTH</span>
          <span className="line line-1" aria-hidden="true" /><button className="pill pill-small line-btn line-btn-1" onClick={() => document.getElementById("agents")?.scrollIntoView({ behavior: "smooth" })}>Watch the ring</button>
          <h2 className="stack"><span>WHAT</span><span className="heat">HATHI</span><span className="chip-row">* <i className="paren">(</i><span className="chip"><Mascot mood="idle" /></span><i className="paren">)</i></span><span>DOES</span></h2>
          <span className="mono what-cap what-cap-2">UNDER THE ACT</span>
          <span className="line line-2" aria-hidden="true" /><a className="pill pill-small line-btn line-btn-2" href={state.draws.length ? `/api/minutes/${state.draws.at(-1)!.month}` : "#ledger"} target={state.draws.length ? "_blank" : undefined} rel="noreferrer">Read the minutes</a>
        </section>

        <ol className="steps" data-reveal data-block aria-label="How a month runs">
          <li className={stepState(0)}><strong>Collect the instalments</strong><em className="mono">( RAZORPAY MANDATES )</em></li>
          <li className={stepState(1)}><strong>Auction the pot</strong><em className="mono">( ONE AGENT PER SUBSCRIBER )</em></li>
          <li className={stepState(2)}><strong>Pay the prize</strong><em className="mono">( RAZORPAYX PAYOUT )</em></li>
          <li className={stepState(3)}><strong>Record the minutes</strong><em className="mono">( CODE, UNDER THE ACT )</em></li>
        </ol>

        <div className="work" id="agents" data-reveal data-block>
          <section className="card map" aria-label="The chit">
            <Ring members={state.members} answers={answers} draw={draw} month={month} pot={pot} phase={phase} />
            <p className="key">
              {draw && winnerName ? <span><b>Month {month}:</b> {winnerName} took {inr(draw.prize)} at {pctOf(draw.discount, c.gross)} discount; every ticket's next instalment falls by {inr(draw.share)}.</span>
                : <span>Instalments flow into the pot. The keenest agent wins it for its owner, and the discount it forgoes comes back to everyone.</span>}
            </p>
          </section>
          <Agents members={state.members} events={state.events} bids={state.bids} month={month} thinking={thinking} agents={state.agents} instalment={state.instalment} />
        </div>

        <div data-reveal data-block><Feed state={state} /></div>

        {state.draws.length > 0 && (
          <section className="card outcomes" id="outcomes" data-reveal data-block aria-label="What each subscriber got">
            <h2 className="display">WHO GOT WHAT{complete ? "" : " SO FAR"}</h2>
            <p className="sub">{complete ? "The rate is the yearly rate implied by each ticket's own cash flows: a borrowing cost for those prized early, a saving return for those prized late. For comparison, a personal loan is 14–24% and a fixed deposit about 7%." : "Rates appear once the chit completes."}</p>
            <ul className="people">
              {state.members.map((m) => { const o = state.outcomes.find((x) => x.id === m.id); if (!o) return null; return (
                <li key={m.id} className={m.prized_month !== null ? "is-prized" : ""}>
                  <h4>{m.name}<span>{m.is_foreman ? "foreman" : m.trade}</span></h4>
                  <div className="row"><span>Paid in</span><b>{inr(o.paidIn)}</b></div>
                  <div className="row"><span>Received</span><b>{o.received ? `${inr(o.received)} in month ${m.prized_month}` : "waiting"}</b></div>
                  {o.yearlyRate !== null && <div className={`rate ${o.yearlyRate >= 0 ? "is-cost" : "is-return"}`}>{o.yearlyRate >= 0 ? `paid ${o.yearlyRate.toFixed(1)}% a year for early money` : `earned ${(-o.yearlyRate).toFixed(1)}% a year by waiting`}</div>}
                </li>
              ); })}
            </ul>
            {state.audit && <p className={`audit ${state.audit.length ? "is-bad" : "is-good"}`}>{state.audit.length ? `Audit problems: ${state.audit.join("; ")}` : "Audit: every rupee collected went out as prize or commission; every subscriber was prized exactly once; every draw stayed inside the Act's limits."}</p>}
          </section>
        )}

        <div id="ledger" data-reveal data-block><Ledger state={state} /></div>

        <div className="tiles" data-reveal data-block>
          <div className="tile"><strong>{c.members - 1}</strong><span className="mono">( AGENTS, ONE PER SUBSCRIBER )</span></div>
          <div className="tile"><strong>0</strong><span className="mono">( RUPEES DECIDED BY A MODEL )</span></div>
          <div className="tile"><strong>3</strong><span className="mono">( RAZORPAY RAILS: MANDATES, LINKS, PAYOUTS )</span></div>
          <div className="tile tile-live"><strong>{state.draws.length}</strong><span className="mono">( SETS OF STATUTORY MINUTES )</span></div>
        </div>
        <p className="giant giant-foot" aria-hidden="true">FOREMAN</p>
        <p className="foot mono">FOREMAN is a demonstration built on the Razorpay developer platform in test mode. It is not a registered chit fund and moves no real money. Chit Funds Act, 1982 terms: gross chit amount, discount, foreman's commission (≤ 7%), net chit amount, share of discount.</p>
      </main>
    </>
  );
}
