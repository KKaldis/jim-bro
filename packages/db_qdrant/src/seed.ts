// Seed corpus + one-shot seeder for the knowledge base.
//
// Run it via docker compose (see docker-compose.yml `qdrant-seed`) or
// directly:
//   QDRANT_URL=http://localhost:6333 bun run packages/db_qdrant/src/seed.ts
//
// Re-running is safe: docs use stable ids ("kb:*") so a re-seed upserts in
// place rather than duplicating. Pass --force to drop + recreate the collection
// first (needed after changing the embedder dimension — see embed.ts).
//
// The default corpus is intentionally tiny — enough for the `search_knowledge`
// agent tool to return meaningful hits on a fresh checkout before a real ingest
// runs. The production corpus comes from the ingest pipeline (PubMed via
// src/ingest/pubmed.ts, plus guidelines/PDFs and the app's own content).

import { logger } from "@fa/logger";
import {
  qdrant,
  ensureCollection,
  upsertKnowledge,
  knowledgeCount,
  dropCollection,
} from "./client.ts";
import { embedInfo } from "./embed.ts";
import type { KnowledgeDoc } from "./types.ts";

const log = logger.child({ mod: "qdrant-seed" });

// A small, factual starter corpus of fitness/nutrition knowledge. Kept short
// and self-contained; each entry is one retrievable idea.
export const DEFAULT_KNOWLEDGE: KnowledgeDoc[] = [
  {
    id: "kb:protein-intake",
    title: "Daily protein for muscle gain",
    text: "For building or preserving muscle, aim for roughly 1.6–2.2 g of protein per kg of bodyweight per day, spread across meals. Higher ends help in a calorie deficit.",
    source: "seed",
    tags: ["nutrition", "protein", "muscle"],
  },
  {
    id: "kb:protein-timing",
    title: "Protein distribution and timing",
    text: "Total daily protein matters most, but spreading intake across 3–5 meals of 0.3–0.4 g/kg each maximizes muscle protein synthesis better than one large serving.",
    source: "seed",
    tags: ["nutrition", "protein", "timing"],
  },
  {
    id: "kb:progressive-overload",
    title: "Progressive overload",
    text: "Muscle and strength grow when you gradually increase training demand over time — more weight, more reps, more sets, or better control. Without progression, adaptation stalls.",
    source: "seed",
    tags: ["training", "hypertrophy", "strength"],
  },
  {
    id: "kb:training-volume",
    title: "Weekly training volume for hypertrophy",
    text: "Most lifters grow well on about 10–20 hard sets per muscle group per week. Beginners progress on the lower end; advanced lifters may need the upper end, split across 2+ sessions.",
    source: "seed",
    tags: ["training", "volume", "hypertrophy"],
  },
  {
    id: "kb:calorie-deficit",
    title: "Fat loss requires a calorie deficit",
    text: "To lose fat you must consume fewer calories than you burn. A moderate deficit of 300–500 kcal/day yields roughly 0.25–0.5 kg loss per week while limiting muscle loss.",
    source: "seed",
    tags: ["nutrition", "fat-loss", "calories"],
  },
  {
    id: "kb:tdee",
    title: "TDEE and energy balance",
    text: "Total Daily Energy Expenditure is BMR plus activity, exercise, and the thermic effect of food. Bodyweight change is driven by the gap between calories eaten and TDEE.",
    source: "seed",
    tags: ["nutrition", "metabolism", "calories"],
  },
  {
    id: "kb:sleep-recovery",
    title: "Sleep and recovery",
    text: "Sleep is when most muscle repair and hormonal recovery happen. Chronically sleeping under 7 hours impairs strength, raises injury risk, and increases hunger and fat gain.",
    source: "seed",
    tags: ["recovery", "sleep", "health"],
  },
  {
    id: "kb:hydration",
    title: "Hydration for performance",
    text: "Even mild dehydration (about 2% of bodyweight) reduces strength and endurance. A practical baseline is 30–40 ml of water per kg of bodyweight per day, more around training.",
    source: "seed",
    tags: ["nutrition", "hydration", "performance"],
  },
  {
    id: "kb:rest-between-sets",
    title: "Rest between sets",
    text: "For strength, rest 2–5 minutes between heavy sets to recover force. For hypertrophy, 1–3 minutes balances fatigue and volume. Short rests raise metabolic stress but cap load.",
    source: "seed",
    tags: ["training", "rest", "strength"],
  },
  {
    id: "kb:fiber",
    title: "Dietary fiber",
    text: "Aim for roughly 14 g of fiber per 1000 kcal (about 25–38 g/day). Fiber improves satiety, digestion, and blood sugar control, which supports both fat loss and general health.",
    source: "seed",
    tags: ["nutrition", "fiber", "health"],
  },
];

// Idempotently load the default corpus. Returns how many docs were written.
// Skips work if the collection already has at least as many points (unless
// force-reseeding), so the test tool can call it cheaply on every miss.
export async function seedDefaults(opts: { force?: boolean } = {}): Promise<number> {
  if (opts.force) {
    try {
      await dropCollection();
    } catch {
      // collection may not exist yet — fine
    }
  }
  await ensureCollection();
  const existing = await knowledgeCount();
  if (!opts.force && existing >= DEFAULT_KNOWLEDGE.length) {
    log.info("knowledge already seeded, skipping", { existing });
    return 0;
  }
  return upsertKnowledge(DEFAULT_KNOWLEDGE);
}

// Poll Qdrant until it's reachable (compose only guarantees the container
// *started*, not that the HTTP API is listening yet).
async function waitForQdrant(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await qdrant().getCollections();
      return;
    } catch {
      // not listening yet
    }
    log.info("waiting for qdrant", { attempt: i });
    await Bun.sleep(1000);
  }
  throw new Error("qdrant did not become reachable in time");
}

async function main() {
  const force = process.argv.includes("--force");
  log.info("seeding knowledge base", { ...embedInfo(), force });
  await waitForQdrant();
  const written = await seedDefaults({ force });
  const total = await knowledgeCount();
  log.info("seed complete", { written, total });
}

// Only run as a script, not when imported by the agent tool.
if (import.meta.main) {
  await main();
}
