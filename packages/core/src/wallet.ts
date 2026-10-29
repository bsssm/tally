import { plans, priceFor, type ClaudeCodeSummary } from "./local/claude-code.js";

export type PlanId = "api" | "pro" | "max5" | "max20";

export interface Verdict {
  plan: PlanId;
  planLabel: string;
  planUsd: number;
  apiEquivalentUsd: number;
  /** API-equivalent ÷ plan price. 0 when on API. */
  multiple: number;
  headline: string;
  levers: string[];
  /** Monthly API credits the plan grants (0 if none). */
  creditsUsd: number;
}

/** The sentence a subscription user wants in the morning. Pure; test it. */
export function verdict(summary: ClaudeCodeSummary, plan: PlanId, opts: { creditsClaimed?: boolean } = {}): Verdict {
  const P = plans();
  const p = P[plan] ?? P.api;
  const api = summary.apiEquivalentUsd;
  const multiple = p.monthly_usd ? api / p.monthly_usd : 0;
  const levers: string[] = [];

  let headline: string;
  if (plan === "api") {
    headline = api > 250
      ? `You paid about $${api.toFixed(0)} at API rates. Max 20x is $200 flat for the same Claude Code usage.`
      : api > 120
        ? `You paid about $${api.toFixed(0)} at API rates. Max 5x is $100 flat for this.`
        : `About $${api.toFixed(0)} at API rates. Pay-as-you-go is right at this volume.`;
  } else if (api < p.monthly_usd * 0.8) {
    const cheaper = plan === "max20" ? "Max 5x" : plan === "max5" ? "Pro" : "pay-as-you-go API";
    headline = `You used $${api.toFixed(0)} of API-equivalent on a $${p.monthly_usd} plan. ${cheaper} would cover this.`;
  } else {
    headline = `You used $${api.toFixed(0)} API-equivalent on a $${p.monthly_usd} plan: ${multiple.toFixed(1)}x. Keep it.`;
    if (plan === "max5" && multiple > 12) levers.push("At this volume you are probably hitting 5x limits; Max 20x doubles the window for $100 more.");
  }

  // Lever 1: model mix. Reprice the top model's tokens at the next tier down.
  const top = summary.byModel[0];
  if (top && top.share > 0.5) {
    const cheaper = cheaperSibling(top.model);
    if (cheaper) {
      const from = priceFor(top.model)!;
      const to = priceFor(cheaper)!;
      const ratio = (to.output) / (from.output);
      const saved = top.usd * (1 - ratio);
      levers.push(
        `${Math.round(top.share * 100)}% of your usage is ${top.model}, which bills ${(from.output / to.output).toFixed(1)}x ${cheaper} per token. ` +
          `Moving routine turns there is worth up to $${saved.toFixed(0)}/month at API rates, and it is the window you burn on a plan.`,
      );
    }
  }
  // Lever 2: cache health.
  const weak = summary.byModel.filter((m) => m.turns > 50 && m.cacheHitRate < 0.7);
  for (const m of weak) levers.push(`${m.model}: cache hit rate ${Math.round(m.cacheHitRate * 100)}%. Below 70% usually means a changing system prompt or tool list.`);

  // Lever 3: the plan's API credits.
  const credits = p.api_credits_usd;
  if (credits && !opts.creditsClaimed) {
    levers.push(`Your plan includes $${credits}/month of Claude Platform API credits since 7 Oct 2026. They expire monthly. Claim once in claude.ai → settings by linking a Console org.`);
  }

  return { plan, planLabel: p.label, planUsd: p.monthly_usd, apiEquivalentUsd: api, multiple, headline, levers, creditsUsd: credits };
}

function cheaperSibling(model: string): string | undefined {
  if (model.startsWith("claude-fable")) return "claude-opus-5-5";
  if (model.startsWith("claude-opus")) return "claude-sonnet-5-5";
  if (model.startsWith("claude-sonnet")) return "claude-haiku-4-5";
  return undefined;
}
