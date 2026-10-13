// In-memory Razorpay for tests and for running with no keys. Mandates activate on their own, debits land at once,
// payment links are "paid by the subscriber" a few seconds later, and payouts move queued -> processing -> processed.
// Faults can be injected per member to exercise the fallbacks.
import type { MandateState, PaymentState, PayoutState, Person, Rails } from "./rails.ts";

export type Fault = { declineChargeFor?: Set<string>; failMandateFor?: Set<string>; failPayoutFor?: Set<string> };

export function fakeRails(fault: Fault = {}, clock = { linkPaysAfterMs: 2500, payoutDoneAfterMs: 3000 }) {
  let n = 0;
  const id = (p: string) => `${p}_fake${String(++n).padStart(6, "0")}`;
  const mandates = new Map<string, { customer: string; person: Person; token: string; createdAt: number }>();
  const payments = new Map<string, PaymentState>();
  const links = new Map<string, { createdAt: number; paymentId: string | null; amount: number }>();
  const payouts = new Map<string, { createdAt: number; fail: boolean; amount: number }>();
  const contacts = new Map<string, Person>();
  const now = () => Date.now();
  const bad = (set: Set<string> | undefined, person: Person) => Boolean(set && [...set].some((m) => person.email.startsWith(`${m}@`)));

  const rails: Rails & { tick(): void; declineNext(email: string): void } = {
    mode: "simulated",
    async createCustomer(p) { contacts.set(p.email, p); return id("cust"); },
    async createMandate(customerId, p) {
      const m = id("inv");
      mandates.set(m, { customer: customerId, person: p, token: id("token"), createdAt: now() });
      return { id: m, url: `https://rzp.io/fake/${m}` };
    },
    async mandateState(_c, mandateId): Promise<MandateState> {
      const m = mandates.get(mandateId)!;
      if (bad(fault.failMandateFor, m.person)) return { status: "failed", detail: "subscriber did not authorise the mandate" };
      return now() - m.createdAt > 1500 ? { status: "active", tokenId: m.token } : { status: "pending", detail: "waiting for the subscriber" };
    },
    async charge(_c, _t, p, amount, marker) {
      // Faults are "member" (first debit declines) or "member:M3" (the month-3 debit declines).
      const key = p.email.split("@")[0], month = marker.match(/-M(\d+)-/)?.[1];
      const hit = [key, `${key}:M${month}`].find((k) => fault.declineChargeFor?.has(k));
      const pay = id("pay");
      if (hit) {
        fault.declineChargeFor!.delete(hit); // one decline, then the fallback link takes over
        payments.set(pay, "failed");
      } else payments.set(pay, "captured");
      void amount;
      return { orderId: id("order"), paymentId: pay };
    },
    async paymentState(paymentId) { return payments.get(paymentId) ?? "unknown"; },
    async createPaymentLink(_p, amount) { const l = id("plink"); links.set(l, { createdAt: now(), paymentId: null, amount }); return { id: l, url: `https://rzp.io/fake/${l}` }; },
    async paymentLinkState(linkId) {
      const l = links.get(linkId)!;
      if (!l.paymentId && now() - l.createdAt > clock.linkPaysAfterMs) { l.paymentId = id("pay"); payments.set(l.paymentId, "captured"); }
      return { paid: Boolean(l.paymentId), paymentId: l.paymentId };
    },
    async createContact(p) { return id("cont"); },
    async createFundAccount() { return id("fa"); },
    async createPayout(fundAccountId, amount, idempotency) {
      const existing = [...payouts.entries()].find(([k]) => k.endsWith(idempotency));
      if (existing) return { id: existing[0], status: "processing" };
      const p = `pout_${idempotency}`;
      payouts.set(p, { createdAt: now(), fail: Boolean(fault.failPayoutFor && [...fault.failPayoutFor].some((m) => idempotency.includes(m))), amount });
      void fundAccountId;
      return { id: p, status: "processing" };
    },
    async payoutState(payoutId): Promise<PayoutState> {
      const p = payouts.get(payoutId)!;
      if (now() - p.createdAt < clock.payoutDoneAfterMs) return { status: "processing", utr: null };
      return p.fail ? { status: "reversed", utr: null, detail: "beneficiary bank returned the transfer" } : { status: "processed", utr: `UTR${payoutId.slice(-8).toUpperCase()}` };
    },
    verifyWebhook() { return false; },
    tick() { /* time-based; nothing to do */ },
    declineNext(email) { (fault.declineChargeFor ??= new Set()).add(email.split("@")[0]); },
  };
  return rails;
}
