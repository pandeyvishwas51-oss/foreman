// The one judgment call in FOREMAN: how keen is this subscriber to take the pot this month? The maths never comes
// here. An agent says whether its owner wants the pot and the most discount they would forgo; the auction, the
// shares and every rupee are worked out in engine.ts. If an agent fails, its subscriber simply does not bid.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Member } from "./db.ts";
import { inr } from "./rails.ts";

export type BidCall = { wants: boolean; maxDiscountPct: number; reason: string };
export type BidContext = {
  chitName: string; month: number; months: number; gross: number; instalment: number; due: number;
  floorPct: number; ceilingPct: number; lastDiscountPct: number | null; eligible: number; prizedSoFar: string[];
};

export interface Brain {
  readonly kind: "claude" | "scripted";
  decideBid(member: Member, ctx: BidContext): Promise<BidCall>;
}

const MODEL = "claude-opus-5-5";
const Schema = z.object({ wants: z.boolean(), maxDiscountPct: z.number(), reason: z.string() });
type Ask = <T extends z.ZodType>(system: string, user: string, schema: T) => Promise<z.infer<T>>;

function apiAsk(client: Anthropic): Ask {
  return async (system, user, schema) => {
    const res = await client.messages.parse({ model: MODEL, max_tokens: 3000, output_config: { effort: "low", format: zodOutputFormat(schema) }, system, messages: [{ role: "user", content: user }] });
    if (res.stop_reason !== "end_turn" || !res.parsed_output) throw new Error(`Agent gave no usable answer (${res.stop_reason})`);
    return res.parsed_output;
  };
}

// Through the Claude Agent SDK, signed in with a Claude subscription on this machine instead of an API key.
function planAsk(): Ask {
  let free = 6;
  const waiting: (() => void)[] = [];
  const turn = async () => { if (free > 0) free--; else await new Promise<void>((go) => waiting.push(go)); };
  const done = () => { const next = waiting.shift(); if (next) next(); else free++; };
  return async (system, user, schema) => {
    await turn();
    try {
      const run = query({ prompt: user, options: { systemPrompt: system, model: MODEL, effort: "low", tools: [], settingSources: [], persistSession: false,
        outputFormat: { type: "json_schema", schema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown> } } });
      for await (const message of run) {
        if (message.type !== "result") continue;
        if (message.subtype === "success" && message.structured_output) return schema.parse(message.structured_output);
        throw new Error(`Agent gave no usable answer (${message.subtype})`);
      }
      throw new Error("Agent ended without an answer");
    } finally { done(); }
  };
}

export const claudeBrain = (client = new Anthropic()) => promptedBrain(apiAsk(client));
export const claudePlanBrain = () => promptedBrain(planAsk());

function promptedBrain(ask: Ask): Brain {
  return {
    kind: "claude",
    async decideBid(m, c) {
      const out = await ask(
        `You bid on behalf of ${m.name}, who runs a ${m.trade.toLowerCase()} and holds one ticket in a registered chit fund. A chit fund is a savings circle: every month each subscriber pays an instalment, and the month's pot goes to whoever offers to forgo the largest discount. The discount is shared out among everyone as a reduction of next month's instalment. Taking the pot early is a loan from the others and the discount is its price; waiting is saving, and the shares are the return.

You act only from what the owner has told you, below. Decide two things: whether the owner wants the pot this month at all, and the largest discount, as a percentage of the gross chit amount, they would forgo to get it. Be honest about the ceiling: the auction is settled by code so that the winner pays only one step above the runner-up, so there is nothing to gain by understating it, and overstating it risks paying more than the owner is willing to. Never bid above what the owner would accept, never bid when the owner said to wait, and if the owner has said they would take it only cheaply, make the ceiling low. Only an unprized subscriber may bid; you are unprized.

Reply in the owner's voice, one plain sentence, first person, in the way they would say it at the auction.`,
        `What the owner told you:
${m.notes}

${c.chitName}: gross chit amount ${inr(c.gross)}, ${c.months} months, instalment ${inr(c.instalment)}. This is month ${c.month} of ${c.months}; ${c.eligible} unprized subscribers remain.
This month's instalment after last month's share: ${inr(c.due)}.
Discount floor (foreman's commission): ${c.floorPct}%. Discount ceiling: ${c.ceilingPct}%. ${c.lastDiscountPct === null ? "No auction yet." : `Last month the pot went at ${c.lastDiscountPct}% discount.`}
Already prized: ${c.prizedSoFar.length ? c.prizedSoFar.join(", ") : "nobody yet"}.`,
        Schema,
      );
      return { ...out, maxDiscountPct: Math.min(c.ceilingPct, Math.max(c.floorPct, Number.isFinite(out.maxDiscountPct) ? out.maxDiscountPct : c.floorPct)) };
    },
  };
}

// Fixed rules standing in for the agents when no model is available. They read the same owner notes the model
// reads, but through hand-written rules per subscriber; the page says clearly when they are in use.
const RULES: Record<string, { from?: number; to?: number; max: number; onlyBelowLast?: number; never?: boolean; alwaysFloor?: boolean }> = {
  revathi: { from: 2, to: 4, max: 25 },
  imran: { from: 3, to: 5, max: 30 },
  kamala: { never: true, max: 5 },
  suresh: { from: 2, max: 14, onlyBelowLast: 15 },
  fatima: { from: 6, to: 8, max: 20 },
  rajan: { from: 2, max: 12 },
  meena: { from: 2, to: 2, max: 35 },
  dinesh: { alwaysFloor: true, max: 5 },
  priya: { from: 4, to: 6, max: 18 },
};

// The rules answer instantly; a short pause keeps the page readable when they stand in for the model.
const PACE_MS = Number(process.env.FOREMAN_PACE_MS ?? 1500);

export function scriptedBrain(): Brain {
  return {
    kind: "scripted",
    async decideBid(m, c) {
      if (PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS * (0.5 + Math.random())));
      const r = RULES[m.id] ?? { never: true, max: 5 };
      const no = (reason: string): BidCall => ({ wants: false, maxDiscountPct: c.floorPct, reason });
      if (r.never) return no("I am in this chit to save; I will take the pot at the end.");
      if (r.alwaysFloor) return { wants: true, maxDiscountPct: c.floorPct, reason: "I will take it only at the floor, otherwise I keep saving." };
      if (r.from && c.month < r.from) return no(`Not yet; I do not need the money before month ${r.from}.`);
      if (r.to && c.month > r.to) return no("The moment I needed it for has passed, so I will wait for a cheaper month.");
      if (r.onlyBelowLast && c.lastDiscountPct !== null && c.lastDiscountPct > r.onlyBelowLast) return no(`Last month went at ${c.lastDiscountPct}%, which is too dear for me.`);
      return { wants: true, maxDiscountPct: Math.min(r.max, c.ceilingPct), reason: `I need the pot now and I can give up to ${Math.min(r.max, c.ceilingPct)}% for it.` };
    },
  };
}
