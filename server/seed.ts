import type { Db } from "./db.ts";

export const CHIT = { id: "lnt-2026-a", name: "Lakshmi Nagar Traders' Chit", gross: 50_000_000, members: 10, commissionPct: 5, maxDiscountPct: 40, stepPct: 0.5, foremanFirst: true };

// Ticket 1 is the foreman's own. The other nine are the subscribers whose agents bid. Notes are the owners' own
// words; the agents work from these and nothing else.
export const MEMBERS = [
  { id: "balaji", name: "Sri Balaji Chits", trade: "Registered foreman", phone: "9000000001", notes: "Foreman's ticket. Takes month one at the floor, as the chit agreement says." },
  { id: "revathi", name: "Revathi Sundaram", trade: "Tailoring unit", phone: "9000000002", notes: "I want to buy a computerised embroidery machine before wedding season. Month 3 or 4 is ideal, month 2 is fine too. The machine costs about ₹3.8 lakh, so anything above ₹3.7 lakh in hand works for me. Do not give away more than a quarter of the chit for it." },
  { id: "imran", name: "Imran Shaikh", trade: "Auto spare parts", phone: "9000000003", notes: "Diwali stocking is in month 4 or 5. I earn well on that stock, so I can give up to 30% if I must, but try not to. Before month 3 I have no use for the money." },
  { id: "kamala", name: "Kamala Devi", trade: "Retired teacher", phone: "9000000004", notes: "I joined this chit to save. I do not want the money early. Never bid for me; I will take whatever comes at the end." },
  { id: "suresh", name: "Suresh Babu", trade: "Tiffin service", phone: "9000000005", notes: "I would like to add a second kitchen, but only if the money is cheap. If last month's pot went above 15% I am not interested. My limit is 14%." },
  { id: "fatima", name: "Fatima Begum", trade: "Pharmacy", phone: "9000000006", notes: "My daughter's college fee is due in month 7. I need the pot in month 6, 7 or 8, not before. Up to 20% is acceptable; the bank quoted me 16% a year for a loan and this is simpler." },
  { id: "rajan", name: "Rajan Pillai", trade: "Two-wheeler garage", phone: "9000000007", notes: "If nobody else wants it I will take it any month and buy a lift for the garage. But I will not pay more than 12%." },
  { id: "meena", name: "Meena Krishnan", trade: "Beauty parlour", phone: "9000000008", notes: "URGENT: the deposit on my new shop is due next month (month 2). I must have the pot in month 2, even at 35%. After month 2 I do not need it at all." },
  { id: "dinesh", name: "Dinesh Kumar", trade: "Printing press", phone: "9000000009", notes: "I am saving for a new machine next year. I would take the pot only at the floor discount, never a paisa more." },
  { id: "priya", name: "Priya Nair", trade: "Home bakery", phone: "9000000010", notes: "I want a deck oven, ideally month 5 (orders pick up from month 6). Months 4 to 6 are fine. I can give up to 18%." },
];

export function seed(db: Db) {
  db.wipe();
  db.run("INSERT INTO chit (id, name, gross, members, commissionPct, maxDiscountPct, stepPct, foremanFirst, status, seed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'setup', ?)",
    CHIT.id, CHIT.name, CHIT.gross, CHIT.members, CHIT.commissionPct, CHIT.maxDiscountPct, CHIT.stepPct, CHIT.foremanFirst ? 1 : 0, `${CHIT.id}:${Date.now()}`);
  MEMBERS.forEach((m, i) => {
    db.run("INSERT INTO member (id, ticket, name, trade, email, phone, vpa, notes, is_foreman) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.id, i + 1, m.name, m.trade, `${m.id}@foreman.example`, m.phone, `${m.id}@okaxis`, m.notes, m.id === "balaji" ? 1 : 0);
  });
}
