process.env.FOREMAN_PACE_MS = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedBrain, type Brain } from "./brain.ts";
import { openDb } from "./db.ts";
import { audit, type Draw } from "./engine.ts";
import { fakeRails } from "./fakerails.ts";
import { reconcile, retryPrize, runMonth, startChit, type Deps } from "./month.ts";
import { seed } from "./seed.ts";

const fast = { linkPaysAfterMs: 300, payoutDoneAfterMs: 200 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(rails = fakeRails({}, fast), brain: Brain = scriptedBrain()): Promise<Deps> {
  const db = openDb(":memory:");
  seed(db);
  const deps: Deps = { db, rails, brain, waitMs: 1500, paceMs: 0, payoutWaitMs: 0 };
  await startChit(deps);
  await sleep(1700); // mandates activate
  return deps;
}

test("a whole chit runs: every subscriber prized once, books balance, minutes kept", async () => {
  const deps = await open();
  for (let m = 1; m <= 10; m++) await runMonth(deps);
  await sleep(400); await reconcile(deps);
  const t = deps.db.terms();
  assert.deepEqual(audit(t, deps.db.draws() as unknown as Draw[], deps.db.members().filter((x) => !x.is_foreman).map((x) => x.id)), []);
  assert.equal(deps.db.chit()!.status, "complete");
  assert.equal(deps.db.draws()[0].how, "foreman");
  assert.equal(deps.db.draws()[1].winner, "meena"); // the urgent one wins month 2
  assert.ok(deps.db.draws().every((d) => d.minutes.includes("RESULT")));
  assert.ok(deps.db.all("SELECT 1 FROM payout WHERE kind = 'prize' AND status = 'processed'").length >= 8);
});

test("a declined debit falls back to a payment link; the subscriber sits out the auction, then arrears clear", async () => {
  const rails = fakeRails({ declineChargeFor: new Set(["revathi:M2"]) }, { linkPaysAfterMs: 2500, payoutDoneAfterMs: 200 });
  const deps = await open(rails);
  await runMonth(deps); // month 1
  await runMonth(deps); // month 2: revathi's debit is declined
  const c = deps.db.get<{ status: string; method: string; link_id: string }>("SELECT status, method, link_id FROM collection WHERE month = 2 AND member = 'revathi'")!;
  assert.equal(c.method, "link");
  assert.ok(c.link_id);
  assert.equal(deps.db.member("revathi").arrears, 1);
  assert.ok(!deps.db.all<{ member: string }>("SELECT member FROM bid WHERE month = 2").some((b) => b.member === "revathi"));
  await sleep(2600); await reconcile(deps);
  assert.equal(deps.db.get<{ status: string }>("SELECT status FROM collection WHERE month = 2 AND member = 'revathi'")!.status, "paid");
  assert.equal(deps.db.member("revathi").arrears, 0);
});

test("a reversed payout is marked and can be sent again with a new idempotency key", async () => {
  const deps = await open(fakeRails({ failPayoutFor: new Set(["M2-meena-1"]) }, fast));
  await runMonth(deps); await runMonth(deps);
  await sleep(300); await reconcile(deps);
  assert.equal(deps.db.get<{ status: string }>("SELECT status FROM payout WHERE month = 2 AND kind = 'prize' ORDER BY id DESC")!.status, "reversed");
  await retryPrize(deps, 2);
  await sleep(300); await reconcile(deps);
  const rows = deps.db.all<{ status: string; idempotency: string }>("SELECT status, idempotency FROM payout WHERE month = 2 AND kind = 'prize' ORDER BY id");
  assert.deepEqual(rows.map((r) => r.status), ["reversed", "processed"]);
  assert.notEqual(rows[0].idempotency, rows[1].idempotency);
});

test("an agent that fails means no bid, never a guess", async () => {
  const broken: Brain = { kind: "claude", async decideBid(m, c) { if (m.id === "meena") throw new Error("model unavailable"); return scriptedBrain().decideBid(m, c); } };
  const deps = await open(fakeRails({}, fast), broken);
  await runMonth(deps); await runMonth(deps);
  const bid = deps.db.get<{ wants: number; source: string }>("SELECT wants, source FROM bid WHERE month = 2 AND member = 'meena'")!;
  assert.equal(bid.wants, 0);
  assert.equal(bid.source, "fail-closed");
  assert.notEqual(deps.db.draws()[1].winner, "meena");
});

test("a month interrupted after its draw resumes without a second auction or a second prize", async () => {
  const deps = await open();
  await runMonth(deps); await runMonth(deps);
  // Pretend month 2 crashed right after the prize was sent: reopen it and run again.
  deps.db.run("UPDATE chit SET month_done = 1");
  await runMonth(deps);
  assert.equal(deps.db.all("SELECT 1 FROM draw WHERE month = 2").length, 1);
  assert.equal(deps.db.all("SELECT 1 FROM payout WHERE month = 2 AND kind = 'prize'").length, 1);
  assert.equal(deps.db.all("SELECT 1 FROM collection WHERE month = 2").length, 10);
  assert.equal(deps.db.chit()!.month_done, 2);
});
