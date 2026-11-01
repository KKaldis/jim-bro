// Generate PWA icons from public/logo-2.svg.
// The logo is a white path on a transparent canvas, so icons are rendered as
// the logo centered on a dark square matching the app theme (#0d1117).
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
const svg = readFileSync(join(pub, "logo-2.svg"));

const BG = { r: 0x0d, g: 0x11, b: 0x17, alpha: 1 };

// Render the logo scaled to `inner` px (longest side), centered on a `size`
// square dark background.
async function icon(size, inner, { transparent = false } = {}) {
  const logo = await sharp(svg)
    .resize({
      width: inner,
      height: inner,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const offset = Math.round((size - inner) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : BG,
    },
  })
    .composite([{ input: logo, top: offset, left: offset }])
    .png()
    .toBuffer();
}

async function write(name, buf) {
  writeFileSync(join(pub, name), buf);
  console.log("wrote", name, `(${buf.length} bytes)`);
}

// Minimal ICO encoder wrapping PNG images.
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// `fill` = fraction of the canvas the logo's longest side should occupy.
// ~0.82 for standard icons; smaller safe-zone for maskable.
const fill = (size, ratio) => Math.round(size * ratio);

await write("pwa-64x64.png", await icon(64, fill(64, 0.82)));
await write("pwa-192x192.png", await icon(192, fill(192, 0.82)));
await write("pwa-512x512.png", await icon(512, fill(512, 0.82)));
// Maskable: keep logo within the central safe zone (~62%) so platform masks
// (circle, squircle) don't clip it.
await write("maskable-icon-512x512.png", await icon(512, fill(512, 0.62)));
await write("apple-touch-icon-180x180.png", await icon(180, fill(180, 0.82)));

const ico16 = await icon(16, fill(16, 0.92));
const ico32 = await icon(32, fill(32, 0.9));
const ico48 = await icon(48, fill(48, 0.88));
await write(
  "favicon.ico",
  buildIco([
    { size: 16, data: ico16 },
    { size: 32, data: ico32 },
    { size: 48, data: ico48 },
  ]),
);
