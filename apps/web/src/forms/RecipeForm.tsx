import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { humanizeFoodName } from "@fa/shared";
import {
  AlertTriangle,
  ChefHat,
  ExternalLink,
  ListOrdered,
  Pencil,
  Plus,
  Star,
  Utensils,
  X,
  Carrot,
  FileText,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MacroBars } from "@/Dashboard";
import { useDailyTarget } from "@/lib/dailyTarget";
import { BatchRepeater, Field, SectionLabel, UnitInput } from "./formKit";
import { FoodPicker, macrosForItem, useFoodDb, type Portion } from "./mealControls";
import { FlagToggle, OverrideMacros, PortionFields } from "./DietEditForms";
import { useGetRecipesId } from "@/api/endpoints/default/default";
import type { ToolOverrideProps } from "./overrides";

// Bespoke recipe entry card — the SINGLE surface for save_recipe, shared by two
// places (the "one component, two surfaces" rule):
//   - the chat gate for save_recipe (registered in overrides.tsx), and
//   - the Recipes tab editor dialog (Recipes.tsx).
// A recipe is a named, reusable bundle of ingredient portions (essentially one
// diet-plan meal standing alone), so this reuses the SAME building blocks as
// DietPlanForm's MealEditor: the shared FoodPicker + live macro math. The value
// it edits IS the save_recipe input shape, so the gate submits it verbatim.

export type RecipeInput = {
  name?: string;
  servings?: number;
  favorite?: boolean;
  notes?: string;
  instructions?: string;
  source_url?: string;
  ingredients?: Portion[];
};

// Per-portion macro-override fields (absolute for the portion, not per-100).
// `labelKey` resolves to a translated label at render time.
const MACRO_FIELDS: Array<{
  key: "kcal" | "p" | "f" | "c";
  labelKey: string;
  suffix: string;
}> = [
  { key: "kcal", labelKey: "forms.recipe.macroKcal", suffix: "" },
  { key: "p", labelKey: "forms.recipe.macroProtein", suffix: "g" },
  { key: "f", labelKey: "forms.recipe.macroFat", suffix: "g" },
  { key: "c", labelKey: "forms.recipe.macroCarbs", suffix: "g" },
];

// A clean, navigable https URL, or null when the input isn't a solid one yet —
// gates the "open" affordance so it never points somewhere broken.
function validHttpsUrl(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

export function RecipeForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const v = (value as RecipeInput) ?? {};
  const { db, foodNames } = useFoodDb();
  const dayTarget = useDailyTarget();
  const [instrPreview, setInstrPreview] = useState(false);
  // Ingredient rows whose macro-override editor is manually open (rows whose
  // food can't resolve auto-open below).
  const [openMacros, setOpenMacros] = useState<Set<number>>(new Set());
  const items = v.ingredients ?? [];

  const set = (patch: Partial<RecipeInput>) => onChange({ ...v, ...patch });
  const patchItem = (i: number, patch: Partial<Portion>) =>
    set({ ingredients: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });
  const toggleMacros = (i: number) =>
    setOpenMacros((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const clearOverride = (i: number) =>
    patchItem(i, { kcal: undefined, p: undefined, f: undefined, c: undefined, fiber: undefined });
  const addItem = () => set({ ingredients: [...items, { food: "", grams: 100 }] });
  const removeItem = (i: number) => set({ ingredients: items.filter((_, idx) => idx !== i) });

  // Live recipe totals across the resolvable ingredients, and per-serving.
  const totals = items.reduce<{ kcal: number; p: number; f: number; c: number }>(
    (acc, it) => {
      const m = macrosForItem(it, db);
      return { kcal: acc.kcal + m.kcal, p: acc.p + m.p, f: acc.f + m.f, c: acc.c + m.c };
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );
  const servings = v.servings && v.servings > 0 ? v.servings : 1;
  const per = {
    kcal: totals.kcal / servings,
    p: totals.p / servings,
    f: totals.f / servings,
    c: totals.c / servings,
  };

  const url = validHttpsUrl(v.source_url);
  // How a single serving sits against today's calorie target — and how many
  // servings would fill it.
  const servingsToTarget = dayTarget && per.kcal > 0 ? dayTarget.kcal / per.kcal : null;
  const targetPct =
    dayTarget && dayTarget.kcal > 0 ? Math.round((per.kcal / dayTarget.kcal) * 100) : null;

  return (
    <div className="space-y-5">
      {/* ── Recipe basics ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={ChefHat} info={t("forms.recipe.recipeInfo")}>
          {t("forms.recipe.recipe")}
        </SectionLabel>
        {/* Name + servings share a row; servings is a bare number (no suffix). */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label={t("forms.recipe.name")}>
              <Input
                value={v.name ?? ""}
                disabled={disabled}
                placeholder={t("forms.recipe.namePlaceholder")}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-24">
            <Field label={t("forms.recipe.servings")}>
              <UnitInput
                value={v.servings ?? ""}
                disabled={disabled}
                placeholder="1"
                step="any"
                min={0}
                onChange={(n) => set({ servings: n })}
              />
            </Field>
          </div>
          {/* Favourite star — mirrors the badge shown on the Recipes list. */}
          <button
            type="button"
            onClick={() => set({ favorite: !v.favorite })}
            disabled={disabled}
            aria-pressed={!!v.favorite}
            title={v.favorite ? t("forms.recipe.removeFavorite") : t("forms.recipe.markFavorite")}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-60",
              v.favorite
                ? "border-amber-400 text-amber-500 hover:bg-amber-400/10"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Star className={cn("size-4", v.favorite && "fill-current")} />
          </button>
        </div>

        {/* Source URL with an inline "open" navigate button, enabled only once
            it's a solid https link. */}
        <Field label={t("forms.recipe.sourceUrl")} optional>
          <div className="relative">
            <Input
              type="url"
              inputMode="url"
              value={v.source_url ?? ""}
              disabled={disabled}
              placeholder={t("forms.recipe.sourceUrlPlaceholder")}
              onChange={(e) => set({ source_url: e.target.value || undefined })}
              className="pe-10"
            />
            <a
              href={url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!url}
              tabIndex={url ? 0 : -1}
              title={url ? t("forms.recipe.openRecipe") : t("forms.recipe.enterValidUrl")}
              onClick={(e) => {
                if (!url) e.preventDefault();
              }}
              className={cn(
                "absolute inset-e-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md transition-colors",
                url
                  ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                  : "pointer-events-none text-muted-foreground/40",
              )}
            >
              <ExternalLink className="size-4" />
            </a>
          </div>
        </Field>
      </section>

      {/* ── Instructions (the method) + notes ─────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel Icon={ListOrdered}>{t("forms.recipe.instructions")}</SectionLabel>
          {/* Write / Preview toggle — see the Markdown rendered without leaving
              the form. */}
          <div className="flex shrink-0 rounded-md border text-xs">
            {(["write", "preview"] as const).map((mode) => {
              const active = instrPreview === (mode === "preview");
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setInstrPreview(mode === "preview")}
                  className={cn(
                    "px-2 py-1 font-medium capitalize transition-colors first:rounded-s-md last:rounded-e-md",
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={active}
                >
                  {mode === "preview" ? t("forms.recipe.preview") : t("forms.recipe.write")}
                </button>
              );
            })}
          </div>
        </div>
        {instrPreview ? (
          <div className="md min-h-32 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            {v.instructions?.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{v.instructions}</ReactMarkdown>
            ) : (
              <EmptyState icon={FileText} compact>
                {t("forms.recipe.nothingToPreview")}
              </EmptyState>
            )}
          </div>
        ) : (
          <Textarea
            value={v.instructions ?? ""}
            disabled={disabled}
            rows={6}
            placeholder={t("forms.recipe.instructionsPlaceholder")}
            onChange={(e) => set({ instructions: e.target.value || undefined })}
          />
        )}
        <Field label={t("forms.recipe.notes")} optional>
          <Input
            value={v.notes ?? ""}
            disabled={disabled}
            placeholder={t("forms.recipe.notesPlaceholder")}
            onChange={(e) => set({ notes: e.target.value || undefined })}
          />
        </Field>
      </section>

      {/* ── Ingredients ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Utensils} hint={t("forms.recipe.ingredients", { count: items.length })}>
          {t("forms.recipe.ingredientsTitle")}
        </SectionLabel>
        <div className="space-y-2 rounded-md border bg-background/60 p-2">
          {items.length === 0 && (
            <EmptyState icon={Carrot} compact>
              {t("forms.recipe.noIngredients")}
            </EmptyState>
          )}
          {items.map((it, i) => {
            const m = macrosForItem(it, db);
            const known = it.food != null && db[it.food] != null;
            const hasOverride = it.kcal != null;
            // Food is referenced but neither in the pantry nor carrying an
            // override — its macros can't resolve (e.g. deleted from the pantry).
            const missing = !!it.food && !known && !hasOverride;
            const showMacros = openMacros.has(i) || missing;
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <FoodPicker
                      value={it.food ?? ""}
                      foodNames={foodNames}
                      db={db}
                      disabled={disabled}
                      onChange={(canonical) => patchItem(i, { food: canonical })}
                    />
                    {/* Tappable macro line: shows the resolved macros, or an
                        amber "set macros" prompt when the food can't resolve. */}
                    <button
                      type="button"
                      onClick={() => toggleMacros(i)}
                      className={cn(
                        "mt-0.5 flex items-center gap-1 text-[10px] transition-colors",
                        missing ? "text-warning" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {missing ? (
                        <>
                          <AlertTriangle className="size-2.5" /> {t("forms.recipe.notInPantry")}
                        </>
                      ) : it.food ? (
                        <>
                          {m.kcal.toFixed(0)} kcal · P{m.p.toFixed(0)} F{m.f.toFixed(0)} C
                          {m.c.toFixed(0)}
                          {hasOverride && ` · ${t("forms.recipe.fixed")}`}
                        </>
                      ) : (
                        t("forms.recipe.pickAFood")
                      )}
                    </button>
                  </div>
                  <div className="w-20">
                    <UnitInput
                      suffix="g"
                      value={it.grams ?? ""}
                      disabled={disabled}
                      placeholder="g"
                      step="any"
                      onChange={(n) => patchItem(i, { grams: n })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    disabled={disabled}
                    className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                    aria-label={t("forms.recipe.removeIngredient")}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>

                {/* Per-portion macro override — the escape hatch for a food that
                    isn't in the pantry (or a one-off value). Absolute for this
                    portion; clearing it falls back to live pantry resolution. */}
                {showMacros && (
                  <div className="rounded-md border border-edge bg-background/40 p-2 shadow-well">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                        {t("forms.recipe.macrosForPortion")}
                      </span>
                      {hasOverride && (
                        <button
                          type="button"
                          onClick={() => clearOverride(i)}
                          disabled={disabled}
                          className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-60"
                        >
                          {t("forms.recipe.clear")}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {MACRO_FIELDS.map((fld) => (
                        <div key={fld.key} className="space-y-0.5">
                          <div className="text-center text-[9px] text-muted-foreground uppercase">
                            {t(fld.labelKey)}
                          </div>
                          <UnitInput
                            suffix={fld.suffix}
                            value={it[fld.key] ?? ""}
                            disabled={disabled}
                            placeholder={
                              known && !hasOverride ? Math.round(m[fld.key]).toString() : "0"
                            }
                            step="any"
                            min={0}
                            onChange={(n) => patchItem(i, { [fld.key]: n })}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {t("forms.recipe.absoluteForPortion")}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={addItem}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
          >
            <Plus className="size-3.5" />
            {t("forms.recipe.addIngredient")}
          </button>
        </div>
      </section>

      {/* ── Macros at the bottom: per-serving bars vs today's target ─ */}
      <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium">
            {t("forms.recipe.perServing")}
            {servings > 1 && <span className="ms-1 text-muted-foreground">(÷{servings})</span>}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {t("forms.recipe.wholeRecipe", { kcal: totals.kcal.toFixed(0) })}
          </span>
        </div>
        <MacroBars eaten={{ kcal: per.kcal, p: per.p, f: per.f, c: per.c }} target={dayTarget} />
        {targetPct != null && servingsToTarget != null && (
          <p className="text-xs text-muted-foreground">
            {t("forms.recipe.servingOfTarget", {
              pct: targetPct,
              kcal: Math.round(dayTarget!.kcal),
              servings: servingsToTarget.toFixed(1),
            })}
          </p>
        )}
      </div>
    </div>
  );
}

// ── update_recipe_portion ──────────────────────────────────────────────────
// Surgical one-ingredient edit, the recipe twin of update_diet_portion: target
// an existing row by its opaque portion_id (from get_recipe, shown read-only)
// and change the food / grams / macro override. Reuses the exact same portion
// primitives so it reads like the diet-portion gate. `edits` batches several in
// one call (BatchRepeater); the handler keys each edit by portion_id alone.
type UpdateRecipePortion = Portion & {
  recipe_id?: number;
  portion_id?: number;
  clear_override?: boolean;
};

// Read-only identity line for the surgical edit: recipe + the ingredient row
// being changed, each as its human name with the opaque id kept as a muted
// suffix (so it still lines up with get_recipe). Names come from the fetched
// recipe; until it loads (or if it can't resolve) we fall back to the id alone.
function PortionContext({
  recipeName,
  recipeId,
  ingredientFood,
  portionId,
}: {
  recipeName?: string;
  recipeId?: number;
  ingredientFood?: string;
  portionId?: number;
}) {
  const { t } = useTranslation();
  const parts = [
    { label: t("forms.recipe.recipeLabel"), name: recipeName, id: recipeId },
    {
      label: t("forms.recipe.ingredientLabel"),
      name: ingredientFood ? humanizeFoodName(ingredientFood) : undefined,
      id: portionId,
    },
  ].filter((p) => p.name != null || p.id != null);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-edge bg-background/40 px-3 py-2 text-[11px] text-muted-foreground shadow-well">
      {parts.map((p, i) => (
        <span key={p.label} className="inline-flex items-center gap-1">
          {i > 0 && <span className="opacity-50">·</span>}
          {p.label}
          {p.name && <span className="font-medium text-foreground">{p.name}</span>}
          {p.id != null && <span className="font-mono tabular-nums opacity-60">#{p.id}</span>}
        </span>
      ))}
    </div>
  );
}

export function UpdateRecipePortionForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const { db, foodNames } = useFoodDb();

  // Resolve names for the opaque ids the model targets: fetch the recipe once
  // (gated on recipe_id) and index its ingredients by portion id, so each edit
  // row can show "White rice, cooked #138" instead of a bare number.
  const top = (value as { recipe_id?: number; edits?: Array<{ recipe_id?: number }> }) ?? {};
  const recipeId = top.recipe_id ?? top.edits?.find((e) => e?.recipe_id != null)?.recipe_id;
  const { data } = useGetRecipesId(recipeId);
  const recipe = data?.recipe;
  const foodByPortionId = useMemo(() => {
    const m = new Map<number, string>();
    for (const ing of recipe?.ingredients ?? []) m.set(ing.id, ing.food);
    return m;
  }, [recipe]);

  return (
    <BatchRepeater<UpdateRecipePortion>
      value={value}
      onChange={onChange}
      disabled={disabled}
      Icon={Pencil}
      title={t("forms.recipe.editIngredient")}
      renderItem={(v, set) => (
        <>
          <PortionContext
            recipeName={recipe?.name}
            recipeId={v.recipe_id ?? recipeId}
            ingredientFood={v.portion_id != null ? foodByPortionId.get(v.portion_id) : undefined}
            portionId={v.portion_id}
          />
          <PortionFields v={v} set={set} db={db} foodNames={foodNames} disabled={disabled} />
          {!v.clear_override && <OverrideMacros v={v} set={set} disabled={disabled} />}
          <FlagToggle
            active={!!v.clear_override}
            label={
              v.clear_override ? t("forms.recipe.willResolveLive") : t("forms.recipe.dropOverride")
            }
            disabled={disabled}
            onToggle={() =>
              set({
                clear_override: !v.clear_override,
                kcal: undefined,
                p: undefined,
                f: undefined,
                c: undefined,
                fiber: undefined,
              })
            }
          />
        </>
      )}
    />
  );
}

// ── set_recipe_favorite ─────────────────────────────────────────────────────
// Star / unstar toggle. There's nothing to edit — the gate IS the confirmation
// — so the card just restates which recipe is being (un)favourited: its name
// (fetched by recipe_id, falling back to the model-supplied name) + the opaque
// id. Read-only; the parent's Save button commits.
export function SetRecipeFavoriteForm({ value }: ToolOverrideProps) {
  const { t } = useTranslation();
  const v = (value as { recipe_id?: number; name?: string; favorite?: boolean }) ?? {};
  const favorite = v.favorite !== false; // tool defaults to true
  const { data } = useGetRecipesId(v.recipe_id as number, {
    query: { enabled: v.recipe_id != null },
  });
  const name = data?.recipe?.name ?? v.name ?? t("forms.recipe.thisRecipe");

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
        <Star className={cn("mt-0.5 size-5 shrink-0 text-amber-500", favorite && "fill-current")} />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            {favorite ? t("forms.recipe.addToFavorites") : t("forms.recipe.removeFromFavorites")}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {favorite ? t("forms.recipe.starRecipe") : t("forms.recipe.unstarRecipe")}
          </p>
        </div>
      </div>
      <dl className="divide-y overflow-hidden rounded-lg border border-edge bg-background/40 shadow-well">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("forms.recipe.recipeLabel")}
          </dt>
          <dd className="min-w-0 truncate text-sm font-medium">{name}</dd>
        </div>
        {v.recipe_id != null && (
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("forms.recipe.id")}
            </dt>
            <dd className="font-mono text-sm tabular-nums opacity-70">#{v.recipe_id}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
