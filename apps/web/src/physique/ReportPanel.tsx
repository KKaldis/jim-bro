import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dumbbell, Flame, Ruler, Scale, TriangleAlert } from "lucide-react";
import { muscleLabel } from "@/lib/catalogLabels";
import type { PhysiqueReport } from "@fa/shared/physique";
import { Button } from "@/components/ui/button";
import type { Subject } from "./analyse";

// The body-scan result, under the captured photo. Labels are translated; the
// reason / warning sentences come from the shared engine in English, like the
// calculators' method notes.

const WIDTH_PARTS = ["shoulders", "chest", "waist", "hips", "neck"];
const GIRTH_PARTS = ["neck", "chest", "waist", "hips", "upper_arm", "forearm", "thigh", "calf"];
type RatioKey = "shoulders/waist" | "chest/waist" | "shoulders/hips" | "waist/hips";
// Bar range per ratio: wide enough for most builds, tight enough to read.
const RATIO_RANGE: Record<RatioKey, [number, number]> = {
  "shoulders/waist": [1, 2],
  "chest/waist": [0.9, 1.6],
  "shoulders/hips": [0.9, 1.7],
  "waist/hips": [0.6, 1.1],
};
// Goal-shape targets the priorities are ranked against (shape.py SHAPE_TARGETS).
const RATIO_TARGET: Record<string, Partial<Record<RatioKey, number>>> = {
  v_taper: { "shoulders/waist": 1.75, "shoulders/hips": 1.4 },
  square: { "shoulders/waist": 1.55, "shoulders/hips": 1.3 },
  hourglass: { "waist/hips": 0.7, "shoulders/hips": 1.15 },
};

const card = "rounded-2xl border border-white/10 bg-white/4 p-4";

function Title({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-3 text-[11px] font-semibold tracking-[0.14em] text-white/45 uppercase">
      {children}
    </h3>
  );
}

const pctOf = (v: number, [lo, hi]: [number, number]) =>
  Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

/** Value bar with an optional goal tick; colour says how close to the goal. */
function RatioBar({
  label,
  value,
  target,
  range,
  goalText,
}: {
  label: string;
  value: number;
  target?: number;
  range: [number, number];
  goalText?: string;
}) {
  const off = target != null ? Math.abs(value - target) / target : null;
  const tone =
    off == null
      ? "bg-sky-400"
      : off < 0.05
        ? "bg-emerald-400"
        : off < 0.12
          ? "bg-amber-400"
          : "bg-rose-400";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-white/75">{label}</span>
        <span className="font-mono font-semibold tabular-nums">
          {value.toFixed(2)}
          {goalText && <span className="ms-1.5 text-xs font-normal text-white/40">{goalText}</span>}
        </span>
      </div>
      <div dir="ltr" className="relative h-2 rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${pctOf(value, range)}%` }}
        />
        {target != null && (
          <div
            className="absolute -top-1 h-4 w-0.5 rounded-full bg-white"
            style={{ left: `calc(${pctOf(target, range)}% - 1px)` }}
          />
        )}
      </div>
    </div>
  );
}

export function ReportPanel({
  report: r,
  subject,
  onAddHeight,
  onTips,
}: {
  report: PhysiqueReport;
  subject: Subject;
  onAddHeight: () => void;
  onTips: () => void;
}) {
  const { t } = useTranslation();
  const part = (p: string) => t(`physique.parts.${p}`, { defaultValue: p.replace(/_/g, " ") });
  const targets = RATIO_TARGET[r.goalShape] ?? {};
  const asym = Object.entries(r.asymmetryPct).filter(([, v]) => Math.abs(v) >= 3);
  const widths = WIDTH_PARTS.filter((p) => r.widths[p] != null);
  const girths = GIRTH_PARTS.filter((p) => r.girths[p] != null);
  const ratios = (Object.keys(RATIO_RANGE) as RatioKey[]).filter((k) => r.ratios[k] != null);

  const priorityLabel = (target: string, kind: string) => {
    if (target === "reduce_waist_fat") return t("physique.report.reduceWaist");
    if (kind === "balance") {
      const side = target.endsWith("_left") ? "left" : "right";
      return `${part(target.replace(/_(left|right)$/, ""))} · ${t(`physique.report.side.${side}`)}`;
    }
    return muscleLabel(target);
  };
  const KindIcon = { muscle: Dumbbell, nutrition: Flame, balance: Scale } as const;

  return (
    <div className="space-y-3 text-white">
      {/* Headline + how the centimetres were derived. */}
      <div className={`${card} bg-linear-to-br from-emerald-500/15 via-white/4 to-transparent`}>
        <p className="text-[11px] font-semibold tracking-[0.14em] text-emerald-300/80 uppercase">
          {t("physique.report.bodyShape")}
        </p>
        <p className="mt-1 text-3xl font-black tracking-tight">
          {r.shape === "unknown"
            ? t("physique.report.shapeUnknown")
            : t(`physique.shapes.${r.shape}`)}
        </p>
        {r.scale ? (
          <div className="mt-3 flex items-start gap-2 text-sm text-white/70">
            <Ruler className="mt-0.5 size-4 shrink-0 text-emerald-300" />
            <span>
              {t("physique.report.scale", {
                cmPerPx: r.scale.cmPerPx.toFixed(3),
                heightPx: r.scale.heightPx,
                heightCm: r.scale.heightCm,
              })}
            </span>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-amber-200">
              {t(
                `physique.report.torso.${r.torsoReason ?? (subject.heightCm ? "feet_cut" : "no_height")}`,
              )}
            </p>
            {(r.torsoReason === "no_height" || !subject.heightCm) && (
              <Button size="sm" variant="secondary" className="gap-1.5" onClick={onAddHeight}>
                <Ruler className="size-4" /> {t("physique.report.addHeight")}
              </Button>
            )}
          </div>
        )}
        {/* Set expectations up front: photo girths are estimates, the tape is the record. */}
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
          <span>{t("physique.report.accuracy")}</span>
        </div>
      </div>

      {widths.length > 0 && (
        <section className={card}>
          <Title>{t("physique.report.widths")}</Title>
          <div className="grid grid-cols-3 gap-2">
            {widths.map((p) => (
              <div key={p} className="rounded-xl bg-white/6 px-3 py-2.5">
                <p className="truncate text-[11px] text-white/50">{part(p)}</p>
                <p className="mt-0.5 font-mono text-xl font-bold tabular-nums">
                  {r.widths[p]}
                  <span className="ms-0.5 text-xs font-normal text-white/45">{r.units}</span>
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {ratios.length > 0 && (
        <section className={`${card} space-y-4`}>
          <Title>{t("physique.report.ratios")}</Title>
          {ratios.map((k) => (
            <RatioBar
              key={k}
              label={k.split("/").map(part).join(" : ")}
              value={r.ratios[k]!}
              target={targets[k]}
              range={RATIO_RANGE[k]}
              goalText={
                targets[k] != null
                  ? t("physique.report.target", { value: targets[k]!.toFixed(2) })
                  : undefined
              }
            />
          ))}
        </section>
      )}

      {girths.length > 0 && (
        <section className={card}>
          <Title>{t("physique.report.girths")}</Title>
          <div className="grid grid-cols-2 gap-x-5 gap-y-2">
            {girths.map((p) => (
              <div
                key={p}
                className="flex items-baseline justify-between border-b border-white/5 pb-1.5 text-sm"
              >
                <span className="text-white/65">{part(p)}</span>
                <span className="font-mono font-semibold tabular-nums">{r.girths[p]} cm</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-white/45">{t("physique.report.girthsNote")}</p>
        </section>
      )}

      {(r.bodyFat || r.somatotype) && (
        <section className={card}>
          <Title>{t("physique.report.composition")}</Title>
          <div className="grid grid-cols-2 gap-3">
            {r.bodyFat && (
              <div>
                <p className="text-[11px] text-white/50">{t("physique.report.bodyFat")}</p>
                <p className="font-mono text-2xl font-bold tabular-nums">{r.bodyFat.pct}%</p>
                <p className="text-[11px] text-white/45">
                  {t(`physique.report.bfSource.${r.bodyFat.source}`)}
                </p>
              </div>
            )}
            {r.somatotype && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-white/50">{t("physique.report.somatotype")}</p>
                {(
                  [
                    ["endo", r.somatotype.endomorphy, "bg-rose-400"],
                    ["meso", r.somatotype.mesomorphy, "bg-emerald-400"],
                    ["ecto", r.somatotype.ectomorphy, "bg-sky-400"],
                  ] as const
                ).map(([k, v, tone]) => (
                  <div
                    key={k}
                    className="grid grid-cols-[2.5rem_1fr_2rem] items-center gap-2 text-xs"
                  >
                    <span className="text-white/55">{t(`physique.report.soma.${k}`)}</span>
                    <span className="h-1.5 rounded-full bg-white/10">
                      {v != null && (
                        <span
                          className={`block h-full rounded-full ${tone}`}
                          style={{ width: `${Math.min(100, (v / 7) * 100)}%` }}
                        />
                      )}
                    </span>
                    <span className="text-end font-mono tabular-nums">{v ?? "–"}</span>
                  </div>
                ))}
                {r.somatotype.category && (
                  <p className="text-[11px] text-white/45 capitalize">{r.somatotype.category}</p>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {asym.length > 0 && (
        <section className={`${card} space-y-3`}>
          <Title>{t("physique.report.balance")}</Title>
          {asym.map(([p, v]) => {
            const w = Math.min(50, (Math.abs(v) / 20) * 50);
            return (
              <div key={p} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-white/65">{part(p)}</span>
                  <span className="text-xs text-white/55">
                    {t("physique.report.biggerSide", {
                      pct: Math.abs(v),
                      side: t(`physique.report.side.${v > 0 ? "left" : "right"}`),
                    })}
                  </span>
                </div>
                {/* Subject's left is drawn on the left of the bar. */}
                <div dir="ltr" className="relative h-1.5 rounded-full bg-white/10">
                  <div className="absolute -top-0.75 left-1/2 h-3 w-px bg-white/50" />
                  <div
                    className={`absolute h-full rounded-full ${Math.abs(v) >= 6 ? "bg-amber-400" : "bg-white/40"}`}
                    style={
                      v > 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }
                    }
                  />
                </div>
              </div>
            );
          })}
        </section>
      )}

      {r.priorities.length > 0 && (
        <section className={card}>
          <Title>{t("physique.report.priorities")}</Title>
          <ol className="space-y-2">
            {r.priorities.slice(0, 6).map((p, i) => {
              const Icon = KindIcon[p.kind];
              return (
                <li key={p.target} className="flex gap-3 rounded-xl bg-white/5 p-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <Icon className="size-3.5 text-emerald-300" />
                      {priorityLabel(p.target, p.kind)}
                    </p>
                    <p className="mt-0.5 text-xs/relaxed text-white/55">{p.reason}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {r.warnings.length > 0 && (
        <section className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-200">
            <TriangleAlert className="size-4" /> {t("physique.report.checkThese")}
          </p>
          <ul className="list-disc space-y-1.5 ps-5 text-xs/relaxed text-amber-100/80">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            className="-ms-2 mt-2 text-amber-200 hover:bg-amber-400/10 hover:text-amber-100"
            onClick={onTips}
          >
            {t("physique.guide.open")}
          </Button>
        </section>
      )}

      <details className="px-1 pt-1">
        <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.14em] text-white/40 uppercase">
          {t("physique.report.method", { count: r.notes.length + 1 })}
        </summary>
        <ul className="mt-2 space-y-1.5 text-xs text-white/45">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>{t("physique.report.uncalibrated")}</li>
        </ul>
      </details>

      <p className="px-1 pb-2 text-xs text-white/40">{t("physique.result.privacy")}</p>
    </div>
  );
}
