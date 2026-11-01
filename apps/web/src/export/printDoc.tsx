/**
 * PDF export via the browser's own print pipeline. A printable document is
 * rendered with React into a hidden, isolated iframe (its own stylesheet — no
 * Tailwind, no app theme, always light) and handed to `print()`, where the
 * user picks "Save as PDF". Using the browser keeps the bundle free of a PDF
 * library and renders Greek (and any other script) with the system fonts,
 * which a jsPDF-style generator would need embedded font files for.
 *
 * The iframe's <title> (mirrored onto the parent document while printing)
 * becomes the suggested file name in Chrome / Edge / Safari.
 */
import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileDown } from "lucide-react";
import type { Macros } from "@fa/shared";
import i18n from "../i18n";
import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { isoToDisplay } from "../lib/dateFormat";
import { toIso, today } from "../dateRange";
import { vizCss } from "./printViz";

const FRAME_ID = "fa-print-frame";

let active: { frame: HTMLIFrameElement; root: Root; restoreTitle: string } | null = null;

function cleanup() {
  if (!active) return;
  const { frame, root, restoreTitle } = active;
  active = null;
  document.title = restoreTitle;
  // Unmount after the current tick — afterprint can fire mid-render on Safari.
  setTimeout(() => {
    root.unmount();
    frame.remove();
  }, 0);
}

// File-name-safe version of a title ("Push / Pull: v2" → "Push - Pull - v2").
function fileTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

// Renders `content` into a fresh off-screen print frame and waits for its
// fonts and images (the logo) so nothing prints half-loaded.
export async function mountPrintFrame(title: string, content: ReactNode): Promise<Window> {
  cleanup();
  document.getElementById(FRAME_ID)?.remove();

  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Off-screen but laid out (a display:none / zero-size frame prints blank in
  // some engines).
  Object.assign(frame.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "800px",
    height: "1100px",
    border: "0",
  });
  document.body.appendChild(frame);

  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    frame.remove();
    throw new Error("Print frame unavailable");
  }
  const name = fileTitle(title);
  doc.open();
  doc.write(
    // lang = UI language: Greek uppercase labels only drop their accents
    // (ΒΑΡΟΣ, not ΒΆΡΟΣ) when the document is marked el.
    `<!doctype html><html lang="${i18n.language}" dir="${i18n.dir()}"><head><meta charset="utf-8"><title></title><style>${printCss(window.location.origin)}</style></head><body><main id="print-root"></main></body></html>`,
  );
  doc.close();
  doc.title = name;

  const root = createRoot(doc.getElementById("print-root")!);
  flushSync(() => root.render(<PrintPage>{content}</PrintPage>));
  active = { frame, root, restoreTitle: document.title };
  document.title = name;

  // Capped so one stuck icon can't hold the export hostage; anything still
  // loading after that just prints without it.
  await Promise.race([
    Promise.all([
      doc.fonts?.ready,
      ...Array.from(doc.images, (img) => img.decode().catch(() => undefined)),
    ]),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  return win;
}

export async function printDocument(title: string, content: ReactNode): Promise<void> {
  const win = await mountPrintFrame(title, content);
  win.addEventListener("afterprint", cleanup, { once: true });
  win.focus();
  win.print();
  // Desktop browsers block in print() until the dialog closes; afterprint
  // covers the async (mobile) ones. Either way the frame is gone afterwards,
  // and a stale one is cleared by the next export.
}

// Runs an export (fetch + print) from a click handler, surfacing failures as
// a toast instead of an unhandled rejection.
export async function runExport(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (e) {
    console.error("[export]", e);
    toast.error(i18n.t("export.failed"));
  }
}

// "Export PDF" entry for a row's RowActions menu.
export function ExportPdfMenuItem({ onSelect }: { onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <FileDown className="size-4" />
      {t("export.exportPdf")}
    </DropdownMenuItem>
  );
}

// ---------- shared print building blocks ----------

// Every document sits in a one-cell table whose <thead> holds the brand
// strip: browsers repeat a table's header group at the top of each printed
// page, which is the portable way to get a running header.
function PrintPage({ children }: { children: ReactNode }) {
  return (
    <table className="page">
      <thead>
        <tr>
          <td>
            <BrandStrip />
          </td>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{children}</td>
        </tr>
      </tbody>
    </table>
  );
}

function BrandStrip() {
  const { t } = useTranslation();
  return (
    <div className="doc-band">
      {/* Jim-Bro's silhouette is white artwork, hence the dark band. */}
      <div className="doc-logo">
        <img src={`${window.location.origin}/logo-2.svg`} alt="" className="doc-logo-icon" />
        <span className="doc-wordmark">Jim-Bro.ai</span>
      </div>
      <span className="doc-date">
        {t("export.generatedOn", { date: isoToDisplay(toIso(today())) })}
      </span>
    </div>
  );
}

export function PrintHeader({
  title,
  subtitle,
  kind,
}: {
  title: string;
  subtitle?: ReactNode;
  // Small label above the title: "Workout plan", "Recipe", …
  kind: string;
}) {
  return (
    <header className="doc-header">
      <div className="doc-titles">
        <p className="doc-kind">{kind}</p>
        <h1>{title}</h1>
        {subtitle && <p className="doc-sub">{subtitle}</p>}
      </div>
    </header>
  );
}

export type Stat = { label: string; value: string; note?: string };

export function StatGrid({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="stats">
      {stats.map((s) => (
        <div key={s.label} className="stat">
          <div className="stat-label">{s.label}</div>
          <div className="stat-value">{s.value}</div>
          {s.note && <div className="stat-note">{s.note}</div>}
        </div>
      ))}
    </div>
  );
}

// kcal / protein / fat / carbs (/ fiber) as a stat row.
export function MacroStats({ macros, label }: { macros: Macros; label?: string }) {
  const { t } = useTranslation();
  const stats: Stat[] = [
    { label: t("export.kcal"), value: String(Math.round(macros.kcal)), note: label },
    { label: t("export.protein"), value: `${Math.round(macros.p)} g` },
    { label: t("export.fat"), value: `${Math.round(macros.f)} g` },
    { label: t("export.carbs"), value: `${Math.round(macros.c)} g` },
  ];
  if (macros.fiber != null)
    stats.push({ label: t("export.fiber"), value: `${Math.round(macros.fiber)} g` });
  return <StatGrid stats={stats} />;
}

// kcal / P / F / C table cells; "—" for a portion whose macros can't resolve.
export function MacroCells({ m }: { m: Macros | null | undefined }) {
  if (!m)
    return (
      <>
        <td className="num">—</td>
        <td className="num">—</td>
        <td className="num">—</td>
        <td className="num">—</td>
      </>
    );
  return (
    <>
      <td className="num">{Math.round(m.kcal)}</td>
      <td className="num">{Math.round(m.p)}</td>
      <td className="num">{Math.round(m.f)}</td>
      <td className="num">{Math.round(m.c)}</td>
    </>
  );
}

export function fmt(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

export function signed(n: number, digits = 1): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(digits)}`;
}

// Single-series line chart for the progress report. Print is static, so no
// hover layer: the first / last values are labelled directly, min / max sit on
// a recessive y-axis, and the dates bound the x-axis.
export function PrintLineChart({
  points,
  unit,
  digits = 1,
  half = false,
  even = false,
  trend,
  reference,
}: {
  points: Array<{ date: string; value: number }>;
  unit: string;
  digits?: number;
  // Half-width chart for a two-up row: a narrower viewBox so its labels print
  // at the same size as a full-width chart's.
  half?: boolean;
  // Points evenly spaced in order instead of at their date (the screen's
  // "even" spacing).
  even?: boolean;
  // A rolling average (one value per point), styled like the app's LineChart:
  // a thick average line over the raw line faded to dashes, labelled top-left.
  trend?: { values: number[]; label: string } | null;
  // A dashed horizontal target line (e.g. an ideal girth); the y range
  // stretches to include it.
  reference?: { value: number; label: string } | null;
}) {
  if (points.length < 2) return null;
  const W = half ? 320 : 640;
  const H = half ? 140 : 150;
  const pad = { l: 44, r: 56, t: trend ? 22 : 12, b: 22 };
  const xs = points.map((p, i) => (even ? i : new Date(p.date + "T00:00:00").getTime()));
  const ys = [
    ...points.map((p) => p.value),
    ...(trend?.values ?? []),
    ...(reference ? [reference.value] : []),
  ];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  // A flat series gets a band proportional to its value (±2%), so a steady
  // 1.45 ratio isn't drawn on a 0.45–2.45 axis.
  if (y1 - y0 < 1e-9) {
    const flat = Math.max(Math.abs(y0) * 0.02, 10 ** -digits);
    y0 -= flat;
    y1 += flat;
  }
  const yPad = (y1 - y0) * 0.12;
  y0 -= yPad;
  y1 += yPad;
  const sx = (x: number) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(p.value).toFixed(1)}`)
    .join("");
  const ticks = [y0 + yPad, (y0 + y1) / 2, y1 - yPad];
  // A narrow range (61 → 62 bpm) would print repeated labels; add decimals
  // until the three ticks read differently.
  let tickDigits = digits;
  while (tickDigits < 3 && new Set(ticks.map((v) => v.toFixed(tickDigits))).size < ticks.length)
    tickDigits++;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={unit}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} className="chart-grid" />
          <text x={pad.l - 6} y={sy(v) + 3} textAnchor="end" className="chart-axis">
            {v.toFixed(tickDigits)}
          </text>
        </g>
      ))}
      {reference && (
        <>
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={sy(reference.value)}
            y2={sy(reference.value)}
            className="chart-ref"
          />
          <text x={W - pad.r} y={sy(reference.value) - 4} textAnchor="end" className="chart-axis">
            {reference.label}
          </text>
        </>
      )}
      <path d={path} className={trend ? "chart-line raw" : "chart-line"} />
      {trend && (
        <>
          <path
            d={trend.values
              .map((v, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`)
              .join("")}
            className="chart-trend"
          />
          <line x1={pad.l} x2={pad.l + 16} y1={8} y2={8} className="chart-trend" />
          <text x={pad.l + 22} y={11} className="chart-axis">
            {trend.label}
          </text>
        </>
      )}
      {/* A small dot on every point, as in the app's charts. */}
      {points.map((p, i) => (
        <circle key={p.date + i} cx={sx(xs[i])} cy={sy(p.value)} r={2} className="chart-pt" />
      ))}
      {[0, points.length - 1].map((i) => (
        <circle key={i} cx={sx(xs[i])} cy={sy(points[i].value)} r={4} className="chart-dot" />
      ))}
      <text x={sx(xs[points.length - 1]) + 8} y={sy(last.value) + 4} className="chart-label">
        {last.value.toFixed(digits)} {unit}
      </text>
      <text x={pad.l} y={H - 4} className="chart-axis">
        {isoToDisplay(first.date)}
      </text>
      <text x={W - pad.r} y={H - 4} textAnchor="end" className="chart-axis">
        {isoToDisplay(last.date)}
      </text>
    </svg>
  );
}

// Print stylesheet. Plain CSS (the iframe has no Tailwind); system font stacks
// all carry Greek glyphs. Side padding lives on <body> rather than the @page
// box: horizontal padding repeats on every printed page, so the text keeps
// its gutter even when the print dialog's margins are set to "None".
const ACCENT = "oklch(0.55 0.21 256)";

function printCss(origin: string): string {
  return `
@font-face { font-family: "Evogria"; src: url("${origin}/fonts/Evogria-Italic.otf") format("opentype"); font-style: italic; }
@page {
  size: A4; margin: 10mm 0 14mm;
  @bottom-center { content: counter(page) " / " counter(pages); font: 8pt system-ui, sans-serif; color: #a1a1aa; }
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; padding: 0 14mm; color: #18181b; background: #fff;
  font: 10pt/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif;
}
h1, h2, h3 { margin: 0; line-height: 1.25; }
h2 {
  font-size: 12.5pt; font-weight: 700; margin: 26px 0 12px; padding-bottom: 6px;
  border-bottom: 2px solid #e4e4e7; break-after: avoid;
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
}
h2::before { content: ""; width: 4px; height: 0.95em; border-radius: 2px; background: ${ACCENT}; align-self: center; }
h3 { font-size: 10.5pt; font-weight: 650; margin: 14px 0 6px; break-after: avoid; }
.block h3 { margin: 0; }
p { margin: 0 0 8px; }
.muted { color: #71717a; }
.small { font-size: 8.5pt; }
.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.nowrap { white-space: nowrap; }

/* One-cell wrapper table: its thead (the brand strip) repeats on every page.
   Reset it so the content tables' styles below don't leak onto it. */
table.page { margin: 0; font-size: inherit; }
table.page > thead > tr > td, table.page > tbody > tr > td { padding: 0; border: 0; background: none; }
table.page > tbody > tr { break-inside: auto; }
table.page > thead > tr > td { padding-bottom: 16px; }
/* A trailing bottom margin would spill onto an otherwise empty last page. */
table.page > tbody > tr > td > :last-child { margin-bottom: 0; }

.doc-band {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  background: #0c0c10; color: #e4e4e7; border-radius: 10px; padding: 8px 16px;
}
.doc-logo { display: flex; align-items: center; gap: 9px; }
.doc-logo-icon { height: 24px; width: auto; display: block; }
.doc-wordmark { font: italic 800 13pt/1 "Evogria", system-ui, sans-serif; color: #fff; }
.doc-date { font-size: 8pt; color: #a1a1aa; }
.doc-header { margin: 0 0 22px; }
.doc-titles { padding: 4px 4px 14px; border-bottom: 3px solid ${ACCENT}; }
.doc-kind { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .1em; color: ${ACCENT}; margin: 0 0 4px; }
h1 { font-size: 22pt; font-weight: 750; letter-spacing: -.015em; }
.doc-sub { margin: 6px 0 0; color: #52525b; font-size: 10pt; }

.block { border: 1px solid #e4e4e7; border-radius: 10px; padding: 14px 16px; margin: 0 0 14px; break-inside: avoid; }
.block-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 5px; }
.chip { font-size: 8pt; padding: 2px 9px; border-radius: 999px; background: #f4f4f5; color: #3f3f46; border: 1px solid #e4e4e7; }
/* Exercise-type pills, as in the app: compound solid, isolation outlined, cardio dashed. */
.type-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.type-tag { font-size: 7pt; font-weight: 600; line-height: 1.3; padding: 0 6px; border-radius: 999px; border: 1px solid ${ACCENT}; color: ${ACCENT}; white-space: nowrap; }
.type-tag.compound { background: ${ACCENT}; color: #fff; }
.type-tag.cardio { border-style: dashed; }

table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 0 0 6px; }
th {
  text-align: left; font-weight: 600; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em;
  color: #71717a; padding: 7px 10px; background: #f6f6f7; border-bottom: 1px solid #e4e4e7;
}
th.num { text-align: right; }
td { padding: 7px 10px; border-bottom: 1px solid #f0f0f2; vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
tfoot td { font-weight: 650; border-top: 1.5px solid #d4d4d8; border-bottom: 0; padding-top: 8px; }

.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; margin: 0 0 16px; break-inside: avoid; }
.stat { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; background: #fafafa; }
.stat-label { font-size: 7.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #71717a; }
.stat-value { font-size: 14pt; font-weight: 750; font-variant-numeric: tabular-nums; margin-top: 2px; }
.stat-note { font-size: 8pt; color: #71717a; margin-top: 1px; }
.warn { color: #b45309; font-size: 8.5pt; }
.bar { display: block; height: 8px; border-radius: 4px; background: #f0f0f2; margin-top: 5px; overflow: hidden; }
.bar > span { display: block; height: 100%; border-radius: 4px; background: ${ACCENT}; }

.md { line-height: 1.6; }
.md p, .md li { margin: 0 0 6px; }
.md ol, .md ul { margin: 0 0 8px; padding-left: 22px; }
.md h1, .md h2, .md h3 { font-size: 10.5pt; border: 0; margin: 12px 0 6px; padding: 0; display: block; }
.md h2::before { display: none; }
.md table td, .md table th { border: 1px solid #e4e4e7; }

.chart { width: 100%; height: auto; display: block; margin: 4px 0 14px; break-inside: avoid; }
.chart-grid { stroke: #ececef; stroke-width: 1; }
.chart-axis { fill: #71717a; font-size: 10px; font-variant-numeric: tabular-nums; }
.chart-line { fill: none; stroke: ${ACCENT}; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart-line.raw { stroke-opacity: .35; stroke-width: 1.5; stroke-dasharray: 4 3; }
.chart-trend { fill: none; stroke: ${ACCENT}; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
.chart-pt { fill: ${ACCENT}; }
.chart-ref { stroke: #a1a1aa; stroke-width: 1.5; stroke-dasharray: 6 4; }
.chart-dot { fill: ${ACCENT}; stroke: #fff; stroke-width: 2; }
.chart-label { fill: #18181b; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.section { break-inside: auto; }
/* Short sections that read badly split (one table + heading): move whole. */
.keep { break-inside: avoid; }
.page-start { break-before: page; }
.footer-note { margin-top: 22px; padding-top: 10px; border-top: 1px solid #e4e4e7; font-size: 8pt; color: #a1a1aa; }
a { color: ${ACCENT}; }
.day-muscles { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #e4e4e7; }
.day-muscle-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 12px; margin-top: 6px; }
.day-muscle { display: flex; align-items: center; gap: 8px; font-size: 9pt; }
.day-muscle-name { font-weight: 600; line-height: 1.2; }
.day-muscle .mmap { width: 30px; height: 30px; flex-shrink: 0; }
.meal-share { display: flex; align-items: center; gap: 8px; width: 42%; }
.meal-share .bar { flex: 1; margin-top: 0; }
.meal-share .small { white-space: nowrap; }
${vizCss(ACCENT)}`;
}
