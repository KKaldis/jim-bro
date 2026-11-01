// Chat result cards — the OUTPUT half of the tool-UI scheme.
//
// Mutating tools open a bespoke INPUT form before they run (forms/overrides.tsx).
// Read/compute tools render a bespoke OUTPUT card after they run: instead of the
// model describing kcals / macros / BMI in prose, we draw the same widgets the
// rest of the app uses (the calorie ring, macro bars, metric gauges).
//
// A tool opts in by (1) joining RESULT_CARD_TOOLS in packages/agent/src/tools/registry.ts
// (so the agent attaches its structured result to tool_finished + the prompt
// tells it to keep the text short) and (2) registering a component in
// RESULT_CARDS below. The component receives the tool's raw result as `data`
// (typed unknown — read defensively) and the wire `category` for theming.
//
// Cards must degrade to null when the data isn't card-able (e.g. an error
// result, profile_missing) so the chat falls back to the agent's text.
import type { ResultCardToolName } from "@fa/shared";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { type ComponentType, useState } from "react";
import { useTranslation } from "react-i18next";

import { Collapsible } from "../components/ui/collapsible";
import type { ToolCategory } from "../lib/toolCategory";
import { cn } from "../lib/utils";
import {
  BmiCard,
  BodyCompositionCard,
  BodyFatCard,
  BodyShapeCard,
  FfmiCard,
  IdealProportionsCard,
  IdealWeightCard,
  LeanBodyMassCard,
  MaxPotentialCard,
  ProgressCard,
  Vo2MaxCard,
} from "./bodyCards";
import {
  BmrCard,
  CalorieDeficitCard,
  DayOverviewCard,
  FoodMacroCard,
  HydrationResultCard,
  MacroSplitResultCard,
  MealPreviewCard,
  ProductCard,
  ProteinTargetCard,
  ShoppingListCard,
  StepCaloriesCard,
  SubstituteCard,
  TargetsCard,
  WaterIntakeCard,
} from "./nutritionCards";
import { CardShell, isObj, num, str } from "./primitives";
import {
  HeartRateZonesCard,
  LastSetsCard,
  OneRepMaxCard,
  PlateRackingCard,
  PowerliftingCard,
  RpeCard,
  StrengthLevelCard,
  SymmetryCard,
  TrainingKcalCard,
  TrainingVolumeCard,
  WarmupCard,
} from "./trainingCards";

export type ResultCardProps = { data: unknown; category: ToolCategory };
type ResultCard = ComponentType<ResultCardProps>;

// Sources behind an evidence-based answer — the model's `cite` tool result.
// One card, one row per source: a title (linked when a URL is given), a muted
// authors · journal · year byline, and the one-line finding it supports.
// Degrades to null when there are no usable sources so the chat falls back to
// the model's prose.
function SourcesCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const raw = isObj(data) && Array.isArray(data.sources) ? data.sources : [];
  const sources = raw.filter(isObj).filter((s) => str(s.title));
  if (sources.length === 0) return null;
  const count = t("cards.sources.count", { count: sources.length });
  return (
    <CardShell category={category} title={t("cards.sources.title")} subtitle={count}>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t("cards.sources.hide") : t("cards.sources.show")}
          <ChevronDown
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
          />
        </button>
      </div>
      <Collapsible open={expanded}>
        <div className="mt-2 divide-y divide-border/60">
          {sources.map((s, i) => {
            const title = str(s.title) ?? t("cards.sources.source");
            const url = str(s.url);
            const year = num(s.year);
            const byline = [str(s.authors), str(s.journal), year != null ? String(year) : null]
              .filter(Boolean)
              .join(" · ");
            const finding = str(s.finding);
            return (
              <div key={i} className="flex gap-2 py-2 first:pt-0 last:pb-0">
                <span className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group inline-flex items-start gap-0.5 text-sm font-medium text-foreground hover:underline"
                    >
                      <span className="min-w-0">{title}</span>
                      <ArrowUpRight className="mt-0.5 size-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-foreground">{title}</span>
                  )}
                  {byline && <div className="text-xs text-muted-foreground">{byline}</div>}
                  {finding && (
                    <div className="mt-0.5 text-xs text-muted-foreground/90">{finding}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Collapsible>
    </CardShell>
  );
}

// ---------- registry ----------
// Typed by ResultCardToolName (the shared RESULT_CARD_TOOL_NAMES list, which the
// agent's RESULT_CARD_TOOLS is also built from): every carded tool MUST have a
// component here and vice versa, so a drift between the two sides is a compile
// error rather than a tool result silently falling back to prose.
const RESULT_CARDS: Record<ResultCardToolName, ResultCard> = {
  get_todays_macros: DayOverviewCard,
  get_water_status: HydrationResultCard,
  compute_targets: TargetsCard,
  compute_bmr: BmrCard,
  preview_meal: MealPreviewCard,
  compute_bmi: BmiCard,
  compute_ffmi: FfmiCard,
  estimate_body_fat: BodyFatCard,
  get_body_composition: BodyCompositionCard,
  estimate_vo2_max: Vo2MaxCard,
  compute_heart_rate_zones: HeartRateZonesCard,
  compute_macro_split: MacroSplitResultCard,
  compute_protein_target: ProteinTargetCard,
  compute_calorie_deficit: CalorieDeficitCard,
  compute_ideal_weight: IdealWeightCard,
  compute_lean_body_mass: LeanBodyMassCard,
  compute_water_intake: WaterIntakeCard,
  compute_step_calories: StepCaloriesCard,
  compute_one_rep_max: OneRepMaxCard,
  assess_strength_level: StrengthLevelCard,
  compute_powerlifting_score: PowerliftingCard,
  strength_symmetry: SymmetryCard,
  plate_barbell_racking: PlateRackingCard,
  convert_rpe: RpeCard,
  plan_warmup_sets: WarmupCard,
  compute_training_volume: TrainingVolumeCard,
  lookup_food: FoodMacroCard,
  lookup_product: ProductCard,
  substitute_food: SubstituteCard,
  estimate_training_kcal: TrainingKcalCard,
  compute_max_potential: MaxPotentialCard,
  compute_ideal_proportions: IdealProportionsCard,
  classify_body_shape: BodyShapeCard,
  progress_report: ProgressCard,
  last_sets_for_exercise: LastSetsCard,
  shopping_list: ShoppingListCard,
  cite: SourcesCard,
};

export function getResultCard(toolName: string): ResultCard | null {
  return RESULT_CARDS[toolName as ResultCardToolName] ?? null;
}
