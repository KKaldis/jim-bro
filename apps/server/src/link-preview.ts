// Open-Graph / link-preview extraction for URLs pasted into chat. The browser
// can't fetch arbitrary origins (CORS) or read their <meta> tags, so the server
// fetches the page, scrapes the social-card metadata, and hands back a small
// JSON summary the UI renders as a thumbnail card under the user's message.
//
// The pure bits (SSRF host guard + HTML parsing) live here so they can be
// unit-tested without a network; the request handler in index.ts wraps them
// with auth, a small response cache, and logging (mirrors barcode.ts).

export type LinkPreview = {
  // The final URL after redirects — what the card links to.
  url: string;
  title?: string;
  description?: string;
  // Absolute (relative og:image URLs are resolved against the final URL).
  image?: string;
  siteName?: string;
  favicon?: string;
};

// Only ever fetch normal web pages. Anything that resolves to the host's own
// network is a Server-Side Request Forgery vector (cloud metadata endpoints,
// internal admin panels), so we refuse those hostnames outright. This is a
// literal-host guard: it blocks obvious private/loopback targets and bare
// hostnames, but a public domain that DNS-resolves to a private IP would slip
// through — acceptable for a preview helper, not for a general fetch proxy.
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  // Bare hostnames (no dot) and common internal TLDs never point at the public
  // web — treat them as internal.
  if (!h.includes(".")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (h === "localhost") return true;

  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h.startsWith("[::1]")) return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;

  // IPv4 literals in private / loopback / link-local ranges (incl. the
  // 169.254.169.254 cloud-metadata endpoint).
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

// Decode the handful of HTML entities that actually show up in scraped title /
// description text. Full entity decoding would need a table; these cover the
// common cases (&amp; &lt; &gt; &quot; &#39; numeric refs).
function decodeEntities(s: string): string {
  return s
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent: string) => {
      if (ent[0] === "#") {
        const code =
          ent[1] === "x" || ent[1] === "X"
            ? parseInt(ent.slice(2), 16)
            : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      return named[ent.toLowerCase()] ?? m;
    })
    .trim();
}

// Resolve a possibly-relative asset URL against the page URL; drop anything
// that isn't a real http(s) resource (data: URIs, javascript:, garbage).
function absolutize(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

// Scrape Open-Graph / Twitter-card / standard metadata out of a page's HTML.
// Regex-based (no DOM dependency) — matches the og:image rewriting already done
// on the SPA shell in index.ts. Attribute order varies across sites, so we pull
// property/name and content independently from each <meta> tag.
export function parseLinkPreview(html: string, finalUrl: string): LinkPreview {
  const meta = new Map<string, string>();
  const attr = (tag: string, name: string): string | undefined => {
    const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    return m ? (m[2] ?? m[3]) : undefined;
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = attr(tag, "property") ?? attr(tag, "name");
    const content = attr(tag, "content");
    if (key && content != null && !meta.has(key.toLowerCase())) {
      meta.set(key.toLowerCase(), content);
    }
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = meta.get(k);
      if (v && v.trim()) return decodeEntities(v);
    }
    return undefined;
  };

  // <title> fallback when there's no og:title.
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const docTitle = titleTag ? decodeEntities(titleTag[1]) : undefined;

  // First <link rel="...icon..."> for the favicon; default to /favicon.ico.
  let favicon: string | undefined;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = attr(tag, "rel");
    if (rel && /\bicon\b/i.test(rel)) {
      favicon = attr(tag, "href");
      if (favicon) break;
    }
  }

  const preview: LinkPreview = { url: finalUrl };
  const title = pick("og:title", "twitter:title") ?? docTitle;
  const description = pick("og:description", "twitter:description", "description");
  const image = absolutize(
    pick("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"),
    finalUrl,
  );
  const siteName = pick("og:site_name", "application-name");
  const fav = absolutize(favicon ?? "/favicon.ico", finalUrl);

  if (title) preview.title = title.slice(0, 300);
  if (description) preview.description = description.slice(0, 500);
  if (image) preview.image = image;
  if (siteName) preview.siteName = siteName.slice(0, 120);
  if (fav) preview.favicon = fav;
  return preview;
}

// Read at most `maxBytes` of the response body as UTF-8 text, stopping early
// once we've seen </head> (all the metadata we care about lives in <head>).
// Guards against a hostile server streaming gigabytes at us.
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      const head = out.indexOf("</head>");
      if (head >= 0) {
        out = out.slice(0, head + 7);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

// A recent desktop-Chrome UA — many sites gate their og:* tags behind a
// browser-shaped User-Agent and serve a bare page (or a bot wall) otherwise.
const PREVIEW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

// Fetch a URL and extract its link preview. Follows redirects manually so every
// hop's host passes the SSRF guard (an allowed host could 30x to an internal
// one). Returns null for anything that isn't a fetchable public http(s) HTML
// page, or on timeout / network error — the caller degrades to a plain link.
export async function fetchLinkPreview(
  rawUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<LinkPreview | null> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return null;
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (isBlockedHost(current.hostname)) return null;
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": PREVIEW_UA,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en",
        },
      });

      // Manual redirect handling: validate the next host before following.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) return null;
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return null;
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") return null;
        current = next;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(ctype)) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const html = await readCapped(res, MAX_HTML_BYTES);
      return parseLinkPreview(html, current.toString());
    }
    return null; // too many redirects
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
