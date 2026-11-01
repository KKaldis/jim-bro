// Recursive character text splitter (LangChain-style) for the ingest pipeline.
//
// Splits on a *hierarchy* of separators, preferring paragraph → sentence → word
// boundaries and only ever hard-cutting mid-word as a last resort. Small pieces
// are greedily packed back up to the target size, carrying a little trailing
// overlap into the next chunk so a fact that straddles a boundary stays
// retrievable from both sides.
//
// Pure, dependency-free, deterministic — see chunk.test.ts.

// Coarsest → finest. "" is the terminal "hard cut anywhere" fallback.
const SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""];

export type Chunk = { text: string; index: number };

export type SplitOptions = {
  // Target max chunk size in characters. ~4 chars/token, so 2048 ≈ 512 tokens.
  maxChars?: number;
  // Trailing characters carried from one chunk into the next. Defaults to 15%.
  overlapChars?: number;
};

// Split `text` into overlapping chunks. Returns [] for empty/whitespace input.
export function splitText(text: string, opts: SplitOptions = {}): Chunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? 2048);
  const overlap = Math.min(
    Math.max(0, opts.overlapChars ?? Math.floor(maxChars * 0.15)),
    maxChars - 1,
  );
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pieces = split(trimmed, 0, maxChars);
  return mergeWithOverlap(pieces, maxChars, overlap).map((t, index) => ({ text: t, index }));
}

// Recursively break `text` down using progressively finer separators until every
// piece is <= maxChars (or we've exhausted the separator list).
function split(text: string, sepIdx: number, maxChars: number): string[] {
  if (text.length <= maxChars || sepIdx >= SEPARATORS.length) return [text];

  const sep = SEPARATORS[sepIdx];
  const parts = sep === "" ? hardCut(text, maxChars) : text.split(sep);

  const out: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    // Re-attach the separator we split on so reassembly preserves the text.
    const piece = sep === "" ? part : part + sep;
    if (piece.length > maxChars) out.push(...split(piece, sepIdx + 1, maxChars));
    else out.push(piece);
  }
  return out;
}

function hardCut(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

// Greedily pack pieces up to maxChars; when a chunk closes, seed the next one
// with the last `overlap` chars of it so boundary-straddling facts survive.
function mergeWithOverlap(pieces: string[], maxChars: number, overlap: number): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const p of pieces) {
    if (buf && buf.length + p.length > maxChars) {
      chunks.push(buf.trim());
      buf = overlap > 0 ? tailOverlap(buf, overlap) : "";
    }
    buf += p;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// Take ~`overlap` trailing chars but snap to a word boundary so the carried
// context starts on a whole word, not mid-token.
function tailOverlap(s: string, overlap: number): string {
  const tail = s.slice(-overlap);
  const space = tail.indexOf(" ");
  return space > 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
}
