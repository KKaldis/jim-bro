import { describe, expect, test } from "bun:test";
import { isBlockedHost, parseLinkPreview } from "./link-preview.ts";

describe("isBlockedHost", () => {
  test("blocks loopback, private, link-local and bare hosts", () => {
    for (const h of [
      "localhost",
      "myserver", // bare hostname, no dot
      "db.internal",
      "printer.local",
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "::1",
      "fd00::1",
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test("allows normal public hostnames", () => {
    for (const h of ["example.com", "www.nytimes.com", "sub.domain.co.uk", "172.15.0.1"]) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
});

describe("parseLinkPreview", () => {
  const BASE = "https://recipes.example.com/pasta";

  test("prefers og:* tags and absolutizes a relative image", () => {
    const html = `<!doctype html><html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Best Pasta &amp; Sauce" />
      <meta property="og:description" content="A quick weeknight recipe" />
      <meta property="og:image" content="/img/pasta.jpg" />
      <meta property="og:site_name" content="Example Recipes" />
      <link rel="icon" href="/favicon.png" />
    </head><body></body></html>`;
    const p = parseLinkPreview(html, BASE);
    expect(p.url).toBe(BASE);
    expect(p.title).toBe("Best Pasta & Sauce"); // entity decoded
    expect(p.description).toBe("A quick weeknight recipe");
    expect(p.image).toBe("https://recipes.example.com/img/pasta.jpg");
    expect(p.siteName).toBe("Example Recipes");
    expect(p.favicon).toBe("https://recipes.example.com/favicon.png");
  });

  test("falls back to <title> and twitter tags, single-quoted attrs", () => {
    const html = `<head>
      <title>Doc Title</title>
      <meta name='twitter:image' content='https://cdn.example.com/x.png'>
      <meta name='description' content='meta desc'>
    </head>`;
    const p = parseLinkPreview(html, BASE);
    expect(p.title).toBe("Doc Title");
    expect(p.image).toBe("https://cdn.example.com/x.png");
    expect(p.description).toBe("meta desc");
    // No explicit favicon link → defaults to /favicon.ico on the origin.
    expect(p.favicon).toBe("https://recipes.example.com/favicon.ico");
  });

  test("drops a non-http(s) image (e.g. data: URI)", () => {
    const html = `<head><meta property="og:image" content="data:image/png;base64,AAAA"></head>`;
    const p = parseLinkPreview(html, BASE);
    expect(p.image).toBeUndefined();
  });
});
