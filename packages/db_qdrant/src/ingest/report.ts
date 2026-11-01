// Report-only PubMed sweep: runs the same evidence-filtered search as the
// ingest (pubmed.ts) across every product area, and writes *every* hit to an
// .xlsx for review, with per-paper word/token counts and an embedding cost
// estimate. It never touches Qdrant or the embedder — the PMID column is what a
// later targeted fetch/ingest works from.
//
// Run it:
//   bun run packages/db_qdrant/src/ingest/report.ts                    # all areas, no cap
//   bun run packages/db_qdrant/src/ingest/report.ts --max 200 --out ./papers.xlsx
//   bun run packages/db_qdrant/src/ingest/report.ts --price 0.02       # $ per 1M tokens
//   bun run packages/db_qdrant/src/ingest/report.ts '"beta-Alanine"[MeSH]'  # ad-hoc queries only
//
// Rate limiting lives in pubmed.ts (eutilsFetch). NCBI asks that big jobs run
// on weekends or 9pm–5am US Eastern. Env: NCBI_API_KEY (10 req/s vs 3), NCBI_EMAIL.

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ExcelJS from "exceljs";
import { logger } from "@fa/logger";
import { esearchPage, efetch, parseRecords } from "./pubmed.ts";
import { sourceToChunks } from "./common.ts";
import { embedModelName } from "../embed.ts";
import type { KnowledgeSource } from "../types.ts";

const log = logger.child({ mod: "pubmed-report" });

// PubMed won't page past the first 10,000 results of a query.
const PUBMED_WINDOW = 9_999;
// SiliconFlow list price for Qwen3-Embedding-8B (the .env embedder), $/1M tokens.
const DEFAULT_PRICE_PER_MTOK = 0.04;
// Rough English/scientific-text ratio, same rule of thumb as chunk.ts.
const CHARS_PER_TOKEN = 4;

type Topic = { name: string; query: string };

// Queries mapped to what the product does (one per feature area). They use MeSH
// subject headings plus OR'd free-text synonyms, so a paper matches on the
// concept rather than on every word of a phrase. pubmed.ts ANDs the evidence
// filter onto each one.
const RT = '("Resistance Training"[MeSH] OR "Weight Lifting"[MeSH] OR "strength training")';
const EX = '("Exercise"[MeSH] OR "Athletic Performance"[MeSH] OR "Athletes"[MeSH])';

export const PRODUCT_TOPICS: Record<string, Topic[]> = {
  Nutrition: [
    {
      name: "Protein & muscle protein synthesis",
      query: `("Dietary Proteins"[MeSH] OR "protein intake" OR "protein supplementation") AND ("muscle protein synthesis" OR "lean mass" OR "muscle mass" OR "Muscle, Skeletal"[MeSH])`,
    },
    {
      name: "Protein timing & distribution",
      query: `("protein timing" OR "protein distribution" OR "pre-sleep protein" OR "meal frequency" OR "nutrient timing") AND (muscle OR ${RT} OR "lean mass")`,
    },
    {
      name: "Energy deficit & fat loss",
      query: `("Caloric Restriction"[MeSH] OR "Diet, Reducing"[MeSH] OR "energy deficit" OR "energy balance") AND ("Weight Loss"[MeSH] OR "fat loss" OR "Body Composition"[MeSH])`,
    },
    {
      name: "Keeping muscle while dieting",
      query: `("Caloric Restriction"[MeSH] OR "Diet, Reducing"[MeSH] OR "energy deficit" OR "Weight Loss"[MeSH]) AND ("lean mass" OR "fat-free mass" OR "muscle mass") AND ("Dietary Proteins"[MeSH] OR ${RT})`,
    },
    {
      name: "Diet adherence",
      query: `("Patient Compliance"[MeSH] OR adherence) AND ("Diet, Reducing"[MeSH] OR "weight loss diet" OR "dietary intervention") AND "Weight Loss"[MeSH]`,
    },
    {
      name: "Intermittent fasting",
      query: `("Intermittent Fasting"[MeSH] OR "intermittent fasting" OR "time-restricted eating" OR "alternate day fasting")`,
    },
    {
      name: "Low-carb / keto / low-fat diets",
      query: `("Diet, Carbohydrate-Restricted"[MeSH] OR "Diet, Ketogenic"[MeSH] OR "Diet, Fat-Restricted"[MeSH]) AND ("Weight Loss"[MeSH] OR "Body Composition"[MeSH] OR ${EX})`,
    },
    {
      name: "Carbohydrate & endurance fuelling",
      query: `("Dietary Carbohydrates"[MeSH] OR "carbohydrate intake") AND ("Endurance Training"[MeSH] OR "Physical Endurance"[MeSH] OR "Athletic Performance"[MeSH])`,
    },
    {
      name: "Hydration & electrolytes",
      query: `("Dehydration"[MeSH] OR hydration OR "fluid intake" OR "Electrolytes"[MeSH] OR sodium) AND ${EX}`,
    },
    {
      name: "Micronutrients in active people",
      query: `("Micronutrients"[MeSH] OR "Iron"[MeSH] OR "Magnesium"[MeSH] OR "Zinc"[MeSH]) AND ("Athletes"[MeSH] OR "Exercise"[MeSH])`,
    },
    {
      name: "Fibre, satiety & appetite",
      query: `("Dietary Fiber"[MeSH] OR "Satiation"[MeSH] OR "Appetite"[MeSH]) AND ("Weight Loss"[MeSH] OR "Body Weight"[MeSH] OR "Energy Intake"[MeSH])`,
    },
    {
      name: "Alcohol & training",
      query: `("Alcohol Drinking"[MeSH] OR "Ethanol"[MeSH]) AND (${EX} OR "muscle protein synthesis" OR recovery)`,
    },
  ],
  "Food logging & self-monitoring": [
    {
      name: "Self-monitoring & food diaries",
      query: `("Diet Records"[MeSH] OR "self-monitoring" OR "food diary" OR "dietary tracking") AND ("Weight Loss"[MeSH] OR "weight management")`,
    },
    {
      name: "Intake under-/misreporting",
      query: `(underreporting OR under-reporting OR misreporting) AND ("Energy Intake"[MeSH] OR "dietary intake")`,
    },
    {
      name: "Photo / AI dietary assessment",
      query: `("food photography" OR "image-based" OR "computer vision" OR "deep learning" OR "food recognition") AND ("dietary assessment" OR "Nutrition Assessment"[MeSH] OR "portion size")`,
    },
    {
      name: "Diet & fitness apps",
      query: `("Mobile Applications"[MeSH] OR "smartphone app" OR "mobile app") AND ("Diet"[MeSH] OR "Weight Loss"[MeSH] OR "Exercise"[MeSH] OR nutrition)`,
    },
  ],
  Supplements: [
    {
      name: "Creatine",
      query: `"Creatine"[MeSH] AND ("Dietary Supplements"[MeSH] OR supplementation)`,
    },
    {
      name: "Caffeine",
      query: `"Caffeine"[MeSH] AND (${EX} OR "Muscle Strength"[MeSH])`,
    },
    {
      name: "Protein powders (whey, casein)",
      query: `("Whey Proteins"[MeSH] OR "Caseins"[MeSH] OR "whey protein" OR "protein supplement") AND (${RT} OR "Muscle, Skeletal"[MeSH] OR "Body Composition"[MeSH])`,
    },
    {
      name: "Beta-alanine",
      query: `"beta-Alanine"[MeSH] AND (supplementation OR "Dietary Supplements"[MeSH])`,
    },
    {
      name: "Nitrate / beetroot",
      query: `("Nitrates"[MeSH] OR "beetroot juice" OR "dietary nitrate") AND ${EX}`,
    },
    {
      name: "Other ergogenic aids (bicarbonate, citrulline, HMB)",
      query: `("Sodium Bicarbonate"[MeSH] OR citrulline OR "beta-hydroxy-beta-methylbutyrate" OR HMB) AND (${EX} OR ${RT})`,
    },
    {
      name: "Vitamin D",
      query: `"Vitamin D"[MeSH] AND ("Muscle Strength"[MeSH] OR "Muscle, Skeletal"[MeSH] OR "Athletic Performance"[MeSH])`,
    },
    {
      name: "Omega-3",
      query: `"Fatty Acids, Omega-3"[MeSH] AND ("Muscle, Skeletal"[MeSH] OR "Muscle Strength"[MeSH] OR "Exercise"[MeSH])`,
    },
    {
      name: "Ashwagandha",
      query: `("Withania"[MeSH] OR ashwagandha) AND ("Dietary Supplements"[MeSH] OR ${EX} OR "Muscle Strength"[MeSH] OR "Sleep"[MeSH] OR "Stress, Psychological"[MeSH])`,
    },
  ],
  Training: [
    {
      name: "Hypertrophy",
      query: `${RT} AND (hypertrophy OR "muscle mass" OR "muscle thickness" OR "cross-sectional area")`,
    },
    {
      name: "Volume, frequency, intensity & rest",
      query: `${RT} AND ("training volume" OR "training frequency" OR "training intensity" OR "number of sets" OR "repetition range" OR "rest interval" OR "inter-set rest" OR periodization OR "progressive overload" OR "training to failure" OR "proximity to failure")`,
    },
    {
      name: "Exercise selection & range of motion",
      query: `${RT} AND ("range of motion" OR "exercise selection" OR "muscle length" OR "lengthened partial")`,
    },
    {
      name: "1RM, RIR & velocity-based training",
      query: `("one repetition maximum" OR 1RM OR "repetitions in reserve" OR "velocity-based training" OR "rating of perceived exertion") AND (${RT} OR strength)`,
    },
    {
      name: "Detraining, deloads & muscle memory",
      query: `(detraining OR deload OR "training cessation" OR "muscle memory") AND (${RT} OR muscle)`,
    },
    {
      name: "Concurrent training (lifting + cardio)",
      query: `("concurrent training" OR "interference effect" OR (${RT} AND "Endurance Training"[MeSH]))`,
    },
    {
      name: "HIIT",
      query: `("High-Intensity Interval Training"[MeSH] OR "high-intensity interval training" OR "sprint interval training")`,
    },
    {
      name: "Cardio & VO2max training",
      query: `("Endurance Training"[MeSH] OR "aerobic training" OR "aerobic exercise" OR "endurance exercise") AND (VO2max OR "maximal oxygen uptake" OR "cardiorespiratory fitness")`,
    },
    {
      name: "Older adults & sarcopenia",
      query: `("Sarcopenia"[MeSH] OR "age-related muscle loss") AND (${RT} OR "Exercise"[MeSH] OR "Dietary Proteins"[MeSH])`,
    },
    {
      name: "Women: menstrual cycle, contraception, menopause",
      query: `("Menstrual Cycle"[MeSH] OR "Menopause"[MeSH] OR "Contraceptives, Oral"[MeSH]) AND (${RT} OR ${EX} OR "Muscle Strength"[MeSH])`,
    },
    { name: "Exercise in pregnancy", query: `"Pregnancy"[MeSH] AND ("Exercise"[MeSH] OR ${RT})` },
    {
      name: "Injury, stretching & warm-up",
      query: `("Muscle Stretching Exercises"[MeSH] OR "Warm-Up Exercise"[MeSH] OR (("Athletic Injuries"[MeSH] OR "Sprains and Strains"[MeSH]) AND prevention)) AND (${RT} OR "Athletic Performance"[MeSH] OR "Athletes"[MeSH] OR "Range of Motion, Articular"[MeSH])`,
    },
  ],
  "Recovery & sleep": [
    {
      name: "Sleep & performance",
      query: `("Sleep"[MeSH] OR "Sleep Deprivation"[MeSH] OR "sleep quality") AND (${EX} OR "Muscle, Skeletal"[MeSH])`,
    },
    {
      name: "Soreness & recovery methods",
      query: `("Myalgia"[MeSH] OR "delayed onset muscle soreness" OR "cold water immersion" OR "foam rolling" OR "Massage"[MeSH] OR "post-exercise recovery") AND (${EX} OR ${RT})`,
    },
    {
      name: "Overtraining",
      query: `(overtraining OR overreaching OR "relative energy deficiency in sport")`,
    },
  ],
  "Body composition": [
    {
      name: "Measuring body fat (BIA, DEXA, skinfolds)",
      query: `"Body Composition"[MeSH] AND ("Electric Impedance"[MeSH] OR "Absorptiometry, Photon"[MeSH] OR skinfold OR "bioelectrical impedance") AND (accuracy OR validity OR agreement OR "Reproducibility of Results"[MeSH])`,
    },
    {
      name: "FFMI & natural muscular potential",
      query: `("fat-free mass index" OR FFMI OR "natural bodybuilders" OR "muscular potential") AND (athletes OR bodybuilding OR ${RT})`,
    },
    {
      name: "BMI vs body fat",
      query: `"Body Mass Index"[MeSH] AND ("Adiposity"[MeSH] OR "body fat percentage") AND (accuracy OR misclassification OR "Sensitivity and Specificity"[MeSH])`,
    },
    {
      name: "Waist & body proportions",
      query: `("Waist Circumference"[MeSH] OR "Waist-Hip Ratio"[MeSH] OR "waist-to-height ratio") AND ("Body Composition"[MeSH] OR "Adiposity"[MeSH]) AND (${EX} OR "Weight Loss"[MeSH])`,
    },
    {
      name: "Estimating VO2max",
      query: `(VO2max OR "maximal oxygen uptake" OR "cardiorespiratory fitness") AND ("prediction equation" OR "estimation equation" OR "non-exercise" OR wearable OR "Fitness Trackers"[MeSH] OR "submaximal test" OR "field test") AND (validity OR accuracy OR "Reproducibility of Results"[MeSH])`,
    },
    {
      name: "Body recomposition",
      query: `("body recomposition" OR (${RT} AND "Body Composition"[MeSH] AND ("lean mass" OR "fat-free mass") AND ("fat mass" OR "body fat")))`,
    },
    {
      name: "GLP-1 drugs & muscle",
      query: `("Glucagon-Like Peptide-1 Receptor Agonists"[MeSH] OR semaglutide OR tirzepatide OR liraglutide) AND ("lean mass" OR "fat-free mass" OR "muscle mass" OR "Body Composition"[MeSH] OR "Exercise"[MeSH])`,
    },
  ],
  "Activity & coaching": [
    {
      name: "Daily steps",
      query: `("step count" OR "steps per day" OR "daily steps" OR pedometer OR "Fitness Trackers"[MeSH])`,
    },
    {
      name: "Metabolic adaptation & NEAT",
      query: `("non-exercise activity thermogenesis" OR "metabolic adaptation" OR "adaptive thermogenesis" OR "energy compensation" OR "compensatory eating") AND ("Weight Loss"[MeSH] OR "Caloric Restriction"[MeSH] OR "Exercise"[MeSH] OR "Energy Metabolism"[MeSH])`,
    },
    {
      name: "Digital & AI coaching",
      query: `("Telemedicine"[MeSH] OR mHealth OR "digital health" OR "health coaching" OR "conversational agent" OR chatbot) AND ("Exercise"[MeSH] OR "Weight Loss"[MeSH] OR "Diet"[MeSH] OR "physical activity")`,
    },
    {
      name: "Habits & long-term adherence",
      query: `("Behavior Therapy"[MeSH] OR "behaviour change technique" OR "behavior change technique" OR "habit formation") AND ("Exercise"[MeSH] OR "Weight Loss"[MeSH]) AND (adherence OR maintenance OR habit)`,
    },
  ],
};

type Row = KnowledgeSource & {
  areas: Set<string>;
  topics: Set<string>;
  words: number;
  chunks: number;
  tokens: number;
};

type TopicStat = {
  area: string;
  name: string;
  query: string;
  unfiltered: number;
  matches: number;
  fetched: number;
  inReport: number;
  truncated: boolean;
  warnings: string[];
};

const wordCount = (s: string) => s.match(/\S+/g)?.length ?? 0;

// Size a record exactly as the ingest would embed it: same chunker, same
// title breadcrumb on every chunk.
function measure(rec: KnowledgeSource) {
  const chunks = sourceToChunks(rec);
  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  return {
    words: wordCount(rec.title) + wordCount(rec.abstract),
    chunks: chunks.length,
    tokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

async function sweep(plan: Array<{ area: string } & Topic>, max: number) {
  const rows = new Map<string, Row>();
  const stats: TopicStat[] = [];

  for (const { area, name, query } of plan) {
    const unfiltered = (await esearchPage(query, { retmax: 0, evidenceFilter: false })).count;
    const res = await esearchPage(query, { retmax: Math.min(max, PUBMED_WINDOW) });
    // Only fetch metadata for papers not already pulled under another topic.
    const missing = res.ids.filter((id) => !rows.has(`pmid:${id}`));
    for (let i = 0; i < missing.length; i += 200) {
      for (const rec of await parseRecords(await efetch(missing.slice(i, i + 200)))) {
        rows.set(rec.id, { ...rec, areas: new Set(), topics: new Set(), ...measure(rec) });
      }
      log.info("fetched", {
        topic: name,
        done: Math.min(i + 200, missing.length),
        of: missing.length,
      });
    }
    // Tag every hit (new or already seen); records dropped for having no
    // abstract simply aren't in `rows`.
    let inReport = 0;
    for (const id of res.ids) {
      const row = rows.get(`pmid:${id}`);
      if (!row) continue;
      row.areas.add(area);
      row.topics.add(name);
      inReport++;
    }
    stats.push({
      area,
      name,
      query,
      unfiltered,
      matches: res.count,
      fetched: res.ids.length,
      inReport,
      truncated: res.ids.length < res.count,
      warnings: res.warnings,
    });
    log.info("topic", {
      area,
      topic: name,
      matches: res.count,
      in_report: inReport,
      new: missing.length,
    });
    if (res.warnings.length) log.warn("query warnings", { topic: name, warnings: res.warnings });
  }
  return { rows, stats };
}

const EVIDENCE_RANK = [
  "meta-analysis",
  "systematic-review",
  "rct",
  "cohort",
  "narrative-review",
  "guideline",
  "other",
];

function bold(ws: ExcelJS.Worksheet) {
  ws.getRow(1).font = { bold: true };
}

async function writeReport(path: string, rows: Row[], stats: TopicStat[], pricePerMTok: number) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const usd = (tokens: number) => (tokens / 1_000_000) * pricePerMTok;
  const sum = (rs: Row[], k: "words" | "chunks" | "tokens") => rs.reduce((n, r) => n + r[k], 0);

  // Summary first so it's what opens.
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { key: "k", width: 34 },
    { key: "v", width: 26 },
  ];
  const total = {
    words: sum(rows, "words"),
    chunks: sum(rows, "chunks"),
    tokens: sum(rows, "tokens"),
  };
  summary.addRows([
    { k: "Generated", v: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" },
    { k: "Topics searched", v: stats.length },
    { k: "Unique papers (with abstract)", v: rows.length },
    { k: "Total words (title + abstract)", v: total.words },
    { k: "Chunks to embed", v: total.chunks },
    { k: "Est. tokens to embed", v: total.tokens },
    { k: "Embedding model", v: embedModelName() },
    { k: "Price ($ per 1M tokens)", v: pricePerMTok },
    { k: "Est. one-time embedding cost ($)", v: Number(usd(total.tokens).toFixed(4)) },
    { k: "Topics cut off at PubMed's 10k window", v: stats.filter((s) => s.truncated).length },
    { k: "Topics with query warnings", v: stats.filter((s) => s.warnings.length).length },
    {},
    { k: "Notes" },
    { k: "Tokens are estimated at ~4 chars/token on the exact chunk text the ingest embeds." },
    { k: "Cost covers ingesting every row once; cached/unchanged papers re-embed for free." },
    { k: "Mark Fetch = N on the Papers sheet to drop rows before the ingest." },
  ]);
  summary.getColumn("k").font = { bold: true };

  const papers = wb.addWorksheet("Papers", { views: [{ state: "frozen", ySplit: 1 }] });
  papers.columns = [
    { header: "Fetch", key: "fetch", width: 7 },
    { header: "PMID", key: "pmid", width: 11 },
    { header: "Title", key: "title", width: 70 },
    { header: "Evidence", key: "evidence", width: 18 },
    { header: "Year", key: "year", width: 7 },
    { header: "Journal", key: "journal", width: 30 },
    { header: "Areas", key: "areas", width: 26 },
    { header: "Topics", key: "topics", width: 40 },
    { header: "Words", key: "words", width: 8 },
    { header: "Chunks", key: "chunks", width: 8 },
    { header: "Est. tokens", key: "tokens", width: 11 },
    { header: "Est. cost ($)", key: "cost", width: 12 },
    { header: "Pub types", key: "pubTypes", width: 30 },
    { header: "First author", key: "author", width: 20 },
    { header: "DOI", key: "doi", width: 28 },
    { header: "URL", key: "url", width: 38 },
    { header: "Abstract", key: "abstract", width: 80 },
  ];
  // Strongest evidence first, newest first within a level.
  rows.sort(
    (a, b) =>
      EVIDENCE_RANK.indexOf(a.evidence_level ?? "other") -
        EVIDENCE_RANK.indexOf(b.evidence_level ?? "other") || (b.year ?? 0) - (a.year ?? 0),
  );
  for (const r of rows) {
    papers.addRow({
      fetch: "Y",
      pmid: r.pmid,
      title: r.title,
      evidence: r.evidence_level,
      year: r.year,
      journal: r.journal,
      areas: [...r.areas].join("; "),
      topics: [...r.topics].join("; "),
      words: r.words,
      chunks: r.chunks,
      tokens: r.tokens,
      cost: usd(r.tokens),
      pubTypes: r.pub_types.join("; "),
      author: r.authors[0],
      doi: r.doi,
      url: r.url ? { text: r.url, hyperlink: r.url } : undefined,
      abstract: r.abstract.slice(0, 32_000), // Excel's per-cell cap is 32,767
    });
  }
  papers.getColumn("cost").numFmt = "0.000000";
  bold(papers);
  papers.autoFilter = { from: "A1", to: "Q1" };

  const topics = wb.addWorksheet("Topics", { views: [{ state: "frozen", ySplit: 1 }] });
  topics.columns = [
    { header: "Area", key: "area", width: 26 },
    { header: "Topic", key: "name", width: 40 },
    { header: "PubMed total (no filter)", key: "unfiltered", width: 14 },
    { header: "Matches (evidence filter)", key: "matches", width: 14 },
    { header: "Fetched", key: "fetched", width: 9 },
    { header: "In report (has abstract)", key: "inReport", width: 14 },
    { header: "Cut off?", key: "truncated", width: 9 },
    { header: "Query warnings", key: "warnings", width: 40 },
    { header: "Query", key: "query", width: 100 },
  ];
  for (const s of stats) {
    topics.addRow({ ...s, truncated: s.truncated ? "YES" : "", warnings: s.warnings.join("; ") });
  }
  bold(topics);

  const areas = wb.addWorksheet("Areas");
  areas.columns = [
    { header: "Area", key: "area", width: 30 },
    { header: "Papers", key: "n", width: 9 },
    { header: "Words", key: "words", width: 12 },
    { header: "Est. tokens", key: "tokens", width: 12 },
    { header: "Est. cost ($)", key: "cost", width: 12 },
  ];
  for (const area of new Set(stats.map((s) => s.area))) {
    const rs = rows.filter((r) => r.areas.has(area));
    const tokens = sum(rs, "tokens");
    areas.addRow({ area, n: rs.length, words: sum(rs, "words"), tokens, cost: usd(tokens) });
  }
  areas.addRow({});
  areas.addRow({ area: "(papers in several areas count in each)" });
  areas.getColumn("cost").numFmt = "0.0000";
  bold(areas);

  const evidence = wb.addWorksheet("Evidence");
  evidence.columns = [
    { header: "Evidence level", key: "level", width: 20 },
    { header: "Papers", key: "n", width: 9 },
    { header: "Est. tokens", key: "tokens", width: 12 },
  ];
  for (const level of EVIDENCE_RANK) {
    const rs = rows.filter((r) => (r.evidence_level ?? "other") === level);
    evidence.addRow({ level, n: rs.length, tokens: sum(rs, "tokens") });
  }
  bold(evidence);

  await mkdir(dirname(path), { recursive: true });
  await wb.xlsx.writeFile(path);
  return total;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const max = Number(flag("max") ?? PUBMED_WINDOW);
  const price = Number(flag("price") ?? DEFAULT_PRICE_PER_MTOK);
  const date = new Date().toISOString().slice(0, 10);
  // Resolve from the repo root so the npm script (cwd = package) and a direct
  // run land the file in the same place.
  const out = flag("out")
    ? resolve(flag("out")!)
    : resolve(import.meta.dir, "../../../../reports", `pubmed-papers-${date}.xlsx`);

  const flagValues = new Set([flag("max"), flag("out"), flag("price")]);
  const adHoc = args.filter((a) => !a.startsWith("--") && !flagValues.has(a));
  const plan = adHoc.length
    ? adHoc.map((query) => ({ area: "Ad hoc", name: query, query }))
    : Object.entries(PRODUCT_TOPICS).flatMap(([area, ts]) => ts.map((t) => ({ area, ...t })));

  log.info("pubmed report starting", { topics: plan.length, max });
  const { rows, stats } = await sweep(plan, max);
  const total = await writeReport(out, [...rows.values()], stats, price);
  log.info("pubmed report written", { out, papers: rows.size, ...total });
  console.log(
    `Wrote ${rows.size} papers (${total.tokens.toLocaleString()} est. tokens, ` +
      `~$${((total.tokens / 1e6) * price).toFixed(2)} to embed) across ${plan.length} topics → ${out}`,
  );
}

if (import.meta.main) {
  await main();
}
