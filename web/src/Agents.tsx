// What the agents said this month, as a conversation, with the owner's own words one click away.
import { useState } from "react";
import type { Bid, Event, Member } from "./types.ts";
import { initialsOf, inr } from "./types.ts";

function Face({ name, kind }: { name: string; kind?: string }) {
  return <span className={`face${kind ? ` face-${kind}` : ""}`} aria-hidden="true">{initialsOf(name)}</span>;
}

const WHO: Record<string, string> = { foreman: "FOREMAN", razorpay: "Razorpay" };

export function Agents({ members, events, bids, month, thinking, agents, instalment }: { members: Member[]; events: Event[]; bids: Bid[]; month: number; thinking: string[]; agents: "claude" | "scripted"; instalment: number | null }) {
  const [tab, setTab] = useState<"month" | "all">("month");
  const member = (id: string) => members.find((m) => m.id === id);
  const monthEvents = events.filter((e) => e.month === month);

  return (
    <section className="card agents">
      <div className="agents-head">
        <h2>{tab === "month" ? `Month ${month}: what the agents said` : "The subscribers and their agents"}</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "month"} onClick={() => setTab("month")}>This month</button>
          <button role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>All {members.length} tickets</button>
        </div>
      </div>
      <p className="code-note mono">( {agents === "claude" ? "CLAUDE, ONE AGENT PER SUBSCRIBER" : "FIXED RULES STANDING IN: NO MODEL CONFIGURED"} ) + ( AGENTS SAY HOW KEEN; CODE DOES THE SUMS )</p>

      {tab === "all" ? (
        <ul className="roster">
          {members.map((m) => (
            <li key={m.id}>
              <Face name={m.name} kind={m.is_foreman ? "foreman" : undefined} />
              <div>
                <h4>{m.name}<span>{m.trade} · ticket {m.ticket}</span></h4>
                <div className="meter-row">
                  <span className={`tag tag-${m.mandate_status}`}>{{ none: "no mandate", sent: "mandate awaiting authorisation", active: `mandate active, up to ${inr(instalment ?? 0)}/month`, failed: "mandate refused: pays by link" }[m.mandate_status]}</span>
                  {m.mandate_status === "sent" && m.mandate_url && <a className="tag" href={m.mandate_url} target="_blank" rel="noreferrer">authorise →</a>}
                  {m.prized_month !== null && <span className="tag tag-prized">prized month {m.prized_month}</span>}
                  {m.arrears > 0 && <span className="tag tag-late">in arrears</span>}
                </div>
                <details><summary>What the owner told the agent</summary><blockquote>{m.notes}</blockquote></details>
              </div>
            </li>
          ))}
        </ul>
      ) : monthEvents.length === 0 && thinking.length === 0 ? (
        <p className="empty-note">Run the month to watch the instalments come in, the agents bid, and the prize go out.</p>
      ) : (
        <ol className="stream">
          {monthEvents.map((e) => {
            const m = member(e.actor);
            const system = !m;
            const bid = m && e.kind === "bid" ? bids.find((b) => b.month === month && b.member === m.id) : null;
            return (
              <li key={e.id} className={`turn said-${e.kind}${system ? " turn-system" : ""}`}>
                <Face name={m ? m.name : WHO[e.actor] ?? e.actor} kind={system ? e.actor : undefined} />
                <div className="bubble">
                  <p className="who">{m ? `${m.name}'s agent` : WHO[e.actor] ?? e.actor}
                    {e.kind === "bid" && bid && <b>Bids {bid.max_discount_pct}%</b>}
                    {e.kind === "pass" && <b>Passes</b>}
                    {e.kind === "hammer" && <b>Hammer</b>}
                    {(e.kind === "paid" || e.kind === "processed" || e.kind === "collected") && <b>Confirmed</b>}
                    {(e.kind === "declined" || e.kind === "error") && <b>Problem</b>}
                    {e.kind === "link" && <b>{/order/i.test(e.text) && !/could not be debited/i.test(e.text) ? "Orders" : "Fallback"}</b>}
                  </p>
                  <p>{e.text}</p>
                  {m && (e.kind === "bid" || e.kind === "pass") && <details><summary>What the owner told this agent</summary><blockquote>{m.notes}</blockquote></details>}
                  {e.kind === "minutes" && <a className="minutes-link" href={`/api/minutes/${month}`} target="_blank" rel="noreferrer">Read the minutes of this draw</a>}
                </div>
              </li>
            );
          })}
          {thinking.map((id) => { const m = member(id)!; return (
            <li key={`t-${id}`} className="turn is-thinking">
              <Face name={m.name} />
              <div className="bubble"><p className="who">{m.name}'s agent</p><p className="dots-row" aria-label="Deciding"><i /><i /><i /></p></div>
            </li>
          ); })}
        </ol>
      )}
    </section>
  );
}
