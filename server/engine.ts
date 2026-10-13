// The chit fund maths. Pure functions over integer paise; nothing here talks to Razorpay or to a model.
//
// Words follow the Chit Funds Act, 1982 (as amended 2019):
//   gross chit amount  G   what every subscriber pays in over the whole chit, and what is auctioned each month
//   instalment         I   G / n, paid by each of the n subscribers every month, less their share of discount
//   discount           d   what the month's winner forgoes to take the pot early; the auction decides it
//   foreman commission c   the foreman's fixed cut, at most 7% of G under the Act (5% is the norm)
//   net chit amount        G - d, paid to the winner
//   share of discount      (d - c) / n, credited to every subscriber against next month's instalment

export type Terms = {
  gross: number;            // paise
  members: number;          // n subscribers, one per month
  commissionPct: number;    // of gross, e.g. 5
  maxDiscountPct: number;   // ceiling on the auction, e.g. 40 (set by state rules)
  stepPct: number;          // the bidding increment of the open auction, e.g. 0.5
  foremanFirst: boolean;    // customary: the foreman holds one ticket and takes the first month's pot at the floor discount
};
// Note on tickets: `members` counts tickets, one per month. With foremanFirst the foreman holds the first ticket,
// pays its instalments like everyone else, and the other members - 1 tickets are the subscribers who bid.

export type Bid = { member: string; maxDiscountPct: number }; // the most this member is willing to forgo
export type Draw = {
  month: number; winner: string; discount: number; prize: number; commission: number; share: number; // paise, share per member
  how: "auction" | "foreman" | "lot" | "last"; bidders: string[]; secondBest: number | null;      // secondBest in paise
};

export const instalment = (t: Terms) => t.gross / t.members;
export const floorDiscount = (t: Terms) => pct(t.gross, t.commissionPct);
export const ceilingDiscount = (t: Terms) => pct(t.gross, t.maxDiscountPct);
export const pct = (amount: number, p: number) => Math.round((amount * p) / 100);

export function checkTerms(t: Terms): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(t.gross) || t.gross <= 0) problems.push("gross chit amount must be whole paise");
  if (!Number.isInteger(t.members) || t.members < 2) problems.push("a chit needs at least two subscribers");
  if (t.gross % t.members !== 0) problems.push("gross chit amount must divide evenly into instalments");
  if (t.commissionPct < 0 || t.commissionPct > 7) problems.push("foreman commission is capped at 7% by the Act");
  if (t.maxDiscountPct < t.commissionPct || t.maxDiscountPct > 40) problems.push("discount ceiling must be between the commission and 40%");
  if (floorDiscount(t) % t.members !== 0 || ceilingDiscount(t) % t.members !== 0) problems.push("commission and ceiling must give a whole-paise share per subscriber");
  return problems;
}

// What each subscriber owes this month: the instalment less last month's share of discount.
export function dueThisMonth(t: Terms, previous: Draw | null): number {
  return instalment(t) - (previous?.share ?? 0);
}

// An open ascending auction, settled in one step from each agent's ceiling: the keenest bidder wins and pays one
// increment above the runner-up, never more than its own ceiling. With one bidder the discount stays at the floor.
// The month's result is decided entirely here, so the same bids always give the same draw.
export function settle(t: Terms, month: number, bids: Bid[], eligible: string[], seed: string): Draw {
  const floor = floorDiscount(t), ceiling = ceilingDiscount(t), step = pct(t.gross, t.stepPct);
  const commission = floor;
  const finish = (winner: string, discount: number, how: Draw["how"], bidders: string[], secondBest: number | null): Draw => {
    // Discounts are rounded so every subscriber's share is whole paise; the winner gets the rounding, never the foreman.
    const share = Math.floor((discount - commission) / t.members);
    const d = commission + share * t.members;
    return { month, winner, discount: d, prize: t.gross - d, commission, share, how, bidders, secondBest };
  };
  if (t.foremanFirst && month === 1) return finish("foreman", floor, "foreman", [], null);
  if (eligible.length === 1) return finish(eligible[0], floor, "last", [], null);

  const valid = bids
    .filter((b) => eligible.includes(b.member))
    .map((b) => ({ member: b.member, cap: Math.min(ceiling, Math.max(floor, pct(t.gross, b.maxDiscountPct))) }))
    .sort((a, b) => b.cap - a.cap || a.member.localeCompare(b.member));
  if (!valid.length) {
    // Nobody wants the pot this month: the Act lets the foreman draw lots among the unprized subscribers.
    const pick = eligible[hash(`${seed}:${month}`) % eligible.length];
    return finish(pick, floor, "lot", [], null);
  }
  const top = valid.filter((b) => b.cap === valid[0].cap);
  const winner = top.length === 1 ? top[0] : top[hash(`${seed}:${month}`) % top.length];
  const runnerUp = valid.find((b) => b.member !== winner.member) ?? null;
  const price = runnerUp ? Math.min(winner.cap, Math.max(floor, runnerUp.cap + (top.length > 1 ? 0 : step))) : floor;
  return finish(winner.member, price, top.length > 1 && runnerUp && runnerUp.cap === winner.cap ? "lot" : "auction", valid.map((b) => b.member), runnerUp?.cap ?? null);
}

// Every subscriber's cash flows over the chit, month by month: negative when they pay in, positive when prized.
export function flows(t: Terms, draws: Draw[], member: string): number[] {
  return draws.map((d, i) => (d.winner === member ? d.prize : 0) - dueThisMonth(t, draws[i - 1] ?? null));
}

// Internal rate of return per month, as a yearly percentage, by bisection. For a subscriber prized early it is the
// cost of the money they borrowed from the others; for one prized late it is the return on their saving.
export function yearlyRate(cash: number[]): number | null {
  const npv = (r: number) => cash.reduce((s, c, i) => s + c / (1 + r) ** i, 0);
  let lo = -0.99, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return ((1 + (lo + hi) / 2) ** 12 - 1) * 100;
}

// Checks that must hold for any completed chit. Used by the tests and shown on the page as "books balance".
export function audit(t: Terms, draws: Draw[], subscribers: string[]): string[] {
  const problems: string[] = [];
  const paidIn = draws.reduce((s, _d, i) => s + dueThisMonth(t, draws[i - 1] ?? null) * t.members, 0);
  const paidOut = draws.reduce((s, d) => s + d.prize + d.commission, 0);
  if (paidIn !== paidOut) problems.push(`cash in ${paidIn} differs from cash out ${paidOut}`);
  const winners = draws.map((d) => d.winner).filter((w) => w !== "foreman");
  if (new Set(winners).size !== winners.length) problems.push("a subscriber was prized twice");
  if (winners.some((w) => !subscribers.includes(w))) problems.push("someone outside the chit was prized");
  if (draws.length === t.members && subscribers.some((m) => !winners.includes(m))) problems.push("not every subscriber was prized");
  for (const d of draws) {
    if (d.discount < floorDiscount(t) || d.discount > ceilingDiscount(t)) problems.push(`month ${d.month} discount outside the Act's limits`);
    if (d.commission !== floorDiscount(t)) problems.push(`month ${d.month} commission wrong`);
    if ((d.discount - d.commission) !== d.share * t.members) problems.push(`month ${d.month} share does not divide`);
  }
  return problems;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
