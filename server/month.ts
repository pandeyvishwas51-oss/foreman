// A chit month, start to finish: collect, auction, pay out, write the minutes. And the pieces around it: opening
// the chit on Razorpay, and reconciling whatever Razorpay has not confirmed yet.
// Order of trust: the engine does the maths, the agents decide how keen each subscriber is, Razorpay holds the money.
import type { Brain } from "./brain.ts";
import type { Collection, Db, DrawRow, Member, Payout } from "./db.ts";
import { audit, ceilingDiscount, dueThisMonth, floorDiscount, instalment, settle, type Bid, type Draw } from "./engine.ts";
import { inr, type Rails } from "./rails.ts";

export type Deps = { db: Db; rails: Rails; brain: Brain; waitMs?: number; paceMs?: number; payoutWaitMs?: number };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const person = (m: Member) => ({ name: m.name, email: m.email, contact: m.phone });
const pct = (paise: number, gross: number) => Math.round((paise / gross) * 10000) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Opens the chit: every ticket holder becomes a Razorpay customer with a standing mandate for the instalment, and a
// RazorpayX contact with a fund account the prize can be paid to.
export async function startChit({ db, rails }: Deps) {
  const chit = db.chit();
  if (!chit || chit.status !== "setup") throw new Error("The chit is already open.");
  const t = db.terms();
  for (const m of db.members()) {
    const p = person(m);
    const customerId = m.customer_id ?? (await rails.createCustomer(p, `${chit.id}:${m.id}`));
    const contactId = m.contact_id ?? (await rails.createContact(p, `${chit.id}:${m.id}`));
    const fundAccountId = m.fund_account_id ?? (await rails.createFundAccount(contactId, { name: m.name, ifsc: "HDFC0000053", number: `5010${String(m.ticket).padStart(8, "0")}` }));
    db.run("UPDATE member SET customer_id = ?, contact_id = ?, fund_account_id = ? WHERE id = ?", customerId, contactId, fundAccountId, m.id);
    if (!m.mandate_id) {
      try {
        const link = await rails.createMandate(customerId, p, instalment(t), `${chit.id}:${m.id}:mandate`);
        db.run("UPDATE member SET mandate_id = ?, mandate_url = ?, mandate_status = 'sent' WHERE id = ?", link.id, link.url, m.id);
      } catch (e) {
        if (!errText(e).includes("switched off")) throw e;
        db.run("UPDATE member SET mandate_status = 'none' WHERE id = ?", m.id); // instalments go out as payment links
      }
    }
  }
  db.run("UPDATE chit SET status = 'running', started = ? WHERE id = ?", db.now(), chit.id);
  const sent = db.members().filter((m) => m.mandate_status === "sent").length;
  db.say(null, "foreman", "open", `${chit.name} is open: ${inr(t.gross)} over ${t.members} months, ${inr(instalment(t))} a month. ${sent ? `${sent} mandates sent for authorisation.` : "Instalments will go out as payment links each month."}`);
}

// Asks Razorpay which mandates the subscribers have authorised since we last looked.
export async function refreshMandates({ db, rails }: Deps) {
  for (const m of db.members().filter((x) => x.mandate_status === "sent" && x.mandate_id && x.customer_id)) {
    try {
      const st = await rails.mandateState(m.customer_id!, m.mandate_id!);
      if (st.status === "active") {
        db.run("UPDATE member SET mandate_status = 'active', token_id = ? WHERE id = ?", st.tokenId ?? null, m.id);
        db.say(null, m.id, "mandate", `${m.name} authorised a monthly mandate of up to ${inr(instalment(db.terms()))}.`);
      } else if (st.status === "failed") {
        db.run("UPDATE member SET mandate_status = 'failed' WHERE id = ?", m.id);
        db.say(null, m.id, "nomandate", `${m.name} has no mandate (${st.detail ?? "not authorised"}). Instalments will go out as payment links.`);
      }
    } catch (e) { console.error(`mandate ${m.id}: ${errText(e)}`); }
  }
}

export async function runMonth(deps: Deps) {
  const { db, rails, brain } = deps;
  const chit = db.chit();
  if (!chit || chit.status !== "running") throw new Error("Open the chit first.");
  const t = db.terms();
  const month = chit.month_done + 1;
  if (month > t.members) throw new Error("The chit is complete.");
  const say = (actor: string, kind: string, text: string, about?: Record<string, unknown>) => db.say(month, actor, kind, text, about);
  const draws = db.draws();
  const previous = (draws.at(-1) as unknown as Draw | undefined) ?? null;
  const due = dueThisMonth(t, previous);
  const members = db.members();

  // A month interrupted after its draw (crash, restart) resumes here: the draw stands, nothing is auctioned or
  // collected twice, and the prize is paid only if no payout for it is already on its way.
  const earlier = db.get<DrawRow>("SELECT * FROM draw WHERE month = ?", month);
  let draw: Draw, winner: Member;
  if (earlier) {
    draw = { ...earlier, bidders: JSON.parse(earlier.bidders) as string[], secondBest: earlier.second_best, how: earlier.how as Draw["how"] };
    winner = draw.winner === "foreman" ? db.members().find((m) => m.is_foreman)! : db.member(draw.winner);
    say("foreman", "info", `Resuming month ${month}: the draw already stood, so only the payout is checked.`);
  } else {
    // 1. Collect. A mandate is debited; without one, or if the debit is declined, a payment link goes out instead.
    say("foreman", "info", `Month ${month}: ${inr(due)} due from each of ${members.length} tickets${previous ? ` (${inr(instalment(t))} less ${inr(previous.share)} share of last month's discount)` : ""}.`);
    await refreshMandates(deps);
    const onMandate = db.members().filter((m) => m.mandate_status === "active" && m.token_id).length;
    if (onMandate) say("razorpay", "debit", `Debiting ${inr(due)} from ${onMandate} tickets against their standing mandates${onMandate < members.length ? `; ${members.length - onMandate} without a mandate get a payment link` : ""}.`);
    // One at a time: Razorpay rate-limits bursts of link creation, and ten in a row is quick enough.
  for (const m of db.members()) await collect(deps, month, m, due);
    await waitForCollections(deps, month);
    // Demo pacing: the collection round lasts long enough to be watched, as a real one lasts days.
    await sleep(Math.min(6000, members.length * (deps.paceMs ?? 450)));
    const paid = db.all<Collection>("SELECT * FROM collection WHERE month = ? AND status = 'paid'", month);
    const late = db.members().filter((m) => !paid.some((c) => c.member === m.id));
    for (const m of late) db.run("UPDATE member SET arrears = arrears + 1 WHERE id = ?", m.id);
    say("razorpay", "collected", `${inr(paid.reduce((s, c) => s + c.amount, 0))} collected from ${paid.length} of ${members.length} tickets${late.length ? `; ${late.map((m) => m.name).join(", ")} in arrears, so not eligible to bid this month` : ""}.`);

    // 2. Auction. Each unprized, paid-up subscriber's agent names its ceiling; the engine settles the draw.
    const eligible = db.members().filter((m) => !m.is_foreman && m.prized_month === null && !late.some((l) => l.id === m.id)).map((m) => m.id);
    const unprized = db.members().filter((m) => !m.is_foreman && m.prized_month === null);
    const ctx = {
      chitName: chit.name, month, months: t.members, gross: t.gross, instalment: instalment(t), due,
      floorPct: t.commissionPct, ceilingPct: t.maxDiscountPct, lastDiscountPct: previous && previous.how !== "foreman" ? pct(previous.discount, t.gross) : null,
      eligible: eligible.length, prizedSoFar: draws.map((d) => d.winner).filter((w) => w !== "foreman").map((w) => db.member(w).name),
    };
    const bids: Bid[] = [];
    if (!(t.foremanFirst && month === 1) && eligible.length > 1) {
      say("foreman", "auction", `Auction open for month ${month}: floor ${t.commissionPct}%, ceiling ${t.maxDiscountPct}%, ${eligible.length} subscribers may bid.`);
      await Promise.all(unprized.filter((m) => eligible.includes(m.id)).map(async (m) => {
        const call = await brain.decideBid(m, ctx).catch((e) => ({ wants: false, maxDiscountPct: t.commissionPct, reason: `My agent could not answer, so I am not bidding this month (${errText(e)}).`, failed: true }));
        const source = "failed" in call ? "fail-closed" : brain.kind;
        db.run("INSERT INTO bid (month, member, wants, max_discount_pct, reason, source) VALUES (?, ?, ?, ?, ?, ?)", month, m.id, call.wants ? 1 : 0, call.maxDiscountPct, call.reason, source);
        if (call.wants) bids.push({ member: m.id, maxDiscountPct: call.maxDiscountPct });
        say(m.id, call.wants ? "bid" : "pass", call.reason, { pct: call.wants ? call.maxDiscountPct : null });
      }));
    }
    draw = settle(t, month, bids, eligible, chit.seed);
    winner = draw.winner === "foreman" ? db.members().find((m) => m.is_foreman)! : db.member(draw.winner);
    const minutes = writeMinutes(chit.name, t, month, draw, db.all<{ member: string; wants: number; max_discount_pct: number }>("SELECT member, wants, max_discount_pct FROM bid WHERE month = ?", month).map((b) => ({ ...b, name: db.member(b.member).name })), winner.name, late.map((m) => m.name));
    db.run("INSERT INTO draw (month, winner, discount, prize, commission, share, how, bidders, second_best, minutes, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      month, draw.winner, draw.discount, draw.prize, draw.commission, draw.share, draw.how, JSON.stringify(draw.bidders), draw.secondBest, minutes, db.now());
    db.run("UPDATE member SET prized_month = ? WHERE id = ?", month, winner.id);
    const how = draw.how === "foreman" ? "takes month one at the floor, as agreed" : draw.how === "last" ? "is the last unprized subscriber and takes the pot at the floor" : draw.how === "lot" ? "won the lot" : `won the auction (runner-up stopped at ${pct(draw.secondBest!, t.gross)}%)`;
    say("foreman", "hammer", `${winner.name} ${how}: discount ${pct(draw.discount, t.gross)}%, so ${inr(draw.prize)} to ${winner.name}, ${inr(draw.commission)} foreman's commission, and ${inr(draw.share)} off every ticket's next instalment.`, { winner: winner.id, pct: pct(draw.discount, t.gross) });
  }

  // 3. Pay out. The prize goes by RazorpayX payout; the commission stays with the foreman, as a ledger entry.
  db.run("INSERT OR IGNORE INTO payout (month, member, amount, kind, idempotency, status, at) VALUES (?, 'foreman', ?, 'commission', ?, 'retained', ?)", month, draw.commission, `FM-C-M${month}`, db.now());
  const prizeRows = db.all<Payout>("SELECT * FROM payout WHERE month = ? AND kind = 'prize' ORDER BY id", month);
  if (!prizeRows.length) await payPrize(deps, month, winner, draw.prize, 1);
  else if (prizeRows.every((p) => p.status === "failed" || p.status === "reversed")) await payPrize(deps, month, winner, draw.prize, prizeRows.length + 1);
  // Give the bank a moment to confirm; in test mode RazorpayX waits for a click in the dashboard, so this is bounded.
  const until = Date.now() + (deps.payoutWaitMs ?? 5000);
  while (Date.now() < until && db.get("SELECT 1 FROM payout WHERE month = ? AND kind = 'prize' AND status IN ('sent', 'processing')", month)) {
    await sleep(400);
    await reconcile(deps);
  }

  // 4. Close the month.
  db.run("UPDATE chit SET month_done = ?, status = ? WHERE id = ?", month, month === t.members ? "complete" : "running", chit.id);
  say("foreman", "minutes", `Minutes of the month ${month} draw recorded, as the Chit Funds Act requires.`, { month });
  if (month === t.members) {
    const problems = audit(t, db.draws() as unknown as Draw[], db.members().filter((m) => !m.is_foreman).map((m) => m.id));
    say("foreman", problems.length ? "error" : "done", problems.length ? `Chit closed with audit problems: ${problems.join("; ")}` : `Chit complete. Every subscriber was prized once, and every rupee collected went out as prize or commission.`);
  }
  return month;
}

const runTag = (db: Db) => Number(db.chit()!.seed.split(":")[1] ?? 0).toString(36).slice(-6);

async function collect({ db, rails }: Deps, month: number, m: Member, amount: number) {
  // The run tag (from the chit's seed) keeps Razorpay reference ids unique across resets of the same demo chit.
  const marker = `FM-${runTag(db)}-M${month}-${m.id}`;
  if (db.get("SELECT 1 FROM collection WHERE marker = ?", marker)) return; // a retry of this month never asks twice
  const desc = `${db.chit()!.name}: month ${month} instalment, ticket ${m.ticket}`;
  const useMandate = m.mandate_status === "active" && m.token_id && m.customer_id;
  const row = Number(db.run("INSERT INTO collection (month, member, amount, method, marker, status, at) VALUES (?, ?, ?, ?, ?, 'pending', ?)", month, m.id, amount, useMandate ? "mandate" : "checkout", marker, db.now()).lastInsertRowid);
  try {
    if (useMandate) {
      const { orderId, paymentId } = await rails.charge(m.customer_id!, m.token_id!, person(m), amount, marker, desc);
      db.run("UPDATE collection SET order_id = ?, payment_id = ?, status = 'notified' WHERE id = ?", orderId, paymentId, row);
    } else await sendOrder({ db, rails } as Deps, month, m, amount, marker, desc, row);
  } catch (e) {
    db.run("UPDATE collection SET status = 'failed', error = ? WHERE id = ?", errText(e), row);
    db.say(month, "razorpay", "declined", `${m.name}'s debit failed (${errText(e)}).`, { member: m.id });
  }
}

// A Razorpay Order for the instalment, paid through Razorpay Checkout on FOREMAN's own pay page.
async function sendOrder({ db, rails }: Deps, month: number, m: Member, amount: number, marker: string, desc: string, row: number) {
  const orderId = await rails.createOrder(person(m), amount, `${marker}-order`, desc);
  const url = `${payBase}/pay/${row}`;
  db.run("UPDATE collection SET method = 'checkout', order_id = ?, link_url = ?, status = 'notified', error = NULL, at = ? WHERE id = ?", orderId, url, db.now(), row);
  db.say(month, "razorpay", "link", `${m.name} has no usable mandate this month: Razorpay order ${orderId} for ${inr(amount)} is waiting to be paid at checkout.`, { member: m.id, url });
}
export let payBase = process.env.PUBLIC_URL?.replace(/\/$/, "") || `http://localhost:${process.env.PORT ?? 8788}`;
export const setPayBase = (b: string) => { payBase = b; };

// Waits a little for debits to land, then goes on with whatever has: a chit auction does not wait for late payers.
async function waitForCollections(deps: Deps, month: number) {
  const until = Date.now() + (deps.waitMs ?? 20000);
  do {
    await reconcileCollections(deps, month);
    if (!deps.db.get("SELECT 1 FROM collection WHERE month = ? AND status IN ('pending', 'notified', 'failed')", month)) return;
    await sleep(400);
  } while (Date.now() < until);
}

// Asks Razorpay about every instalment it has not confirmed. A declined debit becomes a payment link once.
export async function reconcileCollections({ db, rails }: Deps, month?: number) {
  const open = db.all<Collection>(`SELECT * FROM collection WHERE status IN ('notified', 'failed') ${month ? "AND month = ?" : ""} ORDER BY id`, ...(month ? [month] : []));
  for (const c of open) {
    const m = db.member(c.member);
    try {
      if (c.status === "failed") {
        // A declined debit falls back to a checkout order at once. A creation that failed (say, a rate limit) is
        // retried at most once every 20 seconds, so Razorpay is not hammered.
        const declined = c.method === "mandate", creationFailed = c.method === "checkout" && !c.order_id;
        if (declined || (creationFailed && Date.now() - Date.parse(c.at) > 20000)) {
          db.run("UPDATE collection SET at = ? WHERE id = ?", db.now(), c.id);
          await sendOrder({ db, rails } as Deps, c.month, m, c.amount, c.marker, `${db.chit()!.name}: month ${c.month} instalment, ticket ${m.ticket}`, c.id);
        }
        continue;
      }
      let state: "paid" | "failed" | "waiting" = "waiting", paymentId = c.payment_id;
      if (c.method === "mandate" && c.payment_id) {
        const s = await rails.paymentState(c.payment_id);
        state = s === "captured" ? "paid" : s === "failed" ? "failed" : "waiting";
      } else if (c.order_id) {
        const captured = (await rails.orderPayments(c.order_id)).find((x) => x.status === "captured");
        if (captured) { state = "paid"; paymentId = captured.paymentId; }
      } else if (c.link_id) {
        const s = await rails.paymentLinkState(c.link_id);
        if (s.paid) { state = "paid"; paymentId = s.paymentId; }
      }
      if (state === "paid") settleCollection(db, c, paymentId);
      else if (state === "failed") {
        db.run("UPDATE collection SET status = 'failed', error = 'debit declined' WHERE id = ?", c.id);
        db.say(c.month, "razorpay", "declined", `${m.name}'s debit of ${inr(c.amount)} was declined.`, { member: m.id });
      }
    } catch (e) { console.error(`reconcile collection ${c.marker}: ${errText(e)}`); }
  }
}

export function settleCollection(db: Db, c: Collection, paymentId: string | null) {
  const won = db.run("UPDATE collection SET status = 'paid', payment_id = COALESCE(?, payment_id), paid_at = ? WHERE id = ? AND status != 'paid'", paymentId, db.now(), c.id).changes;
  if (!won) return;
  const m = db.member(c.member);
  const chit = db.chit()!;
  const lateNow = c.month <= chit.month_done; // paid after the auction closed: clears the arrears
  if (lateNow && m.arrears > 0) db.run("UPDATE member SET arrears = arrears - 1 WHERE id = ?", m.id);
  // Routine collections are summed up in the month's "collected" line; a real checkout payment or a late one gets its own.
  const realPay = Boolean(paymentId && !paymentId.startsWith("pay_fake"));
  if ((c.method !== "mandate" && realPay) || lateNow) db.say(c.month, "razorpay", "paid", `${inr(c.amount)} received from ${m.name}${c.method === "checkout" ? ` at checkout (${paymentId ?? "payment"})` : c.method === "link" ? " through the payment link" : ""}${lateNow ? "; arrears cleared" : ""}.`, { member: m.id });
}

async function payPrize({ db, rails }: Deps, month: number, winner: Member, amount: number, attempt: number) {
  if (winner.is_foreman) {
    db.run("INSERT OR IGNORE INTO payout (month, member, amount, kind, idempotency, status, at) VALUES (?, 'foreman', ?, 'prize', ?, 'retained', ?)", month, amount, `FM-P-M${month}-foreman`, db.now());
    return;
  }
  const idem = `FM-${runTag(db)}-P-M${month}-${winner.id}-${attempt}`;
  const row = Number(db.run("INSERT INTO payout (month, member, amount, kind, idempotency, status, at) VALUES (?, ?, ?, 'prize', ?, 'pending', ?)", month, winner.id, amount, idem, db.now()).lastInsertRowid);
  try {
    const p = await rails.createPayout(winner.fund_account_id!, amount, idem, idem, `Chit M${month} prize`);
    db.run("UPDATE payout SET payout_id = ?, status = 'sent' WHERE id = ?", p.id, row);
    db.say(month, "razorpay", "payout", `Paying ${inr(amount)} to ${winner.name} by RazorpayX payout. Waiting for the bank.`, { member: winner.id, payout: p.id });
  } catch (e) {
    db.run("UPDATE payout SET status = 'failed', error = ? WHERE id = ?", errText(e), row);
    db.say(month, "razorpay", "error", `RazorpayX did not accept the prize payout to ${winner.name}: ${errText(e)}. It can be sent again.`, { member: winner.id });
  }
}

// Sends a prize again after a failed or reversed payout, with a fresh idempotency key.
export async function retryPrize(deps: Deps, month: number) {
  const last = deps.db.get<Payout>("SELECT * FROM payout WHERE month = ? AND kind = 'prize' ORDER BY id DESC LIMIT 1", month);
  if (!last || !["failed", "reversed"].includes(last.status)) throw new Error("Nothing to retry for that month.");
  const attempts = deps.db.all("SELECT 1 FROM payout WHERE month = ? AND kind = 'prize'", month).length;
  await payPrize(deps, month, deps.db.member(last.member), last.amount, attempts + 1);
}

// One payout has reached a final state. Called by the webhook and by the poller; whichever comes first does the work.
export function payoutSettled(db: Db, payoutId: string, status: string, utr: string | null, detail?: string): string {
  const p = db.get<Payout>("SELECT * FROM payout WHERE payout_id = ? AND status IN ('sent', 'processing')", payoutId);
  if (!p) return "nothing waiting on this payout";
  const m = db.member(p.member);
  if (status === "processed") {
    if (!db.run("UPDATE payout SET status = 'processed', utr = ? WHERE id = ? AND status IN ('sent', 'processing')", utr, p.id).changes) return "already recorded";
    db.say(p.month, "razorpay", "processed", `Bank confirmed: ${inr(p.amount)} is in ${m.name}'s account${utr ? ` (UTR ${utr})` : ""}.`, { member: m.id });
    return "recorded";
  }
  if (["reversed", "failed", "cancelled", "rejected"].includes(status)) {
    db.run("UPDATE payout SET status = ?, error = ? WHERE id = ?", status === "reversed" ? "reversed" : "failed", detail ?? status, p.id);
    db.say(p.month, "razorpay", "error", `The prize payout to ${m.name} came back ${status}${detail ? ` (${detail})` : ""}. The foreman can send it again.`, { member: m.id });
    return "marked failed";
  }
  if (status === "processing" && p.status === "sent") db.run("UPDATE payout SET status = 'processing' WHERE id = ?", p.id);
  return `still ${status}`;
}

// Safety net for webhooks that never arrive: ask Razorpay directly about everything still in flight.
export async function reconcile(deps: Deps) {
  await reconcileCollections(deps);
  for (const p of deps.db.all<Payout>("SELECT * FROM payout WHERE status IN ('sent', 'processing') AND payout_id IS NOT NULL")) {
    try {
      const s = await deps.rails.payoutState(p.payout_id!);
      payoutSettled(deps.db, p.payout_id!, s.status, s.utr, s.detail);
    } catch (e) { console.error(`reconcile payout ${p.payout_id}: ${errText(e)}`); }
  }
}

// The record the Act asks the foreman to keep of every draw, written by code from the same numbers that moved.
function writeMinutes(chitName: string, t: ReturnType<Db["terms"]>, month: number, d: Draw, bids: { name: string; wants: number; max_discount_pct: number }[], winnerName: string, late: string[]): string {
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const lines = [
    `MINUTES OF THE PROCEEDINGS OF THE DRAW`, `${chitName} — instalment ${month} of ${t.members}`, `Date: ${date}. Conducted electronically; subscribers represented by their authorised agents.`, ``,
    `Gross chit amount: ${inr(t.gross)}. Instalment: ${inr(instalment(t))}. Foreman's commission: ${t.commissionPct}% (${inr(floorDiscount(t))}). Ceiling on discount: ${t.maxDiscountPct}% (${inr(ceilingDiscount(t))}).`,
    late.length ? `Subscribers in arrears and not eligible to bid: ${late.join(", ")}.` : `All subscribers paid up; all unprized subscribers eligible to bid.`, ``,
  ];
  if (d.how === "foreman") lines.push(`The foreman took the first instalment's pot at the floor discount, as provided in the chit agreement.`);
  else if (d.how === "last") lines.push(`${winnerName}, being the only unprized subscriber, took the pot at the floor discount.`);
  else {
    lines.push(`Bids received (largest discount each subscriber offered):`);
    for (const b of bids) lines.push(`  ${b.name}: ${b.wants ? `${b.max_discount_pct}%` : "did not bid"}`);
    lines.push(``, d.how === "lot" ? `The highest offers tied, and the draw was decided by lot in favour of ${winnerName}.` : `The highest offer was ${winnerName}'s. The discount was settled at one increment (${t.stepPct}%) above the next offer.`);
  }
  lines.push(``, `RESULT: Prized subscriber ${winnerName}. Discount ${inr(d.discount)} (${pct(d.discount, t.gross)}%). Net chit amount paid to the prized subscriber: ${inr(d.prize)}. Foreman's commission: ${inr(d.commission)}. Share of discount to every ticket: ${inr(d.share)}, credited against the next instalment.`,
    ``, `Recorded by FOREMAN from the figures that moved on Razorpay. Section references: Chit Funds Act, 1982, ss. 6, 21, 22.`);
  return lines.join("\n");
}
