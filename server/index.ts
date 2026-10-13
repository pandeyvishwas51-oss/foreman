import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb, type Member } from "./db.ts";
import { audit, dueThisMonth, flows, instalment, yearlyRate, type Draw } from "./engine.ts";
import { payoutSettled, reconcile, refreshMandates, retryPrize, runMonth, startChit, type Deps } from "./month.ts";
import { seed } from "./seed.ts";

const config = loadConfig();
// The simulated Razorpay lives in memory, so its books must too; otherwise a restart would leave them disagreeing.
const db = openDb(config.live ? undefined : ":memory:");
const deps: Deps = { db, rails: config.rails, brain: config.brain, waitMs: config.live ? 25000 : 6000 };

let busy: string | null = null;
const monthTimes: number[] = [];
const MAX_MONTHS_PER_HOUR = 60; // each month costs model calls; this caps what a public demo link can spend

async function exclusive(label: string, work: () => Promise<unknown>) {
  if (busy) throw Object.assign(new Error(`Busy: ${busy}. Try again in a moment.`), { status: 409 });
  busy = label;
  try { await work(); } finally { busy = null; }
}

function state() {
  const chit = db.chit() ?? null;
  const t = chit ? db.terms() : null;
  const draws = db.draws();
  const members = db.members();
  const outcomes = t ? members.map((m) => {
    const cash = flows(t, draws as unknown as Draw[], m.is_foreman ? "foreman" : m.id);
    const paidIn = cash.reduce((s, c, i) => s + dueThisMonth(t, (draws[i - 1] as unknown as Draw) ?? null), 0);
    return { id: m.id, paidIn, received: draws.find((d) => d.winner === (m.is_foreman ? "foreman" : m.id))?.prize ?? 0, yearlyRate: draws.length === t.members ? yearlyRate(cash) : null };
  }) : [];
  return {
    rails: config.rails.mode, agents: config.brain.kind, webhooks: Boolean(config.live && config.publicUrl), busy,
    chit, instalment: t ? instalment(t) : null, dueNext: t ? dueThisMonth(t, (draws.at(-1) as unknown as Draw) ?? null) : null,
    members: members.map(({ token_id: _t, customer_id: _c, contact_id: _k, fund_account_id: _f, ...m }: Member) => m),
    draws, bids: db.all("SELECT * FROM bid ORDER BY id"), collections: db.all("SELECT * FROM collection ORDER BY id"), payouts: db.all("SELECT * FROM payout ORDER BY id"),
    events: db.all("SELECT * FROM event ORDER BY id"), received: db.all("SELECT * FROM webhook ORDER BY at DESC"),
    outcomes, audit: t && draws.length === t.members ? audit(t, draws as unknown as Draw[], members.filter((m) => !m.is_foreman).map((m) => m.id)) : null,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}

// Razorpay calls this as payments and payouts change state. Nothing is trusted until the signature checks out, and
// an event delivered twice is counted once. Whatever the event, the poller is asked to look, so no payload is trusted blindly.
async function webhook(req: IncomingMessage): Promise<{ status: number; body: object }> {
  const raw = await readBody(req);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  if (!config.live || !config.rails.verifyWebhook(headers, raw)) return { status: 400, body: { error: "Signature check failed" } };
  const ev = JSON.parse(raw) as { event: string; payload?: { payout?: { entity?: { id: string; status: string; utr: string | null; status_details?: { description?: string } } }; payment?: { entity?: { id: string } }; payment_link?: { entity?: { id: string } } } };
  const id = headers["x-razorpay-event-id"] ?? `${ev.event}:${raw.length}:${Date.now()}`;
  const ref = ev.payload?.payout?.entity?.id ?? ev.payload?.payment_link?.entity?.id ?? ev.payload?.payment?.entity?.id ?? null;
  if (!db.run("INSERT OR IGNORE INTO webhook (id, event, ref, at) VALUES (?, ?, ?, ?)", id, ev.event, ref, db.now()).changes) return { status: 200, body: { duplicate: true } };
  let outcome = "noted";
  const p = ev.payload?.payout?.entity;
  if (ev.event.startsWith("payout.") && p) outcome = payoutSettled(db, p.id, p.status, p.utr, p.status_details?.description);
  else if (ev.event.startsWith("payment") ) { await reconcile(deps); outcome = "reconciled"; }
  db.run("UPDATE webhook SET outcome = ? WHERE id = ?", outcome, id);
  return { status: 200, body: { outcome } };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const DIST = join(import.meta.dirname, "..", "dist");
async function serveStatic(path: string, res: ServerResponse) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, safe === "/" || !extname(safe) ? "index.html" : safe);
  if (!file.startsWith(DIST)) return send(res, 403, { error: "Forbidden" });
  try { const data = await readFile(file); res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }); res.end(data); }
  catch { send(res, 404, { error: "Not found. Run `npm run build` to build the interface." }); }
}
function send(res: ServerResponse, status: number, body: object) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/state") return send(res, 200, state());
    if (route === "POST /api/start") { await exclusive("opening the chit", () => startChit(deps)); return send(res, 200, state()); }
    if (route === "POST /api/mandates") { await refreshMandates(deps); return send(res, 200, state()); }
    if (route === "POST /api/month") {
      const hourAgo = Date.now() - 3600_000;
      while (monthTimes.length && monthTimes[0] < hourAgo) monthTimes.shift();
      if (monthTimes.length >= MAX_MONTHS_PER_HOUR) return send(res, 429, { error: "This demo has run its limit of months for the hour. Try again later." });
      if (busy) return send(res, 409, { error: `Busy: ${busy}.` });
      monthTimes.push(Date.now());
      void exclusive("running the month", () => runMonth(deps)).catch((e) => { console.error(e); db.say(null, "foreman", "error", `Month stopped: ${e instanceof Error ? e.message : e}`); });
      return send(res, 202, { started: true });
    }
    const retry = url.pathname.match(/^\/api\/retry\/(\d+)$/);
    if (req.method === "POST" && retry) { await exclusive("sending the prize again", () => retryPrize(deps, Number(retry[1]))); return send(res, 200, state()); }
    if (route === "POST /api/reset") { if (busy) return send(res, 409, { error: `Busy: ${busy}.` }); seed(db); return send(res, 200, state()); }
    const minutes = url.pathname.match(/^\/api\/minutes\/(\d+)$/);
    if (req.method === "GET" && minutes) {
      const d = db.get<{ minutes: string }>("SELECT minutes FROM draw WHERE month = ?", Number(minutes[1]));
      if (!d) return send(res, 404, { error: "No draw for that month yet." });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(d.minutes);
    }
    if (route === "POST /webhooks/razorpay") { const out = await webhook(req); return send(res, out.status, out.body); }
    if (req.method === "GET") return serveStatic(url.pathname, res);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

if (!db.chit()) seed(db);
setInterval(() => void reconcile(deps).then(() => refreshMandates(deps)), config.live ? 8000 : 1500).unref();
server.listen(config.port, () => {
  console.log(`FOREMAN on http://localhost:${config.port}  |  Razorpay: ${config.rails.mode}  |  agents: ${config.brain.kind}  |  webhooks: ${config.live && config.publicUrl ? "on" : "off (polling only)"}`);
});
