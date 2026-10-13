export type Chit = { id: string; name: string; gross: number; members: number; commissionPct: number; maxDiscountPct: number; stepPct: number; foremanFirst: number; status: "setup" | "running" | "complete"; month_done: number };
export type Member = { id: string; ticket: number; name: string; trade: string; phone: string; vpa: string; notes: string; is_foreman: number; mandate_status: "none" | "sent" | "active" | "failed"; mandate_url: string | null; prized_month: number | null; arrears: number };
export type Draw = { month: number; winner: string; discount: number; prize: number; commission: number; share: number; how: "auction" | "foreman" | "lot" | "last"; bidders: string; second_best: number | null; minutes: string; decided_at: string };
export type Bid = { id: number; month: number; member: string; wants: number; max_discount_pct: number; reason: string; source: string };
export type Collection = { id: number; month: number; member: string; amount: number; method: string; marker: string; payment_id: string | null; link_id: string | null; link_url: string | null; status: string; error: string | null; at: string; paid_at: string | null };
export type Payout = { id: number; month: number; member: string; amount: number; kind: string; idempotency: string; payout_id: string | null; status: string; utr: string | null; error: string | null; at: string };
export type Event = { id: number; month: number | null; at: string; actor: string; kind: string; text: string; data: string | null };
export type Received = { id: string; event: string; ref: string | null; at: string; outcome: string | null };
export type Outcome = { id: string; paidIn: number; received: number; yearlyRate: number | null };
export type State = {
  rails: "razorpay-test" | "simulated"; agents: "claude" | "scripted"; webhooks: boolean; busy: string | null;
  chit: Chit | null; instalment: number | null; dueNext: number | null; members: Member[]; draws: Draw[]; bids: Bid[]; collections: Collection[]; payouts: Payout[];
  events: Event[]; received: Received[]; outcomes: Outcome[]; audit: string[] | null;
};

export const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
export const pctOf = (paise: number, gross: number) => `${Math.round((paise / gross) * 10000) / 100}%`;
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
