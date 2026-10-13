import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Terms } from "./engine.ts";

export type Chit = Terms & { id: string; name: string; status: "setup" | "running" | "complete"; month_done: number; started: string | null; seed: string };
export type Member = {
  id: string; ticket: number; name: string; trade: string; email: string; phone: string; vpa: string; notes: string; is_foreman: number;
  customer_id: string | null; mandate_id: string | null; mandate_url: string | null; token_id: string | null;
  mandate_status: "none" | "sent" | "active" | "failed"; contact_id: string | null; fund_account_id: string | null;
  prized_month: number | null; arrears: number;
};
export type DrawRow = { month: number; winner: string; discount: number; prize: number; commission: number; share: number; how: string; bidders: string; second_best: number | null; minutes: string; decided_at: string };
export type BidRow = { id: number; month: number; member: string; wants: number; max_discount_pct: number; reason: string; source: string };
export type Collection = {
  id: number; month: number; member: string; amount: number; method: "mandate" | "checkout" | "link" | "simulated"; marker: string;
  order_id: string | null; payment_id: string | null; link_id: string | null; link_url: string | null;
  status: "pending" | "notified" | "paid" | "failed"; error: string | null; at: string; paid_at: string | null;
};
export type Payout = {
  id: number; month: number; member: string; amount: number; kind: "prize" | "commission"; idempotency: string;
  payout_id: string | null; status: "pending" | "sent" | "processing" | "processed" | "failed" | "reversed" | "retained"; utr: string | null; error: string | null; at: string;
};

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chit (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, gross INTEGER NOT NULL, members INTEGER NOT NULL, commissionPct REAL NOT NULL,
  maxDiscountPct REAL NOT NULL, stepPct REAL NOT NULL, foremanFirst INTEGER NOT NULL, status TEXT NOT NULL, month_done INTEGER NOT NULL DEFAULT 0,
  started TEXT, seed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY, ticket INTEGER NOT NULL, name TEXT NOT NULL, trade TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, vpa TEXT NOT NULL,
  notes TEXT NOT NULL, is_foreman INTEGER NOT NULL DEFAULT 0, customer_id TEXT, mandate_id TEXT, mandate_url TEXT, token_id TEXT,
  mandate_status TEXT NOT NULL DEFAULT 'none', contact_id TEXT, fund_account_id TEXT, prized_month INTEGER, arrears INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS draw (
  month INTEGER PRIMARY KEY, winner TEXT NOT NULL, discount INTEGER NOT NULL, prize INTEGER NOT NULL, commission INTEGER NOT NULL, share INTEGER NOT NULL,
  how TEXT NOT NULL, bidders TEXT NOT NULL, second_best INTEGER, minutes TEXT NOT NULL, decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bid (
  id INTEGER PRIMARY KEY AUTOINCREMENT, month INTEGER NOT NULL, member TEXT NOT NULL, wants INTEGER NOT NULL, max_discount_pct REAL NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL
);
-- One row per instalment asked of a ticket. marker goes into Razorpay's notes/receipt so a retry finds its own earlier attempt.
CREATE TABLE IF NOT EXISTS collection (
  id INTEGER PRIMARY KEY AUTOINCREMENT, month INTEGER NOT NULL, member TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), method TEXT NOT NULL,
  marker TEXT NOT NULL UNIQUE, order_id TEXT, payment_id TEXT, link_id TEXT, link_url TEXT, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS payout (
  id INTEGER PRIMARY KEY AUTOINCREMENT, month INTEGER NOT NULL, member TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), kind TEXT NOT NULL,
  idempotency TEXT NOT NULL UNIQUE, payout_id TEXT, status TEXT NOT NULL, utr TEXT, error TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, month INTEGER, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT
);
-- Razorpay's event id is the primary key, so a webhook delivered twice is processed once.
CREATE TABLE IF NOT EXISTS webhook (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, ref TEXT, at TEXT NOT NULL, outcome TEXT
);
`;

export type Db = ReturnType<typeof openDb>;

export function openDb(path = process.env.FOREMAN_DB ?? "data/foreman.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sql = new DatabaseSync(path);
  sql.exec("PRAGMA journal_mode = WAL;");
  // ponytail: demo state only, so a schema change drops and recreates instead of migrating.
  const version = (sql.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version !== SCHEMA_VERSION) {
    sql.exec("DROP TABLE IF EXISTS webhook; DROP TABLE IF EXISTS event; DROP TABLE IF EXISTS payout; DROP TABLE IF EXISTS collection; DROP TABLE IF EXISTS bid; DROP TABLE IF EXISTS draw; DROP TABLE IF EXISTS member; DROP TABLE IF EXISTS chit;");
    sql.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  sql.exec(SCHEMA);

  const all = <T>(q: string, ...p: (string | number | null)[]) => sql.prepare(q).all(...p) as T[];
  const get = <T>(q: string, ...p: (string | number | null)[]) => sql.prepare(q).get(...p) as T | undefined;
  const run = (q: string, ...p: (string | number | null)[]) => sql.prepare(q).run(...p);
  const now = () => new Date().toISOString();

  return {
    all, get, run, now,
    wipe() { sql.exec("DELETE FROM webhook; DELETE FROM event; DELETE FROM payout; DELETE FROM collection; DELETE FROM bid; DELETE FROM draw; DELETE FROM member; DELETE FROM chit;"); },
    chit: () => get<Chit>("SELECT * FROM chit LIMIT 1"),
    terms(): Terms {
      const c = this.chit()!;
      return { gross: c.gross, members: c.members, commissionPct: c.commissionPct, maxDiscountPct: c.maxDiscountPct, stepPct: c.stepPct, foremanFirst: Boolean(c.foremanFirst) };
    },
    members: () => all<Member>("SELECT * FROM member ORDER BY ticket"),
    member: (id: string) => get<Member>("SELECT * FROM member WHERE id = ?", id)!,
    draws: () => all<DrawRow>("SELECT * FROM draw ORDER BY month"),
    say(month: number | null, actor: string, kind: string, text: string, about?: Record<string, unknown>) {
      run("INSERT INTO event (month, at, actor, kind, text, data) VALUES (?, ?, ?, ?, ?, ?)", month, now(), actor, kind, text, about ? JSON.stringify(about) : null);
    },
  };
}
