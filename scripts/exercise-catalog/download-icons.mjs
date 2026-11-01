// Download the exercise silhouette PNGs into apps/web/public/exercise-icons/.
// Slugs come from icon-slugs.json (produced by generate.mjs).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../apps/web/public/exercise-icons");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const slugs = JSON.parse(fs.readFileSync(path.join(__dirname, "icon-slugs.json"), "utf8"));

fs.mkdirSync(OUT, { recursive: true });

let ok = 0;
let fail = 0;
for (let i = 0; i < slugs.length; i++) {
  const slug = slugs[i];
  const dest = path.join(OUT, `${slug}.png`);
  const url = `https://static.strengthlevel.com/images/exercises/${slug}/icons/${slug}-icon-128.png`;
  try {
    execSync(`curl -sfL --max-time 25 -A "${UA}" "${url}" -o "${dest}"`);
    if (fs.statSync(dest).size > 200) ok++;
    else {
      fail++;
      console.error(`SMALL/empty: ${slug}`);
    }
  } catch (e) {
    fail++;
    console.error(`FAIL ${slug}: ${e.message}`);
  }
  if (i % 40 === 0) console.error(`[${i}/${slugs.length}]`);
}
console.error(`\ndone: ${ok} ok, ${fail} failed -> ${OUT}`);
