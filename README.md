# FOREMAN

**AI agents run a chit fund. Razorpay moves the money.**

A chit fund is India's oldest savings circle: ten people pay ₹50,000 a month, and every month the ₹5,00,000 pot goes to whoever
offers to forgo the biggest discount. The discount is shared back to everyone as a cut in next month's instalment. Taking the pot
early is a loan from the others; waiting is saving. Registered chits move tens of thousands of crores a year, and informal
"committees" many times more, almost all of it on WhatsApp, cash and trust.

FOREMAN runs one. Each subscriber has an AI agent that works only from its owner's own words ("I need the pot by month 3 for an
embroidery machine, don't give away more than a quarter"). Every month:

1. **Collect.** Razorpay debits each ticket's instalment against a standing mandate; a ticket without a usable mandate gets a Payment Link with reminders.
2. **Auction.** Each unprized, paid-up subscriber's agent names the most discount its owner would forgo. The auction is settled in code: the keenest bidder wins and pays one increment above the runner-up.
3. **Pay.** The net chit amount goes to the winner by RazorpayX payout; the foreman's commission stays as a ledger entry; everyone's next instalment falls by their share of the discount.
4. **Record.** The minutes of the draw the Chit Funds Act asks for are written from the same figures that moved.

The maths is deterministic integer paise under the Act's limits (commission ≤ 7%, discount ceiling, whole-paise shares). No model
ever does arithmetic on money. An agent that fails means its subscriber does not bid, never a guess.

Hathi, the elephant foreman, walks the page as it happens: round the ring while instalments land, to the pot for the auction, to
the winner with the prize, then to the minutes.

## Run it

```
npm install && npm run build && npm start
open http://localhost:8788
```

With nothing configured, FOREMAN runs on a simulated Razorpay with rule-based agents and says so on the page. Click
**Open the chit on Razorpay**, then **Run month 1**, **Run month 2**, and so on. Months 2 to 9 are auctions; month 3 includes a
declined debit that falls back to a Payment Link.

**Real mode.** Copy `.env.example` to `.env`. Razorpay **test** keys plus a RazorpayX test account number turn on the real test
rails (customers, registration links for mandates, recurring debits, Payment Links, contacts, fund accounts, payouts, webhooks).
`ANTHROPIC_API_KEY` turns on the Claude agents (`FOREMAN_AGENTS=claude-plan` uses the Claude subscription signed in on the
machine instead). Live keys are refused in code.

Without `RAZORPAYX_ACCOUNT_NUMBER` (RazorpayX needs a business current account), every call is real except the prize
payout, which runs on the simulated rail; the page says so in the header.

In test mode each subscriber's registration link must be authorised once with a Razorpay test card (the page lists the links under
*All 10 tickets*); after that every debit is API-driven. RazorpayX test payouts sit in *processing* until advanced in the dashboard.

```
npm test        # 11 tests: 300 random chits balance to the paisa; declined debit falls back to a link; reversed payout retried; agent failure means no bid
npm run smoke   # exercises the Razorpay test-mode calls with the keys in .env
```

## How it is built

| Layer | What | Where |
|---|---|---|
| Engine | Terms check, instalments, open-auction settlement, shares of discount, IRR per subscriber, audit | `server/engine.ts` |
| Agents | One `decideBid` per subscriber: *wants / max discount % / reason*, from the owner's notes only; Claude (API or Agent SDK) or fixed rules | `server/brain.ts` |
| Month saga | Collect → auction → pay → minutes; retry-safe markers, bounded waits, arrears, payout retry, reconcile | `server/month.ts` |
| Rails | `Rails` interface; Razorpay test client (`razorpay.ts`) and in-memory stand-in with fault injection (`fakerails.ts`) | `server/rails.ts` |
| HTTP | `/api/state`, `/api/start`, `/api/month`, `/api/retry/:month`, `/api/reset`, `/api/minutes/:month`, `/webhooks/razorpay` | `server/index.ts` |
| Page | React + Vite; ring graph, agents stream, outcomes, AG Grid ledgers, Hathi | `web/src` |

**Razorpay primitives used and why.** Recurring Payments (registration link → token → `orders` + `payments/create/recurring`)
because a chit instalment is a *variable* monthly amount, which a fixed-plan Subscription cannot express. Payment Links as the
fallback and for arrears, with Razorpay's own reminders. RazorpayX contacts, fund accounts and payouts with
`X-Payout-Idempotency` for the prize. Webhooks verified with the `X-Razorpay-Signature` HMAC and deduplicated on
`X-Razorpay-Event-Id`, with polling as the safety net.

**Money correctness.** Every instalment, prize, commission and share is integer paise. A month's work is written with markers that
make a retry find its earlier attempt instead of charging twice. A prize payout that comes back reversed can be sent again under a
new idempotency key. `audit()` proves on every completed chit that cash in equals cash out, that every subscriber was prized exactly
once, and that every draw stayed inside the Act's limits; the property test does this for 300 random chits.

## What exists already, and what is new here

Digital chit platforms exist (myPaisaa, ChitMonks, The Money Club, KyePot): digital collections, online auctions, KYC. None has an
agent that bids for a subscriber from their own words, none settles the auction from agents' ceilings so that honest ceilings are
the best strategy, and none writes the statutory minutes from the money movement itself. That is the layer FOREMAN adds, on
Razorpay's rails.

## Honesty notes

The HTTP API has no authentication: it is a single-chit demo, with the model-calling route capped per hour. Put it behind a login before pointing it at anything but test keys.

FOREMAN is a demonstration on Razorpay's test mode. It is not a registered chit fund and moves no real money. The discount ceiling
is configurable because it is set by state rules; the commission cap of 7% is from the Act as amended in 2019. Rule-based agents
pause between answers only so the page can be read.

MIT licensed.
