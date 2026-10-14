// Every object FOREMAN creates or confirms on Razorpay, newest first, as it happens: the chit as a stream of transactions.
import { useEffect, useMemo, useRef } from "react";
import type { State } from "./types.ts";
import { inr } from "./types.ts";

type Row = { key: string; at: string; kind: string; who: string; amount: number | null; id: string; status: string; tone: "ok" | "wait" | "bad" | "neutral" };

export function feedRows(state: State): Row[] {
  const name = new Map(state.members.map((m) => [m.id, m.name.split(" ")[0]]));
  const sim = state.rails === "simulated" ? "" : state.rails === "razorpay-test" ? "" : " · simulated";
  const rows: Row[] = [];
  for (const m of state.members) {
    if (m.customer_id) rows.push({ key: `cust-${m.id}`, at: state.chit?.id ? "" : "", kind: "customer", who: name.get(m.id) ?? m.id, amount: null, id: m.customer_id, status: "created", tone: "neutral" });
    if (m.fund_account_id) rows.push({ key: `fa-${m.id}`, at: "", kind: "fund account", who: name.get(m.id) ?? m.id, amount: null, id: m.fund_account_id, status: "created", tone: "neutral" });
    if (m.mandate_id) rows.push({ key: `mand-${m.id}`, at: "", kind: "mandate", who: name.get(m.id) ?? m.id, amount: state.instalment, id: m.mandate_id, status: m.mandate_status, tone: m.mandate_status === "active" ? "ok" : m.mandate_status === "failed" ? "bad" : "wait" });
  }
  for (const c of state.collections) {
    const who = name.get(c.member) ?? c.member;
    if (c.method === "checkout" && c.order_id) rows.push({ key: `order-${c.id}`, at: c.at, kind: `order · m${c.month}`, who, amount: c.amount, id: c.order_id, status: c.status === "paid" ? "paid" : "awaiting checkout", tone: c.status === "paid" ? "ok" : "wait" });
    else if (c.link_id) rows.push({ key: `link-${c.id}`, at: c.at, kind: `payment link · m${c.month}`, who, amount: c.amount, id: c.link_id, status: c.status === "paid" ? "paid" : "awaiting payment", tone: c.status === "paid" ? "ok" : "wait" });
    else if (c.order_id) rows.push({ key: `debit-${c.id}`, at: c.at, kind: `mandate debit · m${c.month}`, who, amount: c.amount, id: c.payment_id ?? c.order_id, status: c.status === "paid" ? "captured" : c.status === "failed" ? "declined" : "in flight", tone: c.status === "paid" ? "ok" : c.status === "failed" ? "bad" : "wait" });
    if (c.payment_id && c.status === "paid" && c.method !== "mandate") rows.push({ key: `pay-${c.id}`, at: c.paid_at ?? c.at, kind: `payment · m${c.month}`, who, amount: c.amount, id: c.payment_id, status: c.payment_id.startsWith("pay_fake") ? `captured${sim}` : "captured · real", tone: "ok" });
  }
  for (const p of state.payouts) {
    if (p.kind !== "prize") continue;
    rows.push({ key: `pout-${p.id}`, at: p.at, kind: `payout · m${p.month}`, who: name.get(p.member) ?? p.member, amount: p.amount, id: p.payout_id ?? p.idempotency, status: `${p.status}${state.rails === "razorpay-test" ? "" : sim || (state.rails === "simulated" ? "" : "")}`, tone: p.status === "processed" ? "ok" : p.status === "failed" || p.status === "reversed" ? "bad" : "wait" });
  }
  return rows;
}

export function Feed({ state }: { state: State }) {
  const rows = useMemo(() => feedRows(state), [state]);
  const seen = useRef(new Set<string>());
  const fresh = new Set(rows.filter((r) => !seen.current.has(r.key)).map((r) => r.key));
  useEffect(() => { for (const r of rows) seen.current.add(r.key); });
  const live = state.rails !== "simulated";
  const shown = [...rows].reverse().slice(0, 60);
  return (
    <section className="card feed" aria-label="Live Razorpay transactions">
      <div className="feed-head">
        <h2 className="display">{live ? "LIVE ON RAZORPAY" : "TRANSACTIONS"}</h2>
        <span className="mono">( {rows.length} OBJECTS ) + ( {state.collections.filter((c) => c.status === "paid").length} PAYMENTS CAPTURED ) + ( {state.payouts.filter((p) => p.kind === "prize" && p.status === "processed").length} PAYOUTS PROCESSED ){live ? " + ( TEST MODE )" : " + ( SIMULATED )"}</span>
        <i className={`pulse${state.busy ? " is-on" : ""}`} aria-hidden="true" />
      </div>
      <ol className="feed-list">
        {shown.map((r) => (
          <li key={r.key} className={`feed-row tone-${r.tone}${fresh.has(r.key) ? " is-new" : ""}`}>
            <span className="mono feed-kind">{r.kind}</span>
            <span className="feed-who">{r.who}</span>
            <span className="feed-amt">{r.amount == null ? "" : inr(r.amount)}</span>
            <span className="mono feed-id">{r.id}</span>
            <span className="mono feed-status">{r.status}</span>
          </li>
        ))}
        {!shown.length && <li className="empty-note">Open the chit and the first objects appear here as Razorpay creates them.</li>}
      </ol>
    </section>
  );
}
