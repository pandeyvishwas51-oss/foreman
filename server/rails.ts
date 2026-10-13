// The slice of Razorpay that FOREMAN uses, as one interface with two implementations: the real test-mode API
// (razorpay.ts) and an in-memory stand-in (fakerails.ts) for tests and for running with no keys.

export type Person = { name: string; email: string; contact: string };
export type MandateLink = { id: string; url: string };
export type MandateState = { status: "pending" | "active" | "failed"; tokenId?: string; detail?: string };
export type PaymentState = "created" | "authorized" | "captured" | "failed" | "unknown";
export type PayoutState = { status: "queued" | "pending" | "processing" | "processed" | "cancelled" | "reversed" | "rejected" | "failed"; utr: string | null; detail?: string };

export interface Rails {
  readonly mode: "razorpay-test" | "razorpay-test-no-x" | "razorpay-test-links" | "simulated";
  createCustomer(p: Person, reference: string): Promise<string>;
  // A one-time authorisation the subscriber completes once; every later instalment is debited against it.
  createMandate(customerId: string, p: Person, maxAmount: number, reference: string): Promise<MandateLink>;
  mandateState(customerId: string, mandateId: string): Promise<MandateState>;
  // Debit one instalment against the mandate. Returns Razorpay's payment id; the debit may still be in flight.
  charge(customerId: string, tokenId: string, p: Person, amount: number, marker: string, description: string): Promise<{ orderId: string; paymentId: string }>;
  paymentState(paymentId: string): Promise<PaymentState>;
  // When there is no usable mandate: a Razorpay Order the subscriber pays through Razorpay Checkout on FOREMAN's pay page.
  createOrder(p: Person, amount: number, marker: string, description: string): Promise<string>;
  orderPayments(orderId: string): Promise<{ paymentId: string; status: string }[]>;
  // Checkout hands back a signature over order and payment ids; only a matching one marks an instalment paid.
  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean;
  // Still available for arrears reminders; Razorpay rate-limits link creation, so it is not the monthly rail.
  createPaymentLink(p: Person, amount: number, marker: string, description: string): Promise<{ id: string; url: string }>;
  paymentLinkState(linkId: string): Promise<{ paid: boolean; paymentId: string | null }>;
  // RazorpayX: who gets paid, where, and the payout itself.
  createContact(p: Person, reference: string): Promise<string>;
  createFundAccount(contactId: string, account: { vpa: string } | { name: string; ifsc: string; number: string }): Promise<string>;
  createPayout(fundAccountId: string, amount: number, idempotency: string, reference: string, narration: string): Promise<{ id: string; status: PayoutState["status"] }>;
  payoutState(payoutId: string): Promise<PayoutState>;
  verifyWebhook(headers: Record<string, string | undefined>, raw: string): boolean;
}

export class RailsError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
