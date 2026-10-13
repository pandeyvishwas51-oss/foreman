// The chit as a circle: every ticket around the rim, the month's pot in the middle. Instalments flow in, the prize
// flows out to the winner, and each agent's answer sits beside its ticket while the auction runs.
import type { Draw, Event, Member } from "./types.ts";
import { initialsOf, inr } from "./types.ts";

export type Answer = { kind: "bid" | "pass" | "thinking" | "late"; label: string };

export function Ring({ members, answers, draw, month, pot, phase }: { members: Member[]; answers: Map<string, Answer>; draw: Draw | null; month: number; pot: number; phase: "idle" | "collect" | "auction" | "payout" | "done" }) {
  const W = 760, H = 560, cx = W / 2, cy = H / 2 + 6, R = 215;
  const n = members.length;
  const pos = (i: number) => { const a = -Math.PI / 2 + (i / n) * 2 * Math.PI; return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a }; };
  const winner = draw?.winner ?? null;
  return (
    <svg className="ring" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Month ${month}: ${n} tickets around the pot`}>
      <defs>
        <marker id="in" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="tip-in" /></marker>
        <marker id="out" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="tip-out" /></marker>
      </defs>
      <circle cx={cx} cy={cy} r={R} className="rim" />
      {members.map((m, i) => {
        const p = pos(i);
        const inward = { x: cx + (R - 92) * Math.cos(p.a), y: cy + (R - 92) * Math.sin(p.a) };
        const edge = { x: cx + (R - 34) * Math.cos(p.a), y: cy + (R - 34) * Math.sin(p.a) };
        const isWinner = winner === (m.is_foreman ? "foreman" : m.id);
        const flowIn = phase === "collect" || phase === "auction" || phase === "payout" || phase === "done";
        return (
          <g key={m.id}>
            {flowIn && !m.is_foreman && <path d={`M${edge.x},${edge.y} L${inward.x},${inward.y}`} className={`flow flow-in${phase === "collect" ? " is-live" : ""}`} markerEnd="url(#in)" />}
            {isWinner && (phase === "payout" || phase === "done") && <path d={`M${inward.x},${inward.y} L${edge.x},${edge.y}`} className="flow flow-out is-live" markerEnd="url(#out)" />}
          </g>
        );
      })}
      <g className={`pot pot-${phase}`} data-anchor="pot">
        <circle cx={cx} cy={cy} r={86} />
        <text x={cx} y={cy - 22} className="pot-label">{phase === "done" || phase === "payout" ? "net chit amount" : "this month's pot"}</text>
        <text x={cx} y={cy + 12} className="pot-amount">{inr(pot)}</text>
        <text x={cx} y={cy + 38} className="pot-sub">{draw ? `${inr(draw.discount)} discount` : `month ${month}`}</text>
      </g>
      {members.map((m, i) => {
        const p = pos(i);
        const ans = answers.get(m.id);
        const isWinner = winner === (m.is_foreman ? "foreman" : m.id);
        const prized = m.prized_month !== null && !isWinner;
        const outside = { x: cx + (R + 54) * Math.cos(p.a), y: cy + (R + 54) * Math.sin(p.a) };
        const left = Math.cos(p.a) < -0.2, right = Math.cos(p.a) > 0.2;
        return (
          <g key={m.id} data-anchor={`seat:${m.id}`} className={`ticket${isWinner ? " is-winner" : ""}${prized ? " is-prized" : ""}${ans?.kind === "thinking" ? " is-thinking" : ""}${m.is_foreman ? " is-foreman" : ""}`} transform={`translate(${p.x},${p.y})`}>
            <circle r={30} className="seat" />
            <text y={5} className="seat-initials">{initialsOf(m.name)}</text>
            <circle cx={22} cy={-22} r={6} className="agent-dot" />
            <text x={0} y={isWinner ? 54 : 50} className="seat-name" style={{ textAnchor: "middle" }}>{m.name.split(" ")[0]}</text>
            {prized && <text y={64} className="seat-note">prized m{m.prized_month}</text>}
            {isWinner && <text y={68} className="seat-note seat-won">prized this month</text>}
            {ans && ans.kind !== "thinking" && (
              <g className={`say say-${ans.kind}`} transform={`translate(${outside.x - p.x},${outside.y - p.y})`}>
                <rect x={left ? -78 : right ? -14 : -46} y={-14} width={92} height={28} rx={14} />
                <text x={left ? -32 : right ? 32 : 0} y={5}>{ans.label}</text>
              </g>
            )}
            {ans?.kind === "thinking" && <g className="dots" transform={`translate(${outside.x - p.x},${outside.y - p.y})`}><circle cx={-10} r={3.5} /><circle r={3.5} /><circle cx={10} r={3.5} /></g>}
          </g>
        );
      })}
    </svg>
  );
}

export const _types: Event | null = null;
