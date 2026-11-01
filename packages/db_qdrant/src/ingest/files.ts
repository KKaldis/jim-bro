// Ingest a local reference file (PDF, guideline, book chapter, markdown) into
// the knowledge base: upload the original binary to object storage (MinIO),
// extract its text, then run the raw → split → embed → upsert pipeline. The
// stored object backs the citation URL so users can open the source document.
//
//   bun run packages/db_qdrant/src/ingest/files.ts ./guidelines/nsca-ch7.pdf \
//     --title "NSCA Essentials Ch.7" --evidence textbook
//
// Text extraction: .txt/.md/.html inline; .pdf via the optional `pdf-parse`
// dependency (or pass pre-extracted text via the `text` option).

import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@fa/logger";
import { putObject, publicUrl } from "@fa/storage";
import { ingestSources, contentHash } from "./common.ts";
import type { EvidenceLevel, KnowledgeSource } from "../types.ts";

const log = logger.child({ mod: "file-ingest" });

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
};

export type FileIngestMeta = {
  source?: string; // default "upload"
  title?: string; // default file basename (sans extension)
  evidence_level?: EvidenceLevel;
  year?: number;
  tags?: string[];
  // Pre-extracted text; when given, skips automatic extraction.
  text?: string;
};

async function extractText(bytes: Buffer, ext: string): Promise<string> {
  if ([".txt", ".md", ".markdown", ".html", ".htm"].includes(ext)) {
    return bytes.toString("utf8");
  }
  if (ext === ".pdf") {
    try {
      // Non-literal specifier so TS doesn't try to resolve the (untyped)
      // optional dependency's types across package boundaries.
      const specifier = "pdf-parse";
      const mod = await import(specifier);
      const pdf = ((mod as { default?: unknown }).default ?? mod) as (
        b: Buffer,
      ) => Promise<{ text: string }>;
      return (await pdf(bytes)).text;
    } catch (err) {
      throw new Error(
        "PDF extraction needs the optional 'pdf-parse' dependency (npm i pdf-parse) " +
          `or pass { text }. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(`Unsupported file type "${ext}"; pass { text } with the extracted content.`);
}

// Upload + index one file. Returns the stored object key, its served URL, and
// how many sources/chunks were written.
export async function ingestFile(
  path: string,
  meta: FileIngestMeta = {},
): Promise<{ object_key: string; url: string; sources: number; chunks: number }> {
  const bytes = await readFile(path);
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  // Content-addressed key so re-uploading the same file is idempotent.
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const key = `docs/${hash}/${name}`;

  await putObject(key, bytes, CONTENT_TYPES[ext] ?? "application/octet-stream");

  const text = (meta.text ?? (await extractText(bytes, ext))).trim();
  const title = meta.title ?? name.replace(/\.[^.]+$/, "");
  const url = publicUrl(key);
  const src: KnowledgeSource = {
    id: `doc:${hash}`,
    source: meta.source ?? "upload",
    url,
    object_key: key,
    title,
    abstract: text,
    authors: [],
    mesh: meta.tags ?? [],
    evidence_level: meta.evidence_level,
    pub_types: [],
    year: meta.year,
    content_hash: contentHash({ title, abstract: text }),
    indexed: false,
    deleted: false,
  };

  const res = await ingestSources([src]);
  log.info("ingested file", { key, title, chunks: res.chunks });
  return { object_key: key, url, ...res };
}

function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error(
      'Usage: bun run .../files.ts <path> [--title "..."] [--evidence <level>] [--year N]',
    );
    process.exit(1);
  }
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return ingestFile(path, {
    title: flag("title"),
    evidence_level: flag("evidence") as EvidenceLevel | undefined,
    year: flag("year") ? Number(flag("year")) : undefined,
  }).then((r) => log.info("done", r));
}

if (import.meta.main) {
  await main();
}
