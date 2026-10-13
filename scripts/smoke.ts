// Exercises the Razorpay test-mode calls FOREMAN depends on, with the keys in .env, and cleans nothing up:
// test-mode objects are free. Run: npm run smoke
import { loadConfig } from "../server/config.ts";

const { rails, live } = loadConfig();
if (!live) throw new Error("Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAYX_ACCOUNT_NUMBER in .env first.");
const p = { name: "Smoke Test", email: "smoke@foreman.example", contact: "9000000099" };
const stamp = Date.now().toString(36);

const customer = await rails.createCustomer(p, `smoke:${stamp}`);
console.log("customer", customer);
const mandate = await rails.createMandate(customer, p, 5_000_000, `smoke:${stamp}:mandate`);
console.log("registration link", mandate.id, mandate.url);
console.log("mandate state", await rails.mandateState(customer, mandate.id));
const link = await rails.createPaymentLink(p, 5_000_000, `FM-smoke-${stamp}`, "FOREMAN smoke test instalment");
console.log("payment link", link.id, link.url);
console.log("link state", await rails.paymentLinkState(link.id));
const contact = await rails.createContact(p, `smoke:${stamp}`);
const fund = await rails.createFundAccount(contact, { name: p.name, ifsc: "HDFC0000053", number: "501000000099" });
console.log("contact", contact, "fund account", fund);
const payout = await rails.createPayout(fund, 100, `smoke-${stamp}`, `FM-smoke-${stamp}`, "FOREMAN smoke");
console.log("payout", payout);
console.log("payout state", await rails.payoutState(payout.id));
console.log("\nAuthorise the registration link with a test card, then re-run to see the token confirmed.");
