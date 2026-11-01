import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Open-Graph summary the server scrapes for a pasted URL (mirror of the server's
// LinkPreview type in apps/server/src/link-preview.ts).
type LinkPreview = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
};

// A card is only worth rendering if we got something beyond the bare URL.
type State = "loading" | { preview: LinkPreview } | "none";

// Module-level cache keyed by the requested URL, shared across every rendered
// card. Chat re-renders constantly (streaming, scroll pagination re-converts
// history) and the same link can appear in many turns — resolve each URL once
// per session. Stores the resolving promise so concurrent mounts of the same
// URL share one request; the server also caches, so this is belt-and-braces.
const cache = new Map<string, Promise<LinkPreview | null>>();

function fetchPreview(url: string): Promise<LinkPreview | null> {
  const existing = cache.get(url);
  if (existing) return existing;
  const p = (async (): Promise<LinkPreview | null> => {
    try {
      const res = await fetch(`/link-preview?url=${encodeURIComponent(url)}`, {
        credentials: "include",
      });
      // 204 = the server couldn't build a preview (unreachable / non-HTML /
      // blocked host) — degrade to the plain link already in the message text.
      if (res.status === 204 || !res.ok) return null;
      const body = (await res.json()) as LinkPreview;
      // Require at least a title or image, else the card adds nothing.
      if (!body.title && !body.image) return null;
      return body;
    } catch {
      return null;
    }
  })();
  cache.set(url, p);
  return p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Thumbnail card rendered under a chat message that contains a pasted URL. Lazily
// fetches the link's OG metadata and shows a favicon/host + title + description
// with the og:image. Renders nothing until it resolves, and nothing at all if no
// usable metadata came back (the URL still shows as text/link in the message).
//
// `onSurface` (an aliased tint) is used from within the user's primary-colored
// bubble so the card reads as translucent-on-primary instead of a jarring
// light card; assistant bubbles use the default muted card surface.
export function LinkPreviewCard({ url, onSurface = false }: { url: string; onSurface?: boolean }) {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let alive = true;
    setState("loading");
    fetchPreview(url).then((p) => {
      if (!alive) return;
      setState(p ? { preview: p } : "none");
    });
    return () => {
      alive = false;
    };
  }, [url]);

  if (state === "none") return null;

  const surface = onSurface
    ? "border-primary-foreground/25 bg-primary-foreground/10 hover:bg-primary-foreground/15"
    : "border-border bg-muted/50 hover:bg-muted";

  if (state === "loading") {
    return (
      <div className={cn("my-1 flex gap-2 rounded-lg border p-2", surface)}>
        <div className="size-14 shrink-0 animate-pulse rounded-sm bg-current opacity-10" />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
          <div className="h-3 w-1/2 animate-pulse rounded-sm bg-current opacity-10" />
          <div className="h-2.5 w-3/4 animate-pulse rounded-sm bg-current opacity-10" />
        </div>
      </div>
    );
  }

  const p = state.preview;
  return (
    <a
      href={p.url}
      target="_blank"
      rel="noopener noreferrer"
      title={p.title ?? p.url}
      className={cn(
        "my-1 flex gap-2.5 overflow-hidden rounded-lg border p-2 no-underline transition-colors",
        surface,
      )}
    >
      {p.image && (
        <img
          src={p.image}
          alt=""
          loading="lazy"
          onError={(e) => {
            // A broken og:image shouldn't leave an empty box — drop it and let
            // the text column take the full width.
            e.currentTarget.style.display = "none";
          }}
          className="size-16 shrink-0 rounded-sm object-cover"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex items-center gap-1 text-[11px] opacity-70">
          {p.favicon ? (
            <img
              src={p.favicon}
              alt=""
              className="size-3.5 rounded-sm"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <Link2 aria-hidden className="size-3.5" />
          )}
          <span className="min-w-0 truncate">{p.siteName || hostOf(p.url)}</span>
        </div>
        {p.title && <span className="line-clamp-2 text-xs font-semibold">{p.title}</span>}
        {p.description && (
          <span className="line-clamp-2 text-[11px] opacity-80">{p.description}</span>
        )}
      </div>
    </a>
  );
}

// Extract unique http(s) URLs from a chunk of message text, in first-seen order.
// Trailing sentence punctuation is trimmed so "see https://x.com/a." doesn't
// carry the period into the fetched URL.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;
// Punctuation that shouldn't be considered part of a trailing URL.
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const cleaned = m[0].replace(TRAILING_PUNCT, "");
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

// Render plain message text with its http(s) URLs turned into clickable links,
// preserving whitespace/newlines. Used for user messages (which render as raw
// text, not markdown) so a pasted link is tappable, not just selectable.
export function LinkifiedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    // Keep trailing punctuation as plain text, outside the link.
    const trailing = raw.match(TRAILING_PUNCT)?.[0] ?? "";
    const href = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-baseline gap-0.5 underline underline-offset-2 hover:opacity-80"
      >
        {href}
        <ExternalLink aria-hidden className="size-3 shrink-0 self-center opacity-80" />
      </a>,
    );
    if (trailing) parts.push(trailing);
    last = start + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="wrap-break-word whitespace-pre-wrap">{parts}</span>;
}
