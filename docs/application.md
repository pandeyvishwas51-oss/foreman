# Razorpay AI Builders application (draft)

Form: https://razorpay.typeform.com/to/Aj64eENJ

**Show us the magic (demo URL):** <hosted FOREMAN link>
**Where is the magic made (repo):** https://github.com/pandeyvishwas51-oss/foreman

**Tell us the story behind it:**

A chit fund is India's oldest savings circle, and it still runs on WhatsApp and trust: ten people, ₹50,000 a month, and every
month the pot goes to whoever gives up the biggest discount. I built FOREMAN to run one end to end on Razorpay, in the four days
after the form said "fresh work, core logic over polish".

Every subscriber has an AI agent that reads only its owner's own words ("I need the pot by month 3 for an embroidery machine,
don't give away more than a quarter") and says two things: do we want the pot this month, and the most we would forgo. That is
the only judgment a model makes. The auction is settled in code so that honest ceilings are the best strategy (the winner pays one
step above the runner-up), the shares of discount are whole paise, the commission respects the Chit Funds Act's 7% cap, and the
minutes the Act requires are written from the same numbers that moved. If an agent fails, its subscriber does not bid; a model
never does arithmetic on money.

Razorpay carries it: a one-time registration link per subscriber gives a standing mandate, and because a chit instalment changes
every month, the debits go through Recurring Payments (order + payments/create/recurring against the token) rather than a fixed
Subscription plan. A declined debit becomes a Payment Link with Razorpay's reminders and that ticket sits out the auction until it
pays. The prize goes out by RazorpayX payout with an idempotency key, a reversed payout can be re-sent under a new key, and webhooks
are signature-checked and deduplicated with polling as the safety net. Twelve tests include 300 random chits that must balance to
the paisa and every subscriber prized exactly once.

The page shows it rather than tells it: Hathi, the elephant foreman, walks the ring as instalments land, stands at the pot for the
auction, carries the prize to the winner, and writes the minutes. Rule-based agents stand in when no model is configured and the
page says so; the video is the Claude agents on Razorpay test mode.

Why this problem: digital chit platforms already exist, but none lets a subscriber delegate the auction to an agent that bids the
way they would, and none produces the statutory record from the payment rail itself. Razorpay's own "Agentic Payments" direction
is the same idea from the other side: money that moves because an agent decided, inside limits set in code.

**Contact:** (user's name, email, phone)
**Experience:** (user's choice)
**Team:** Engineering
