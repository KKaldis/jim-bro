import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChefHat } from "lucide-react";
import { Input } from "@/components/ui/input";
import { isoToDisplay } from "@/lib/dateFormat";
import { TimeInput } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useGetRecipesId } from "@/api/endpoints/default/default";
import { Field, SectionLabel, TogglePills, UnitInput } from "./formKit";
import { useFormContext } from "./formContext";
import { LogMacroPreview } from "./LogMacroPreview";
import type { ToolOverrideProps } from "./overrides";
import { MEAL_SLOTS } from "../lib/mealSlots";
import { toggleItemClass } from "../lib/navItem";

// Bespoke gate form for `log_recipe` — "I ate the chicken rice bowl". The model
// picks the recipe (by recipe_id / name), so identity is shown read-only; the
// user picks the slot (+ optional time) it lands in (the date is the day the
// UI is focused on) and HOW MUCH. The amount is
// expressed in SERVINGS — what a person actually eats ("1 serving", "half a
// serving") — or, when they weighed their plate, in GRAMS of the finished dish
// (a fraction of the batch's summed ingredient weight). Never a whole-batch
// multiplier. The live preview shows what gets frozen into the log vs today's
// target, mirroring RecipeForm's per-serving bars.

type LogRecipeInput = {
  recipe_id?: number;
  name?: string;
  date?: string;
  slot?: string;
  time?: string;
  servings?: number;
  // Grams of the finished dish eaten. When set it wins over `servings` (server
  // side too), so the form keeps exactly one of the two populated.
  grams?: number;
  // Legacy whole-batch multiplier (1 = the ENTIRE batch). Some agent calls
  // still propose `scale`; it's converted to `servings` on load so the form —
  // and everything it submits — only ever speaks in servings.
  scale?: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
// Compact serving count: drop the decimal when it's whole (2 not 2.0).
const fmtServings = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function LogRecipeForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const v = (value as LogRecipeInput) ?? {};
  const set = (patch: Partial<LogRecipeInput>) => onChange({ ...v, ...patch });
  const { ctx } = useFormContext();

  // Resolve the recipe (name + live macros) from the opaque id the model chose.
  const { data } = useGetRecipesId(v.recipe_id as number, {
    query: { enabled: v.recipe_id != null },
  });
  const recipe = data?.recipe;
  const name = recipe?.name ?? v.name ?? t("forms.recipe.thisRecipe");

  // Where the log lands when nothing was proposed: the viewed day, and a
  // clock-based slot guess so the common case is one tap.
  const placement = () => {
    const h = new Date().getHours();
    const guess = h < 11 ? "breakfast" : h < 16 ? "lunch" : h < 21 ? "dinner" : "snack";
    return { date: v.date ?? ctx.selectedDateIso, slot: v.slot ?? guess };
  };

  // Mount-only defaults, in ONE set() (separate effects would each spread the
  // same stale `v` and clobber each other). The date is the day the UI is
  // focused on (logging follows the viewed day, not always today); the slot
  // gets a clock-based guess; with no amount proposed at all, a SINGLE serving
  // — never the whole batch, the #1 log_recipe mistake. That serving switches
  // to its WEIGHT (the default mode) once the recipe loads — see below.
  const defaultedAmount = useRef(false);
  useEffect(() => {
    if (disabled) return;
    const noAmount = v.servings == null && v.grams == null && !(v.scale != null && v.scale > 0);
    defaultedAmount.current = noAmount;
    if (!v.date || !v.slot || noAmount) {
      set({
        ...placement(),
        ...(noAmount ? { servings: 1, scale: undefined } : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The model may still propose a legacy whole-batch `scale`; convert it to
  // servings once the recipe's serving count is known so the form only ever
  // speaks in servings (or grams).
  useEffect(() => {
    if (disabled || v.servings != null || v.grams != null) return;
    if (v.scale == null || !(v.scale > 0) || !recipe) return;
    // placement() too: on a cached recipe this runs in the same commit as the
    // mount effect, whose date/slot this set() would otherwise drop.
    set({ ...placement(), servings: round2(v.scale * recipe.servings), scale: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, disabled]);

  // The batch's weight is its summed ingredient grams — what `grams` divides by.
  const batchGrams = recipe ? recipe.ingredients.reduce((sum, i) => sum + (i.grams || 0), 0) : 0;
  const byWeight = v.grams != null;
  // Everything downstream reduces to a fraction of the batch: N servings ⇒
  // N / servings, G grams ⇒ G / batchGrams.
  const servings = v.servings != null && v.servings > 0 ? v.servings : 1;
  const grams = v.grams != null && v.grams > 0 ? v.grams : 0;
  const fraction = recipe
    ? byWeight
      ? batchGrams > 0
        ? grams / batchGrams
        : 0
      : servings / (recipe.servings > 0 ? recipe.servings : 1)
    : 0;
  const tot = recipe?.totals;
  const scaled = tot
    ? { kcal: tot.kcal * fraction, p: tot.p * fraction, f: tot.f * fraction, c: tot.c * fraction }
    : null;
  // Weight of one serving — the default when switching to grams.
  const servingGrams =
    recipe && batchGrams > 0 ? Math.round(batchGrams / (recipe.servings || 1)) : 100;

  // Weight is the default mode: when no amount was proposed, the defaulted
  // single serving becomes one serving's grams once the batch weight is known
  // (unless the user already changed it). Recipes with no ingredient weights
  // stay on servings.
  useEffect(() => {
    if (disabled || !recipe || !defaultedAmount.current) return;
    defaultedAmount.current = false;
    if (batchGrams <= 0 || v.grams != null || (v.servings != null && v.servings !== 1)) return;
    // placement() too, for the same same-commit reason as the scale effect.
    set({ ...placement(), grams: servingGrams, servings: undefined, scale: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, disabled]);

  const slotIsCustom =
    v.slot != null && !MEAL_SLOTS.includes(v.slot as (typeof MEAL_SLOTS)[number]);

  // Quick-pick SERVINGS — what a person eats. Batch-cooked recipes (servings > 1)
  // also get a "whole batch" chip so logging the entire thing stays one tap.
  const quickPicks: Array<{ label: string; value: number }> =
    recipe && recipe.servings > 1
      ? [
          { label: "½", value: 0.5 },
          { label: "1", value: 1 },
          { label: "2", value: 2 },
          {
            label: t("forms.logRecipe.wholeBatch", { count: recipe.servings }),
            value: recipe.servings,
          },
        ]
      : [
          { label: "½", value: 0.5 },
          { label: "1", value: 1 },
          { label: "2", value: 2 },
        ];

  return (
    <div className="space-y-4">
      <SectionLabel Icon={ChefHat} info={t("forms.logRecipe.titleInfo")}>
        {t("forms.logRecipe.title")}
      </SectionLabel>

      {/* ── Recipe identity (read-only — the model chose it) ─────────── */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-background/40 px-3 py-2.5 shadow-well">
        <div className="flex min-w-0 items-center gap-2">
          <ChefHat className="size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            {recipe && (
              <p className="text-[11px] text-muted-foreground">
                {t("forms.logRecipe.makesServings", { count: recipe.servings })} ·{" "}
                {recipe.per_serving.kcal.toFixed(0)} {t("forms.logRecipe.kcalPerServing")}
              </p>
            )}
          </div>
        </div>
        {v.recipe_id != null && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums opacity-70">
            #{v.recipe_id}
          </span>
        )}
      </div>

      {/* Some ingredients can't resolve → log_recipe errors with
          needs_enrichment. Warn up front so it's not a surprise on Save. */}
      {recipe && recipe.unresolved > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-[11px] text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{t("forms.logRecipe.unresolved", { count: recipe.unresolved })}</span>
        </div>
      )}

      {/* ── How much: servings (+ quick picks) or grams ─────────────── */}
      <TogglePills
        options={[
          { value: "grams", label: t("forms.logRecipe.byWeight") },
          { value: "servings", label: t("forms.logRecipe.byServings") },
        ]}
        value={byWeight ? "grams" : "servings"}
        disabled={disabled}
        onChange={(mode) =>
          mode === "grams"
            ? set({ grams: v.grams ?? servingGrams, servings: undefined, scale: undefined })
            : set({ servings: v.servings ?? 1, grams: undefined, scale: undefined })
        }
      />
      {byWeight ? (
        <Field label={t("forms.logRecipe.grams")} info={t("forms.logRecipe.gramsInfo")}>
          <div className="flex items-center gap-2">
            <div className="w-28">
              <UnitInput
                value={v.grams ?? ""}
                disabled={disabled}
                placeholder={String(servingGrams)}
                step="any"
                min={0}
                suffix="g"
                onChange={(n) => set({ grams: n ?? 0 })}
              />
            </div>
            {recipe && batchGrams > 0 && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t("forms.logRecipe.batchWeighs", { grams: Math.round(batchGrams) })}
              </span>
            )}
          </div>
        </Field>
      ) : (
        <Field label={t("forms.logRecipe.amount")} info={t("forms.logRecipe.amountInfo")}>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {quickPicks.map((q) => {
                const active = round2(servings) === q.value;
                return (
                  <button
                    key={q.label}
                    type="button"
                    disabled={disabled}
                    onClick={() => set({ servings: q.value })}
                    aria-pressed={active}
                    className={cn(
                      "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                      toggleItemClass(active),
                    )}
                  >
                    {q.label}
                  </button>
                );
              })}
            </div>
            <div className="w-20">
              <UnitInput
                value={v.servings ?? ""}
                disabled={disabled}
                placeholder="1"
                step="any"
                min={0}
                onChange={(n) => set({ servings: n })}
              />
            </div>
          </div>
        </Field>
      )}

      {/* ── Where it lands: slot + optional time. The date is the day the UI
          is focused on (set on mount), shown read-only. ────────────────── */}
      <div>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label={t("forms.logMeal.slot")}>
            <Select
              value={slotIsCustom ? "__custom" : (v.slot ?? "")}
              onValueChange={(next) => {
                if (next === "__custom") set({ slot: v.slot ?? "" });
                else set({ slot: next });
              }}
              disabled={disabled}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={t("forms.logMeal.choose")} />
              </SelectTrigger>
              <SelectContent>
                {MEAL_SLOTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
                <SelectItem value="__custom">{t("forms.logMeal.custom")}</SelectItem>
              </SelectContent>
            </Select>
            {slotIsCustom && (
              <Input
                value={v.slot ?? ""}
                disabled={disabled}
                placeholder={t("forms.logMeal.slotName")}
                onChange={(e) => set({ slot: e.target.value || undefined })}
                className="mt-1 h-9"
              />
            )}
          </Field>
          <Field label={t("forms.logMeal.time")} optional>
            <TimeInput
              value={v.time ?? ""}
              disabled={disabled}
              onChange={(hhmm) => set({ time: hhmm || undefined })}
            />
          </Field>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("forms.logRecipe.loggingTo", { date: isoToDisplay(v.date ?? ctx.selectedDateIso) })}
        </p>
      </div>

      {/* ── Live preview: what gets logged (servings × per-serving) vs target ── */}
      {scaled && (
        <LogMacroPreview
          item={scaled}
          dateIso={v.date ?? ctx.selectedDateIso}
          extra={t("forms.logRecipe.servingsEaten", {
            count: byWeight ? fraction * (recipe?.servings || 1) : servings,
            formatted: fmtServings(
              byWeight ? round2(fraction * (recipe?.servings || 1)) : servings,
            ),
          })}
        />
      )}
    </div>
  );
}
