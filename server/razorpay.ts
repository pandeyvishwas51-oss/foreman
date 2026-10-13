import { createHmac, timingSafeEqual } from "node:crypto";
import { RailsError, type MandateState, type PaymentState, type PayoutState, type Person, type Rails } from "./rails.ts";

export type Keys = { keyId: string; keySecret: string; accountNumber: string; webhookSecret?: string; mandateMethod: "card" | "upi" | "none" };

const BASE = "https://api.razorpay.com";

// ponytail: test keys only, on purpose. Live keys would move real money; nothing in FOREMAN is meant to yet.
export function razorpayTest(k: Keys): Rails {
  if (!k.keyId.startsWith("rzp_test_")) throw new Error("FOREMAN only runs with Razorpay TEST keys (rzp_test_...).");
  const auth = `Basic ${Buffer.from(`${k.keyId}:${k.keySecret}`).toString("base64")}`;

  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}${path}`, {
        method, headers: { Authorization: auth, "Content-Type": "application/json", ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 600 * 2 ** attempt)); continue; }
      let detail = text.slice(0, 400);
      try { detail = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? detail; } catch { /* keep text */ }
      throw new RailsError(res.status, `${method} ${path} -> ${res.status}: ${detail}`);
    }
  }
  const tenYears = () => Math.floor(Date.now() / 1000) + 10 * 365 * 86400;

  return {
    mode: "razorpay-test",

    async createCustomer(p, reference) {
      const c = await call<{ id: string }>("POST", "/v1/customers", { name: p.name, email: p.email, contact: p.contact, fail_existing: "0", notes: { foreman: reference } });
      return c.id;
    },

    // A registration link: the subscriber pays ₹1 once (card) or authorises a UPI AutoPay mandate (upi). What comes
    // back is an invoice; when it is paid, the payment carries the token every later debit is made against.
    async createMandate(customerId, p, maxAmount, reference) {
      if (k.mandateMethod === "none") throw new RailsError(0, "mandates are switched off (RAZORPAY_MANDATE=none)");
      const link = await call<{ id: string; short_url: string }>("POST", "/v1/subscription_registration/auth_links", {
        customer: { name: p.name, email: p.email, contact: p.contact }, type: "link", amount: k.mandateMethod === "upi" ? 0 : 100, currency: "INR",
        description: `FOREMAN: monthly chit instalment mandate for ${p.name}`,
        subscription_registration: { method: k.mandateMethod, max_amount: maxAmount, expire_at: tenYears(), frequency: "monthly" },
        receipt: reference, email_notify: false, sms_notify: false, notes: { foreman: reference, customer_id: customerId },
      });
      return { id: link.id, url: link.short_url };
    },

    async mandateState(customerId, mandateId) {
      const inv = await call<{ status: string; payment_id: string | null }>("GET", `/v1/invoices/${mandateId}`);
      if (inv.status === "cancelled" || inv.status === "expired") return { status: "failed", detail: inv.status };
      if (inv.status !== "paid" || !inv.payment_id) return { status: "pending", detail: inv.status };
      const pay = await call<{ token_id: string | null }>("GET", `/v1/payments/${inv.payment_id}`);
      if (!pay.token_id) return { status: "pending", detail: "paid, token not issued yet" };
      const tok = await call<{ recurring_details?: { status: string }; status?: string }>("GET", `/v1/customers/${customerId}/tokens/${pay.token_id}`);
      const st = tok.recurring_details?.status ?? tok.status ?? "confirmed";
      if (st === "rejected" || st === "cancelled") return { status: "failed", tokenId: pay.token_id, detail: st };
      return st === "confirmed" ? { status: "active", tokenId: pay.token_id } : { status: "pending", tokenId: pay.token_id, detail: st };
    },

    // Two calls, as Razorpay's recurring flow requires: an order for the amount, then a payment against the token.
    // For UPI AutoPay the debit lands after the 24-hour pre-debit notice; for cards in test mode it is immediate.
    async charge(customerId, tokenId, p, amount, marker, description) {
      const order = await call<{ id: string }>("POST", "/v1/orders", { amount, currency: "INR", payment_capture: true, receipt: marker, notes: { foreman: marker } });
      const pay = await call<{ razorpay_payment_id: string }>("POST", "/v1/payments/create/recurring", {
        email: p.email, contact: p.contact, amount, currency: "INR", order_id: order.id, customer_id: customerId, token: tokenId, recurring: "1", description, notes: { foreman: marker },
      });
      return { orderId: order.id, paymentId: pay.razorpay_payment_id };
    },

    async paymentState(paymentId) {
      const p = await call<{ status: string }>("GET", `/v1/payments/${paymentId}`);
      return (["created", "authorized", "captured", "failed"].includes(p.status) ? p.status : "unknown") as PaymentState;
    },

    async createOrder(p, amount, marker, description) {
      const o = await call<{ id: string }>("POST", "/v1/orders", { amount, currency: "INR", receipt: marker.slice(0, 40), notes: { foreman: marker, description, subscriber: p.name } });
      return o.id;
    },

    async orderPayments(orderId) {
      const r = await call<{ items: { id: string; status: string }[] }>("GET", `/v1/orders/${orderId}/payments`);
      return r.items.map((x) => ({ paymentId: x.id, status: x.status }));
    },

    verifyCheckout(orderId, paymentId, signature) {
      const want = createHmac("sha256", k.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
      return signature.length === want.length && timingSafeEqual(Buffer.from(signature), Buffer.from(want));
    },

    async createPaymentLink(p, amount, marker, description) {
      const link = await call<{ id: string; short_url: string }>("POST", "/v1/payment_links", {
        amount, currency: "INR", description, reference_id: marker, customer: { name: p.name, email: p.email, contact: p.contact },
        notify: { sms: false, email: false }, reminder_enable: true, notes: { foreman: marker },
      });
      return { id: link.id, url: link.short_url };
    },

    async paymentLinkState(linkId) {
      const l = await call<{ status: string; payments: { payment_id: string; status: string }[] | null }>("GET", `/v1/payment_links/${linkId}`);
      const paid = l.status === "paid";
      return { paid, paymentId: l.payments?.find((x) => x.status === "captured")?.payment_id ?? null };
    },

    async createContact(p, reference) {
      const c = await call<{ id: string }>("POST", "/v1/contacts", { name: p.name, email: p.email, contact: p.contact, type: "customer", reference_id: reference });
      return c.id;
    },

    async createFundAccount(contactId, account) {
      const body = "vpa" in account
        ? { contact_id: contactId, account_type: "vpa", vpa: { address: account.vpa } }
        : { contact_id: contactId, account_type: "bank_account", bank_account: { name: account.name, ifsc: account.ifsc, account_number: account.number } };
      return (await call<{ id: string }>("POST", "/v1/fund_accounts", body)).id;
    },

    async createPayout(fundAccountId, amount, idempotency, reference, narration) {
      const p = await call<{ id: string; status: PayoutState["status"] }>("POST", "/v1/payouts", {
        account_number: k.accountNumber, fund_account_id: fundAccountId, amount, currency: "INR", mode: amount > 20_000_000 ? "NEFT" : "IMPS", purpose: "payout",
        queue_if_low_balance: true, reference_id: reference.slice(0, 40), narration: narration.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 30), notes: { foreman: reference },
      }, { "X-Payout-Idempotency": idempotency });
      return { id: p.id, status: p.status };
    },

    async payoutState(payoutId) {
      const p = await call<{ status: PayoutState["status"]; utr: string | null; status_details?: { description?: string } }>("GET", `/v1/payouts/${payoutId}`);
      return { status: p.status, utr: p.utr, detail: p.status_details?.description };
    },

    // HMAC-SHA256 of the raw body with the webhook secret, compared in constant time.
    verifyWebhook(headers, raw) {
      const given = headers["x-razorpay-signature"];
      if (!k.webhookSecret || !given) return false;
      const want = createHmac("sha256", k.webhookSecret).update(raw).digest("hex");
      return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
    },
  };
}
