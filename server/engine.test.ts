import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, checkTerms, dueThisMonth, flows, settle, yearlyRate, type Bid, type Draw, type Terms } from "./engine.ts";

const T: Terms = { gross: 50_000_000, members: 10, commissionPct: 5, maxDiscountPct: 40, stepPct: 0.5, foremanFirst: true };
const names = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);

function rng(seed: number) { return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

// The subscribers who bid: every ticket holder except the foreman's own ticket when the foreman takes month one.
export const subscribers = (t: Terms, all: string[]) => (t.foremanFirst ? all.slice(0, t.members - 1) : all.slice(0, t.members));

function play(t: Terms, bidsFor: (month: number, eligible: string[]) => Bid[], members = names): Draw[] {
  const draws: Draw[] = [];
  let eligible = subscribers(t, members);
  for (let m = 1; m <= t.members; m++) {
    const d = settle(t, m, bidsFor(m, eligible), eligible, "test");
    draws.push(d);
    eligible = eligible.filter((x) => x !== d.winner);
  }
  return draws;
}

test("terms are checked against the Act", () => {
  assert.deepEqual(checkTerms(T), []);
  assert.ok(checkTerms({ ...T, commissionPct: 8 }).some((p) => p.includes("7%")));
  assert.ok(checkTerms({ ...T, maxDiscountPct: 45 }).length);
});

test("foreman takes month one at the floor; every subscriber is prized once; cash in equals cash out", () => {
  const r = rng(7);
  const draws = play(T, (_, eligible) => eligible.filter(() => r() > 0.4).map((m) => ({ member: m, maxDiscountPct: 5 + r() * 35 })));
  assert.equal(draws[0].how, "foreman");
  assert.equal(draws[0].discount, 2_500_000);
  assert.equal(draws.at(-1)!.how, "last");
  assert.deepEqual(audit(T, draws, subscribers(T, names)), []);
});

test("300 random chits keep the books balanced and inside the limits", () => {
  const r = rng(99);
  for (let k = 0; k < 300; k++) {
    const members = 4 + Math.floor(r() * 12);
    const t: Terms = { gross: members * 1_000_000, members, commissionPct: [3, 5, 7][Math.floor(r() * 3)], maxDiscountPct: 30 + Math.floor(r() * 11), stepPct: 0.5, foremanFirst: r() > 0.5 };
    if (checkTerms(t).length) continue;
    const ms = Array.from({ length: members }, (_, i) => `s${i}`);
    const draws = play(t, (_, eligible) => eligible.filter(() => r() > 0.5).map((m) => ({ member: m, maxDiscountPct: r() * 60 - 5 })), ms);
    assert.deepEqual(audit(t, draws, subscribers(t, ms)), [], JSON.stringify(t));
    const prized = draws.filter((d) => d.winner !== "foreman").map((d) => d.winner);
    assert.equal(prized.length, t.foremanFirst ? members - 1 : members);
  }
});

test("the keenest bidder wins and pays one step above the runner-up", () => {
  const d = settle(T, 2, [{ member: "m1", maxDiscountPct: 30 }, { member: "m2", maxDiscountPct: 20 }, { member: "m3", maxDiscountPct: 12 }], names, "x");
  assert.equal(d.winner, "m1");
  assert.equal(d.discount, 10_250_000); // 20% + 0.5%
  assert.equal(d.prize, 39_750_000);
  assert.equal(d.share, 775_000); // (20.5% - 5%) / 10
  assert.equal(dueThisMonth(T, d), 5_000_000 - 775_000);
});

test("a lone bidder pays the floor; nobody bidding means a lot", () => {
  assert.equal(settle(T, 3, [{ member: "m4", maxDiscountPct: 35 }], names, "x").discount, 2_500_000);
  const lot = settle(T, 3, [], names, "x");
  assert.equal(lot.how, "lot");
  assert.ok(names.includes(lot.winner));
});

test("bids outside the limits are clamped, and ineligible members cannot win", () => {
  const d = settle(T, 2, [{ member: "m9", maxDiscountPct: 90 }, { member: "ghost", maxDiscountPct: 40 }], names, "x");
  assert.equal(d.winner, "m9");
  assert.equal(d.discount, 2_500_000); // alone among eligible bidders, so the floor
  assert.equal(settle(T, 2, [{ member: "m9", maxDiscountPct: 90 }, { member: "m2", maxDiscountPct: 90 }], names, "x").discount, 20_000_000);
});

test("an early winner's rate is a borrowing cost, a late winner's is a saving return", () => {
  const draws = play({ ...T, foremanFirst: false }, (m, eligible) => (m <= 5 ? [{ member: eligible[0], maxDiscountPct: 30 }] : []));
  const early = yearlyRate(flows({ ...T, foremanFirst: false }, draws, "m1"))!;
  const late = yearlyRate(flows({ ...T, foremanFirst: false }, draws, "m10"))!;
  assert.ok(early > 0 && early > late, `${early} ${late}`);
});
