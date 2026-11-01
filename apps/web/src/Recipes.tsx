/**
 * Recipes tab on the Nutrition screen: the user's saved, reusable ingredient
 * bundles ("chicken rice bowl" = 180g chicken + 150g rice + …), with macros
 * LIVE-resolved from the pantry by the server (GET /recipes, /recipes/:id).
 *
 * Layout mirrors the Pantry tab: a search box + sort control over a single
 * "Your recipes" card of rows. Tapping a row opens a styled view modal (macro
 * bars vs the day's target, ingredient breakdown, instructions); a bespoke
 * editor dialog (RecipeForm) handles create/replace, and a one-tap "Log it"
 * freezes the recipe into today's meal log. Reads go over REST (generated
 * hooks); writes reuse the agent's mutating tools via POST /tools/run
 * (save_recipe / log_recipe / delete_recipe), same as Pantry.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ExternalLink,
  FileDown,
  Pencil,
  Plus,
  Search,
  Star,
  ChefHat,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { getRecipesId, useGetRecipes, useGetRecipesId } from "./api/endpoints/default/default";
import { humanizeFoodName, type Macros, type ResolvedRecipe } from "@fa/shared";
import { apiErr } from "./lib/apiErr";
import { runTool, runToolJson } from "./lib/runTool";
import { useDailyTarget } from "./lib/dailyTarget";
import { MacroBars } from "./Dashboard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button, buttonVariants } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { SearchInput } from "./components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Skeleton } from "./components/ui/skeleton";
import { RowActions } from "./components/RowActions";
import { ExportPdfMenuItem, runExport } from "./export/printDoc";
import { exportRecipePdf } from "./export/recipePdf";
import { RecipeForm, type RecipeInput } from "./forms/RecipeForm";
import { LogRecipeForm } from "./forms/LogRecipeForm";
import type { JsonSchema } from "./forms/ToolForm";
import { PageTitle } from "./lib/pageChrome";
import { useMinLoading } from "./lib/useMinLoading";
import { cn } from "./lib/utils";

type RecipeSummary = {
  id: number;
  name: string;
  slug: string;
  servings: number;
  favorite: boolean;
  ingredient_count: number;
  kcal_per_serving: number;
  unresolved: number;
};

type RecipeResp = { recipe: ResolvedRecipe | null };

type TFunc = ReturnType<typeof useTranslation>["t"];

function macroLine(t: TFunc, m: Macros): string {
  const args = {
    kcal: Math.round(m.kcal),
    p: Math.round(m.p),
    f: Math.round(m.f),
    c: Math.round(m.c),
    fiber: m.fiber != null ? Math.round(m.fiber) : 0,
  };
  return m.fiber != null ? t("recipes.macroLineFiber", args) : t("recipes.macroLine", args);
}

type RecipeSort = "name" | "kcal" | "ingredients" | "servings";
const SORT_KEYS: RecipeSort[] = ["name", "kcal", "ingredients", "servings"];

export function RecipesSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  // Pantry-style controls: free-text search + a sort field with an asc/desc
  // toggle. Recipes carry no type/category, so those pantry filters drop out —
  // search + sort is the "obvious adjustment".
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<RecipeSort>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");

  const recipesQ = useGetRecipes();
  const recipes = useMemo(() => (recipesQ.data?.recipes ?? []) as RecipeSummary[], [recipesQ.data]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? recipes.filter((r) => r.name.toLowerCase().includes(q)) : recipes;
    const dir = order === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // Favourites always float to the top, regardless of the chosen sort.
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      switch (sort) {
        case "kcal":
          return (a.kcal_per_serving - b.kcal_per_serving) * dir || a.name.localeCompare(b.name);
        case "ingredients":
          return (a.ingredient_count - b.ingredient_count) * dir || a.name.localeCompare(b.name);
        case "servings":
          return (a.servings - b.servings) * dir || a.name.localeCompare(b.name);
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
  }, [recipes, search, sort, order]);

  const err = recipesQ.error ? apiErr(recipesQ.error) : null;
  const showLoader = useMinLoading(recipesQ.isPending);
  const invalidate = () => void queryClient.invalidateQueries();

  return (
    <div className="space-y-4">
      <PageTitle Icon={BookOpen} help="recipes">
        {t("recipes.title")}
      </PageTitle>

      <Button className="w-full gap-1" onClick={() => setCreating(true)}>
        <Plus className="size-4" /> {t("recipes.newRecipe")}
      </Button>

      {/* Pantry-style search + sort controls. */}
      <div className="space-y-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t("recipes.searchPlaceholder")}
          aria-label={t("recipes.searchAria")}
        />
        <div className="flex">
          <Select value={sort} onValueChange={(v) => setSort(v as RecipeSort)}>
            <SelectTrigger
              className="flex-1 rounded-e-none focus:z-10"
              aria-label={t("recipes.sortBy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_KEYS.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`recipes.sortLabels.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 rounded-s-none border-s-0 focus-visible:z-10"
            onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
            aria-label={order === "asc" ? t("recipes.sortAsc") : t("recipes.sortDesc")}
            title={order === "asc" ? t("recipes.ascending") : t("recipes.descending")}
          >
            {order === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
          </Button>
        </div>
      </div>

      {showLoader && <Skeleton className="h-40 w-full" />}
      {err && <p className="text-sm text-destructive">{err}</p>}

      {!showLoader && recipesQ.data && (
        <Card>
          <CardHeader>
            <CardTitle>
              {t("recipes.yourRecipes")}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {t("recipes.savedCount", { count: recipes.length })}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recipes.length === 0 ? (
              <EmptyState icon={ChefHat}>{t("recipes.empty")}</EmptyState>
            ) : visible.length === 0 ? (
              <EmptyState icon={Search}>{t("recipes.noMatch")}</EmptyState>
            ) : (
              <ul className="-my-1 divide-y">
                {visible.map((r) => (
                  <RecipeRow key={r.id} summary={r} onChanged={invalidate} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {creating && (
        <RecipeEditorDialog
          recipe={null}
          recipeId={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

// One recipe as a tappable list row (pantry-row rhythm). Tapping the row opens
// the read view modal; the row keeps quick Log + edit/delete affordances. The
// full resolved tree is fetched only while a modal that needs it is open.
function RecipeRow({ summary, onChanged }: { summary: RecipeSummary; onChanged: () => void }) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const recipeQ = useGetRecipesId(summary.id, { query: { enabled: viewing || editing } });
  const data = (recipeQ.data as unknown as RecipeResp | undefined) ?? null;
  const recipe = data?.recipe ?? null;

  const del = async () => {
    setBusy(true);
    setErr(null);
    const error = await runTool("delete_recipe", { recipe_id: summary.id });
    setBusy(false);
    if (error) {
      setErr(error);
      return;
    }
    setConfirmDelete(false);
    onChanged();
  };

  // The row only has the summary; fetch the resolved tree unless a modal
  // already loaded it.
  const exportPdf = async () => {
    const tree = recipe ?? ((await getRecipesId(summary.id)) as unknown as RecipeResp).recipe;
    if (tree) await exportRecipePdf(tree);
  };

  const toggleFavorite = async () => {
    setErr(null);
    const error = await runTool("set_recipe_favorite", {
      recipe_id: summary.id,
      favorite: !summary.favorite,
    });
    if (error) {
      setErr(error);
      return;
    }
    onChanged();
  };

  return (
    <li className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-start"
          onClick={() => setViewing(true)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{summary.name}</span>
            <span className="block text-xs text-muted-foreground tabular-nums">
              {t("recipes.kcalPerServing", { kcal: Math.round(summary.kcal_per_serving) })}{" "}
              {t("recipes.ingredientCount", { count: summary.ingredient_count })}
              {summary.servings > 1
                ? ` ${t("recipes.servingsSuffix", { count: summary.servings })}`
                : ""}
              {summary.unresolved > 0 && (
                <span className="ms-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3" />{" "}
                  {t("recipes.needMacros", { count: summary.unresolved })}
                </span>
              )}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void toggleFavorite()}
            aria-pressed={summary.favorite}
            title={summary.favorite ? t("recipes.removeFavorite") : t("recipes.markFavorite")}
            className={cn(
              "flex size-7 items-center justify-center rounded-md transition-colors",
              summary.favorite
                ? "text-amber-500 hover:bg-amber-400/10"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Star className={cn("size-4", summary.favorite && "fill-current")} />
          </button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setLogging(true)}
          >
            <Check className="size-3.5" /> {t("recipes.log")}
          </Button>
          <RowActions
            onEdit={() => setEditing(true)}
            onDelete={() => setConfirmDelete(true)}
            editLabel={t("recipes.editRecipe")}
            deleteLabel={t("recipes.deleteRecipe")}
            ariaLabel={t("recipes.rowActions", { name: summary.name })}
            middle={<ExportPdfMenuItem onSelect={() => void runExport(exportPdf)} />}
          />
        </div>
      </div>
      {err && <p className="mt-1 text-sm text-destructive">{err}</p>}

      {viewing && (
        <RecipeViewDialog
          summary={summary}
          recipe={recipe}
          loading={recipeQ.isPending}
          onClose={() => setViewing(false)}
          onEdit={() => {
            setViewing(false);
            setEditing(true);
          }}
          onLog={() => {
            setViewing(false);
            setLogging(true);
          }}
        />
      )}
      {editing &&
        (recipeQ.isPending ? (
          <Dialog open onOpenChange={(o) => !o && setEditing(false)}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t("recipes.editRecipeTitle")}</DialogTitle>
              </DialogHeader>
              <Skeleton className="h-40 w-full" />
            </DialogContent>
          </Dialog>
        ) : (
          <RecipeEditorDialog
            recipe={recipe}
            recipeId={summary.id}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ))}
      {logging && (
        <LogRecipeDialog
          name={summary.name}
          recipeId={summary.id}
          blocked={recipe?.unresolved ?? summary.unresolved}
          onClose={() => setLogging(false)}
          onLogged={() => {
            setLogging(false);
            onChanged();
          }}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("recipes.deleteTitle", { name: summary.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("recipes.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(ev) => {
                ev.preventDefault();
                void del();
              }}
              disabled={busy}
              className={buttonVariants({ variant: "destructive" })}
            >
              {busy ? t("recipes.deleting") : t("recipes.deleteRecipe")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

// ---------- view (read-only modal) ----------

function RecipeViewDialog({
  summary,
  recipe,
  loading,
  onClose,
  onEdit,
  onLog,
}: {
  summary: RecipeSummary;
  recipe: ResolvedRecipe | null;
  loading: boolean;
  onClose: () => void;
  onEdit: () => void;
  onLog: () => void;
}) {
  const { t } = useTranslation();
  const dayTarget = useDailyTarget();
  const per = recipe?.per_serving ?? null;
  const servingsToTarget = dayTarget && per && per.kcal > 0 ? dayTarget.kcal / per.kcal : null;
  const targetPct =
    dayTarget && per && dayTarget.kcal > 0 ? Math.round((per.kcal / dayTarget.kcal) * 100) : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="modal-cap flex max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="truncate">{summary.name}</DialogTitle>
          <DialogDescription>
            {t("recipes.servingsCount", { count: summary.servings })} ·{" "}
            {t("recipes.ingredientsCount", { count: summary.ingredient_count })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {loading || !recipe ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <>
              {/* Macro bars: a serving vs today's target. */}
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">
                    {t("recipes.perServing")}
                    {recipe.servings > 1 && (
                      <span className="ms-1 text-muted-foreground">
                        {t("recipes.perServingDiv", { servings: recipe.servings })}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t("recipes.wholeRecipe", { kcal: Math.round(recipe.totals.kcal) })}
                  </span>
                </div>
                <MacroBars
                  eaten={{
                    kcal: recipe.per_serving.kcal,
                    p: recipe.per_serving.p,
                    f: recipe.per_serving.f,
                    c: recipe.per_serving.c,
                  }}
                  target={dayTarget}
                />
                {targetPct != null && servingsToTarget != null && (
                  <p className="text-xs text-muted-foreground">
                    {t("recipes.servingPctOfDay", {
                      pct: targetPct,
                      kcal: Math.round(dayTarget!.kcal),
                      count: servingsToTarget.toFixed(1),
                    })}
                  </p>
                )}
              </div>

              {/* Ingredients */}
              <section className="space-y-1.5">
                <h3 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t("recipes.ingredients")}
                </h3>
                <ul className="divide-y rounded-md border">
                  {recipe.ingredients.map((it) => (
                    <li
                      key={it.id}
                      className="flex items-baseline justify-between gap-2 px-2.5 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {humanizeFoodName(it.food)}
                        {it.resolved == null && (
                          <span
                            className="ms-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
                            title={t("recipes.notInPantryTitle")}
                          >
                            <AlertTriangle className="size-3" /> {t("recipes.needsMacros")}
                          </span>
                        )}
                        {it.override && (
                          <span
                            className="ms-1.5 text-[10px] tracking-wide text-muted-foreground uppercase"
                            title={t("recipes.fixedTitle")}
                          >
                            {t("recipes.fixed")}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {Math.round(it.grams)}g
                        {it.resolved ? ` · ${Math.round(it.resolved.kcal)} kcal` : " · —"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {t("recipes.total", { macros: macroLine(t, recipe.totals) })}
                </p>
              </section>

              {/* Instructions — rendered as Markdown (same setup as chat). */}
              {recipe.instructions && (
                <section className="space-y-1">
                  <h3 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("recipes.instructions")}
                  </h3>
                  <div className="md text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{recipe.instructions}</ReactMarkdown>
                  </div>
                </section>
              )}

              {recipe.notes && (
                <p className="text-sm text-muted-foreground italic">{recipe.notes}</p>
              )}
              {recipe.source_url && (
                <a
                  href={recipe.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="size-3.5" /> {t("recipes.source")}
                </a>
              )}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t px-6 py-4 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" className="gap-1" onClick={onEdit} disabled={loading}>
              <Pencil className="size-4" /> {t("recipes.edit")}
            </Button>
            <Button
              variant="outline"
              className="gap-1"
              disabled={loading || !recipe}
              onClick={() => recipe && void runExport(() => exportRecipePdf(recipe))}
            >
              <FileDown className="size-4" /> {t("export.exportPdf")}
            </Button>
          </div>
          <Button className="gap-1" onClick={onLog} disabled={loading}>
            <Check className="size-4" /> {t("recipes.logIt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- editor ----------

// RecipeForm requires a JsonSchema prop (the ToolOverrideProps contract) but
// doesn't read it, so an empty object schema is fine for the manual surface.
const EMPTY_SCHEMA = { type: "object", properties: {} } as JsonSchema;

function recipeToDraft(recipe: ResolvedRecipe | null): RecipeInput {
  if (!recipe) return { name: "", servings: 1, ingredients: [{ food: "", grams: 100 }] };
  return {
    name: recipe.name,
    servings: recipe.servings,
    favorite: recipe.favorite,
    notes: recipe.notes ?? undefined,
    instructions: recipe.instructions ?? undefined,
    source_url: recipe.source_url ?? undefined,
    ingredients: recipe.ingredients.map((p) => ({
      food: p.food,
      grams: p.grams,
      // Carry an explicit override forward as flat macros (the manual form
      // leaves pantry foods to resolve live).
      ...(p.macros
        ? {
            kcal: p.macros.kcal,
            p: p.macros.p,
            f: p.macros.f,
            c: p.macros.c,
            fiber: p.macros.fiber,
          }
        : {}),
    })),
  };
}

function RecipeEditorDialog({
  recipe,
  recipeId,
  onClose,
  onSaved,
}: {
  recipe: ResolvedRecipe | null;
  // null = create a new recipe; a number = replace that recipe.
  recipeId: number | null;
  onClose: () => void;
  onSaved: (savedId: number | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RecipeInput>(() => recipeToDraft(recipe));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ingredients = (draft.ingredients ?? []).filter(
    (it) => (it.food ?? "").trim() && (it.grams ?? 0) > 0,
  );
  const canSave = (draft.name ?? "").trim().length > 0 && ingredients.length > 0;

  const save = async () => {
    setSaving(true);
    setErr(null);
    const input: Record<string, unknown> = {
      name: (draft.name ?? "").trim(),
      servings: draft.servings && draft.servings > 0 ? draft.servings : 1,
      favorite: !!draft.favorite,
      ingredients: ingredients.map((it) => ({
        food: (it.food ?? "").trim(),
        grams: it.grams,
        ...(it.kcal != null ? { kcal: it.kcal, p: it.p, f: it.f, c: it.c, fiber: it.fiber } : {}),
      })),
    };
    if (draft.notes?.trim()) input.notes = draft.notes.trim();
    if (draft.instructions?.trim()) input.instructions = draft.instructions.trim();
    if (draft.source_url?.trim()) input.source_url = draft.source_url.trim();
    if (recipeId != null) input.recipe_id = recipeId;

    const res = await runToolJson<{ recipe?: { id?: number } }>("save_recipe", input);
    setSaving(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    onSaved(res.data.recipe?.id ?? recipeId);
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="modal-cap flex max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>
            {recipeId == null ? t("recipes.newRecipeTitle") : t("recipes.editRecipeTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <RecipeForm
            schema={EMPTY_SCHEMA}
            value={draft}
            onChange={(next) => setDraft(next as RecipeInput)}
            disabled={saving}
          />
          {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || !canSave}>
            {saving ? t("common.saving") : t("recipes.saveRecipe")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- log ----------

// Manual "Log it" surface. Reuses the agent gate's bespoke log_recipe form
// (LogRecipeForm) — slot/time/date + scale quick-picks tuned to the recipe's
// servings + a live scaled-totals preview vs today's target — exactly the way
// RecipeEditorDialog reuses RecipeForm. Seeded with the chosen recipe's
// identity; the form fetches its macros, defaults the date to the viewed day,
// and shows its own unresolved-ingredients warning. We still hard-block the
// Save when the recipe has unresolved ingredients (the server would reject it
// with needs_enrichment anyway).
function LogRecipeDialog({
  name,
  recipeId,
  blocked,
  onClose,
  onLogged,
}: {
  name: string;
  recipeId: number;
  // # of ingredients that can't resolve macros — logging is blocked if > 0.
  blocked: number;
  onClose: () => void;
  onLogged: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Record<string, unknown>>({ recipe_id: recipeId, name });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const log = async () => {
    setBusy(true);
    setErr(null);
    const error = await runTool("log_recipe", draft);
    setBusy(false);
    if (error) {
      setErr(error);
      return;
    }
    onLogged();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="modal-cap flex max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{t("recipes.logTitle", { name })}</DialogTitle>
          <DialogDescription>{t("recipes.logDescription")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <LogRecipeForm
            schema={EMPTY_SCHEMA}
            value={draft}
            onChange={(next) => setDraft(next as Record<string, unknown>)}
            disabled={busy}
          />
          {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void log()} disabled={busy || blocked > 0}>
            {busy ? t("recipes.logging") : t("recipes.logIt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
