// Targeted PubMed ingest via NCBI E-utilities (§5.0 path A).
//
// Fetches *only* the slice we care about — exercise science, nutrition,
// hypertrophy, supplements, sleep, recovery — biased toward strong evidence
// (meta-analyses, systematic reviews, RCTs), maps each record to a
// KnowledgeSource, and runs the raw → split → embed → upsert pipeline.
//
// Run it:
//   bun run packages/db_qdrant/src/ingest/pubmed.ts "creatine supplementation" --max 100
//   bun run packages/db_qdrant/src/ingest/pubmed.ts --defaults
//
// Env: NCBI_API_KEY (10 req/s vs 3), NCBI_EMAIL (be a good citizen).

import { XMLParser } from "fast-xml-parser";
import { logger } from "@fa/logger";
import { ingestSources, contentHash } from "./common.ts";
import { getSource } from "../client.ts";
import type { EvidenceLevel, KnowledgeSource } from "../types.ts";

const log = logger.child({ mod: "pubmed-ingest" });
const E = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// Parsed PubMed XML is deeply dynamic (optional, repeated, mixed-content nodes);
// a precise type buys little here. Use one loose alias for traversal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Xml = Record<string, any>;

// A default, evidence-biased topic set for a first real corpus.
const DEFAULT_TOPICS = [
  "resistance training hypertrophy",
  "protein intake muscle protein synthesis",
  "creatine supplementation strength",
  "training volume hypertrophy",
  "energy balance weight loss",
  "sleep athletic performance recovery",
  "caffeine exercise performance",
  "progressive overload strength training",
];

// Restrict to strong study designs + recency. Tweak to taste.
const EVIDENCE_FILTER =
  '(meta-analysis[pt] OR systematic[sb] OR "randomized controlled trial"[pt] OR review[pt])';

function eutilsParams(extra: Record<string, string>): URLSearchParams {
  // NCBI 400s on an empty api_key param, so only include creds that are set.
  const base: Record<string, string> = { db: "pubmed", tool: "jim-bro", ...extra };
  if (process.env.NCBI_API_KEY) base.api_key = process.env.NCBI_API_KEY;
  if (process.env.NCBI_EMAIL) base.email = process.env.NCBI_EMAIL;
  return new URLSearchParams(base);
}

// NCBI allows 3 req/s without an API key and 10 with one; going over earns 429s
// and persistent offenders get their IP blocked. Every E-utilities call goes
// through here: requests are spaced into slots under the limit (safe even with
// concurrent callers), and 429/5xx/network errors back off exponentially,
// honouring Retry-After when NCBI sends it.
const GAP_MS = process.env.NCBI_API_KEY ? 125 : 400;
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 60_000;
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eutilsFetch(url: URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + GAP_MS;
    if (at > now) await sleep(at - now);

    let status = 0;
    let retryAfter = NaN;
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (r.status !== 429 && r.status < 500) return r;
      status = r.status;
      retryAfter = Number(r.headers.get("retry-after"));
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
    }
    if (attempt >= MAX_RETRIES)
      throw new Error(`E-utilities ${status} after ${attempt + 1} attempts`);
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
    log.warn("eutils backoff", { status, attempt: attempt + 1, backoff_ms: backoff });
    // Push every queued caller back too, so a 429 slows the whole run down.
    nextSlot = Math.max(nextSlot, Date.now() + backoff);
    await sleep(backoff);
  }
}

export type SearchResult = { count: number; ids: string[]; warnings: string[] };

// One esearch call. `count` is PubMed's total for the query; `ids` is at most
// `retmax` of them (PubMed caps a single result window at 10,000). `warnings`
// surfaces terms PubMed couldn't map or silently dropped, e.g. a mistyped MeSH.
export async function esearchPage(
  term: string,
  opts: { retmax: number; evidenceFilter?: boolean },
): Promise<SearchResult> {
  const u = new URL(`${E}/esearch.fcgi`);
  u.search = eutilsParams({
    term: opts.evidenceFilter === false ? term : `(${term}) AND ${EVIDENCE_FILTER}`,
    retmax: String(opts.retmax),
    retmode: "json",
    sort: "relevance",
  }).toString();
  const r = await eutilsFetch(u);
  if (!r.ok) throw new Error(`esearch ${r.status}: ${await r.text()}`);
  const res = ((await r.json()) as { esearchresult?: Xml }).esearchresult ?? {};
  const warnings = [
    ...((res.errorlist?.phrasesnotfound as string[]) ?? []).map((p) => `not found: ${p}`),
    ...((res.warninglist?.quotedphrasesnotfound as string[]) ?? []).map(
      (p) => `quoted not found: ${p}`,
    ),
    ...((res.warninglist?.phrasesignored as string[]) ?? []).map((p) => `ignored: ${p}`),
  ];
  return { count: Number(res.count ?? 0), ids: (res.idlist as string[]) ?? [], warnings };
}

export async function esearch(term: string, retmax: number): Promise<string[]> {
  return (await esearchPage(term, { retmax })).ids;
}

export async function efetch(pmids: string[]): Promise<string> {
  // POST so large ID batches don't blow the URL length limit.
  const r = await eutilsFetch(new URL(`${E}/efetch.fcgi`), {
    method: "POST",
    body: eutilsParams({ id: pmids.join(","), retmode: "xml" }),
  });
  if (!r.ok) throw new Error(`efetch ${r.status}: ${await r.text()}`);
  return r.text();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // AbstractText can repeat (structured abstracts) — always treat as array.
  isArray: (name) =>
    [
      "PubmedArticle",
      "AbstractText",
      "Author",
      "PublicationType",
      "MeshHeading",
      "ArticleId",
    ].includes(name),
});

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  // Mixed content nodes come back as { "#text": "...", ... }.
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"]);
  }
  return "";
}

// Map a PubMed PublicationType list → our evidence ranking (strongest wins).
function evidenceLevel(pubTypes: string[]): EvidenceLevel {
  const t = pubTypes.map((s) => s.toLowerCase());
  if (t.some((s) => s.includes("meta-analysis"))) return "meta-analysis";
  if (t.some((s) => s.includes("systematic review"))) return "systematic-review";
  if (t.some((s) => s.includes("randomized controlled trial"))) return "rct";
  if (t.some((s) => s.includes("cohort") || s.includes("observational"))) return "cohort";
  if (t.some((s) => s.includes("review"))) return "narrative-review";
  if (t.some((s) => s.includes("guideline"))) return "guideline";
  return "other";
}

function mapArticle(article: Xml): KnowledgeSource | null {
  const cit = article?.MedlineCitation;
  const art = cit?.Article;
  if (!cit || !art) return null;

  const pmid = asText(cit.PMID);
  if (!pmid) return null;

  const title = asText(art.ArticleTitle);
  const absParts: string[] = (art.Abstract?.AbstractText ?? [])
    .map((p: unknown) => {
      const label =
        typeof p === "object" && p && "@_Label" in (p as Record<string, unknown>)
          ? `${(p as Record<string, unknown>)["@_Label"]}: `
          : "";
      return `${label}${asText(p)}`.trim();
    })
    .filter(Boolean);
  const abstract = absParts.join("\n");

  const pubTypes: string[] = (art.PublicationTypeList?.PublicationType ?? [])
    .map(asText)
    .filter(Boolean);

  const authors: string[] = (art.AuthorList?.Author ?? [])
    .map((a: Record<string, unknown>) =>
      [asText(a.ForeName), asText(a.LastName)].filter(Boolean).join(" "),
    )
    .filter(Boolean);

  const mesh: string[] = (cit.MeshHeadingList?.MeshHeading ?? [])
    .map((m: Record<string, unknown>) => asText(m.DescriptorName))
    .filter(Boolean);

  const ids: Array<Record<string, unknown>> = article?.PubmedData?.ArticleIdList?.ArticleId ?? [];
  const doi = asText(ids.find((x) => x?.["@_IdType"] === "doi")) || undefined;

  const year = Number(
    asText(art.Journal?.JournalIssue?.PubDate?.Year) || asText(cit.DateCompleted?.Year) || "",
  );

  return {
    id: `pmid:${pmid}`,
    source: "pubmed",
    pmid,
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    title,
    abstract,
    journal: asText(art.Journal?.Title) || undefined,
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    authors,
    mesh,
    evidence_level: evidenceLevel(pubTypes),
    pub_types: pubTypes,
    content_hash: contentHash({ title, abstract }),
    indexed: false,
    deleted: false,
  };
}

export async function parseRecords(xml: string): Promise<KnowledgeSource[]> {
  const doc = parser.parse(xml);
  const articles: Xml[] = doc?.PubmedArticleSet?.PubmedArticle ?? [];
  return articles.map(mapArticle).filter((s): s is KnowledgeSource => !!s && !!s.abstract);
}

// Ingest one topic: search → fetch in batches → skip unchanged → upsert.
export async function ingestTopic(
  term: string,
  max: number,
): Promise<{ topic: string; sources: number; chunks: number }> {
  const pmids = await esearch(term, max);
  log.info("esearch", { term, found: pmids.length });

  let sources = 0;
  let chunks = 0;
  // efetch in pages of 100 to keep requests modest.
  for (let i = 0; i < pmids.length; i += 100) {
    const page = pmids.slice(i, i + 100);
    const xml = await efetch(page);
    const records = await parseRecords(xml);

    // Skip records whose content hash is unchanged AND already indexed (§5.4).
    const fresh: KnowledgeSource[] = [];
    for (const rec of records) {
      const existing = await getSource(rec.id);
      if (existing && existing.indexed && existing.content_hash === rec.content_hash) continue;
      fresh.push(rec);
    }

    const res = await ingestSources(fresh);
    sources += res.sources;
    chunks += res.chunks;
    log.info("ingested page", { term, page: page.length, fresh: fresh.length, chunks: res.chunks });
  }
  return { topic: term, sources, chunks };
}

async function main() {
  const args = process.argv.slice(2);
  const maxFlag = args.indexOf("--max");
  const max = maxFlag >= 0 ? Number(args[maxFlag + 1]) : 100;
  const useDefaults = args.includes("--defaults");
  const terms = useDefaults
    ? DEFAULT_TOPICS
    : args.filter((a) => !a.startsWith("--") && a !== String(max));

  if (terms.length === 0) {
    console.error('Usage: bun run .../pubmed.ts "topic query" [--max N]  |  --defaults');
    process.exit(1);
  }

  log.info("pubmed ingest starting", { terms: terms.length, max });
  let totalSources = 0;
  let totalChunks = 0;
  for (const term of terms) {
    const r = await ingestTopic(term, max);
    totalSources += r.sources;
    totalChunks += r.chunks;
  }
  log.info("pubmed ingest complete", { sources: totalSources, chunks: totalChunks });
}

if (import.meta.main) {
  await main();
}
