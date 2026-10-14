// The test subscribers. Watches the running FOREMAN for instalments awaiting checkout and pays each one through
// Razorpay's own test checkout with Razorpay's published test card, the way a subscriber would on their phone.
// Only ever touches FOREMAN's pay page and Razorpay test-mode checkout. Run: npm run subscribers  (needs Google Chrome)
import puppeteer, { type Page } from "puppeteer-core";

const BASE = process.env.FOREMAN_URL ?? "http://localhost:8788";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CARD = { number: "4111111111111111", expiry: "1230", cvv: "123" };
const PARALLEL = Number(process.env.SUBSCRIBERS_PARALLEL ?? 2);
const ONCE = process.argv.includes("--once");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pending = { id: number; member: string; link_url: string; amount: number; month: number };
type State = { collections: { id: number; member: string; link_url: string | null; status: string; amount: number; month: number }[]; members: { id: string; phone: string; name: string }[] };

async function pending(): Promise<{ links: Pending[]; phone: Map<string, string> }> {
  const s = (await (await fetch(`${BASE}/api/state`)).json()) as State;
  return {
    links: s.collections.filter((c) => c.link_url && c.status === "notified").map((c) => ({ id: c.id, member: c.member, link_url: c.link_url!, amount: c.amount, month: c.month })),
    phone: new Map(s.members.map((m) => [m.id, m.phone])),
  };
}

// Razorpay's checkout lives in an iframe; every control is found by its text or placeholder inside that frame.
async function frameOf(page: Page) {
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((fr) => /api\.razorpay\.com\/v1\/checkout/.test(fr.url()));
    if (f) return f;
    await sleep(500);
  }
  throw new Error("checkout frame did not appear");
}

async function clickText(frame: Awaited<ReturnType<typeof frameOf>>, text: string, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const hit = await frame.evaluate((t) => {
      const els = [...document.querySelectorAll<HTMLElement>("button, [role=button], div, span, a, label")].filter((e) => e.offsetParent !== null && e.innerText && e.innerText.trim().toLowerCase() === t.toLowerCase());
      const el = els.sort((x, y) => x.innerText.length - y.innerText.length)[0];
      if (!el) return false;
      el.click();
      return true;
    }, text);
    if (hit) return;
    await sleep(400);
  }
  throw new Error(`no control reading "${text}"`);
}

// Checkout re-renders its inputs while they settle, so focus by hand and type through the keyboard, retrying once.
async function typeInto(page: Page, frame: Awaited<ReturnType<typeof frameOf>>, selector: string, value: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await frame.waitForSelector(selector, { visible: true, timeout: 20000 });
      await sleep(250);
      const ok = await frame.evaluate((sel) => { const el = document.querySelector<HTMLInputElement>(sel); if (!el) return false; el.focus(); el.select?.(); return document.activeElement === el; }, selector);
      if (!ok) throw new Error(`could not focus ${selector}`);
      await page.keyboard.type(value, { delay: 25 });
      const got = await frame.evaluate((sel) => document.querySelector<HTMLInputElement>(sel)?.value ?? "", selector);
      if (got.replace(/\D/g, "").endsWith(value.replace(/\D/g, "").slice(-4)) || got.length >= value.length) return;
      throw new Error(`typed value did not land in ${selector}`);
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(600);
    }
  }
}

async function pay(browser: Awaited<ReturnType<typeof puppeteer.launch>>, link: Pending, phone: string) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  try {
    await page.goto(link.link_url, { waitUntil: "networkidle2", timeout: 60000 });
    // FOREMAN's pay page opens Razorpay Checkout by itself; a Payment Link page opens it on its "Pay" button.
    await page.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>("button, a")].find((e) => /^pay/i.test(e.innerText.trim())); b?.click(); }).catch(() => {});
    const f = await frameOf(page);
    // With the subscriber prefilled, checkout opens on the payment options: Cards, then the card form, then OTP.
    await clickText(f, "Cards");
    await typeInto(page, f, "input[name='card.number']", CARD.number);
    await typeInto(page, f, "input[name='card.expiry']", CARD.expiry);
    await typeInto(page, f, "input[name='card.cvv']", CARD.cvv);
    await clickText(f, "Continue");
    await sleep(1200);
    // Checkout may ask for the name on the card; it is usually prefilled from the order.
    const nameEmpty = await f.evaluate(() => { const el = document.querySelector<HTMLInputElement>("input[name='card.name']"); return el && el.offsetParent !== null ? el.value.trim() === "" : null; });
    if (nameEmpty === true) await typeInto(page, f, "input[name='card.name']", link.member.toUpperCase());
    if (nameEmpty !== null) { await sleep(400); await clickText(f, "Continue"); }
    // Test-mode OTP page: any 4 to 10 digits succeed. If the card form is still up, press Continue once more.
    for (let i = 0; i < 3; i++) {
      const otp = await f.waitForSelector("input[name='otp'], input[placeholder*='OTP' i]", { visible: true, timeout: 8000 }).catch(() => null);
      if (otp) break;
      await clickText(f, "Continue").catch(() => {});
    }
    await typeInto(page, f, "input[name='otp'], input[placeholder*='OTP' i]", "123456");
    await clickText(f, "Continue").catch(() => clickText(f, "Submit"));
    // Wait until the page shows success or the server marks the instalment paid.
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const text = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (/paid\. thank you|payment (completed|successful)/i.test(text)) break;
    }
    console.log(`paid  m${link.month} ${link.member} ${link.link_url}`);
  } catch (e) {
    console.error(`fail  m${link.month} ${link.member} ${link.link_url}: ${e instanceof Error ? e.message : e}`);
    if (process.env.SUBSCRIBERS_DEBUG) {
      await page.screenshot({ path: `${process.env.SUBSCRIBERS_DEBUG}/fail-${link.member}.png` }).catch(() => {});
      for (const fr of page.frames()) {
        const t = await fr.evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").slice(0, 300) ?? "").catch(() => "(no access)");
        if (t) console.error("  frame", fr.url().slice(0, 80), "::", t);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: process.env.SUBSCRIBERS_HEADFUL ? false : true, args: ["--no-first-run"] });
console.log(`subscribers watching ${BASE} (${PARALLEL} at a time)`);
const inFlight = new Set<number>();
try {
  do {
    const { links, phone } = await pending();
    const todo = links.filter((l) => !inFlight.has(l.id));
    if (todo.length) {
      const batch = todo.slice(0, PARALLEL);
      batch.forEach((l) => inFlight.add(l.id));
      await Promise.all(batch.map((l) => pay(browser, l, phone.get(l.member) ?? "9000000000").finally(() => inFlight.delete(l.id))));
    } else await sleep(2500);
  } while (!ONCE);
} finally {
  await browser.close();
}
