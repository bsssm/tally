import * as p from "@clack/prompts";
import { getProfile, setProfile, type Profile } from "@tally/core";
import { ctx } from "../context.js";
import { ok } from "../ui.js";

export async function profile(opts: { plan?: Profile["plan"]; creditsClaimed?: boolean; json?: boolean }): Promise<void> {
  const { db } = await ctx();
  let patch: Partial<Profile> = {};
  if (opts.plan) patch.plan = opts.plan;
  if (opts.creditsClaimed !== undefined) patch.creditsClaimed = opts.creditsClaimed;
  if (!Object.keys(patch).length && !opts.json) {
    const cur = getProfile(db);
    p.intro("tally profile");
    const plan = await p.select({
      message: "How do you pay Anthropic?",
      initialValue: cur.plan ?? "api",
      options: [
        { value: "api", label: "API, pay per token" },
        { value: "pro", label: "Claude Pro ($20)" },
        { value: "max5", label: "Claude Max 5x ($100)" },
        { value: "max20", label: "Claude Max 20x ($200)" },
      ],
    });
    if (p.isCancel(plan)) process.exit(1);
    patch.plan = plan as Profile["plan"];
    if (patch.plan === "max5" || patch.plan === "max20") {
      const c = await p.confirm({ message: "Have you claimed your monthly API credits in claude.ai → Settings → Billing?", initialValue: cur.creditsClaimed ?? false });
      if (p.isCancel(c)) process.exit(1);
      patch.creditsClaimed = c;
    }
    const stage = await p.select({
      message: "Company stage (for credit programs)",
      initialValue: cur.stage ?? "solo",
      options: [
        { value: "solo", label: "Solo / side project" },
        { value: "bootstrapped", label: "Bootstrapped company" },
        { value: "preseed", label: "Pre-seed" },
        { value: "seed", label: "Seed" },
        { value: "series-a+", label: "Series A or later" },
      ],
    });
    if (p.isCancel(stage)) process.exit(1);
    patch.stage = stage as Profile["stage"];
    patch.funded = patch.stage === "preseed" || patch.stage === "seed" || patch.stage === "series-a+";
    p.outro(ok("Saved"));
  }
  const saved = setProfile(db, patch);
  db.close();
  if (opts.json) console.log(JSON.stringify(saved, null, 2));
}
