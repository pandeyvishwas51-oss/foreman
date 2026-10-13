// Which Razorpay and which agents this process runs with, decided once from the environment.
import { claudeBrain, claudePlanBrain, scriptedBrain, type Brain } from "./brain.ts";
import { fakeRails } from "./fakerails.ts";
import { razorpayTest } from "./razorpay.ts";
import type { Rails } from "./rails.ts";

export function loadConfig(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID, keySecret = env.RAZORPAY_KEY_SECRET, accountNumber = env.RAZORPAYX_ACCOUNT_NUMBER;
  const live = Boolean(keyId && keySecret);
  const fake = fakeRails({ declineChargeFor: new Set(["rajan:M3"]) }); // one declined debit in the simulation, to show the fallback
  let rails: Rails = fake;
  if (live) {
    const real = razorpayTest({ keyId: keyId!, keySecret: keySecret!, accountNumber: accountNumber ?? "", webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, mandateMethod: env.RAZORPAY_MANDATE === "upi" ? "upi" : "card" });
    // RazorpayX payouts need a business current account on the merchant. Without one, every other call is real and
    // only the prize payout runs on the simulated rail, and the page says so.
    rails = accountNumber ? real : { ...real, mode: "razorpay-test-no-x", createPayout: fake.createPayout, payoutState: fake.payoutState };
  }
  const brain: Brain = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? claudeBrain()
    : env.FOREMAN_AGENTS === "claude-plan" ? claudePlanBrain() : scriptedBrain();
  return { rails, live, brain, publicUrl: (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL)?.replace(/\/$/, "") ?? null, port: Number(env.PORT ?? 8788) };
}
