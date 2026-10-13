// Which Razorpay and which agents this process runs with, decided once from the environment.
import { claudeBrain, claudePlanBrain, scriptedBrain, type Brain } from "./brain.ts";
import { fakeRails } from "./fakerails.ts";
import { razorpayTest } from "./razorpay.ts";
import type { Rails } from "./rails.ts";

export function loadConfig(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID, keySecret = env.RAZORPAY_KEY_SECRET, accountNumber = env.RAZORPAYX_ACCOUNT_NUMBER;
  const live = Boolean(keyId && keySecret && accountNumber);
  const rails: Rails = live
    ? razorpayTest({ keyId: keyId!, keySecret: keySecret!, accountNumber: accountNumber!, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, mandateMethod: env.RAZORPAY_MANDATE === "upi" ? "upi" : "card" })
    : fakeRails({ declineChargeFor: new Set(["rajan:M3"]) }); // one declined debit in the simulation, to show the fallback
  const brain: Brain = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? claudeBrain()
    : env.FOREMAN_AGENTS === "claude-plan" ? claudePlanBrain() : scriptedBrain();
  return { rails, live, brain, publicUrl: (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL)?.replace(/\/$/, "") ?? null, port: Number(env.PORT ?? 8788) };
}
