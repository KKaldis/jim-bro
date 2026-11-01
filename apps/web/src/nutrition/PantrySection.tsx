// Nutrition → Pantry: the pantry table, its rows and the edit dialog.
import { EmptyState } from "@/components/EmptyState";
import { humanizeCategory, humanizeFoodName } from "@fa/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Package,
  Plus,
  Refrigerator,
  Search,
  ShoppingCart,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AddFoodDialog } from "../AddFoodDialog";
import { getPantry, useGetPantry } from "../api/endpoints/default/default";
import { CameraModal } from "../components/CameraModal";
import { RowActions } from "../components/RowActions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { SearchInput } from "../components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "../components/ui/table";
import {
  pantryDraftFields,
  type PantryItemDraft,
  PantryItemFields,
} from "../forms/PantryItemFields";
import { apiErr } from "../lib/apiErr";
import { PageTitle } from "../lib/pageChrome";
import { runTool } from "../lib/runTool";
import { type MacroView, type PantrySort, useUiStore } from "../lib/uiStore";
import { useMinLoading } from "../lib/useMinLoading";
import { cn } from "../lib/utils";
import type { Macros } from "./shared";

type ServingUnit = "g" | "ml" | "pcs";
type PantryItem = {
  name: string;
  quantity: number;
  unit: ServingUnit;
  to_buy: boolean;
  grams_per_serving?: number;
  category?: string;
  barcode?: string;
  macros?: { kcal: number; p: number; f: number; c: number; fiber?: number };
};
type PantryResp = {
  items: PantryItem[];
  total: number;
  categories: string[];
};

// MacroView (how the per-row macro line is shown: the item's per-100
// nutritional profile, or the macros for the whole on-hand quantity) and
// PantrySort are owned by the UI store, which persists the user's choice.

// Macros on a pantry item are stored per-100 (per 100 g, or per 100 ml for
// liquids). In `per100` view we surface them as-is; in `available` view we
// scale by the on-hand quantity, converting `pcs` counts to grams first.
// Returns null when the item carries no macros (e.g. a bare supplement).
function pantryMacros(item: PantryItem, view: MacroView): Macros | null {
  if (!item.macros) return null;
  if (view === "per100") return item.macros;
  const grams = item.unit === "pcs" ? item.quantity * (item.grams_per_serving ?? 0) : item.quantity;
  const f = grams / 100;
  return {
    kcal: item.macros.kcal * f,
    p: item.macros.p * f,
    f: item.macros.f * f,
    c: item.macros.c * f,
    ...(item.macros.fiber != null ? { fiber: item.macros.fiber * f } : {}),
  };
}

const PAGE_SIZE = 25;
const SORT_KEYS: PantrySort[] = ["name", "quantity", "kcal", "protein", "carbs", "fat"];

// UI mutations reuse the same agent tools via POST /tools/run (shared runTool,
// which also raises the CRUD toast). Pantry mutations go through update_pantry
// (merge to set a quantity, `remove` to delete).
function runPantryUpdate(input: Record<string, unknown>): Promise<string | null> {
  return runTool("update_pantry", input);
}

// Typed name → the snake_case key pantry items are stored under ("Greek
// yogurt" → "greek_yogurt"). Keeps any script's letters, so Greek names
// survive.
function pantryKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

export function PantrySection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<PantryItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PantryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [mutateErr, setMutateErr] = useState<string | null>(null);

  // Search / filter / sort / pagination state. These drive server-side query
  // params so the table stays fast as the pantry grows. `search` is debounced
  // into `q` to avoid a request per keystroke.
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  // Sort field/direction are persisted display preferences (UI store); search,
  // filters and page stay transient session state.
  const sort = useUiStore((s) => s.pantrySort);
  const setSort = useUiStore((s) => s.setPantrySort);
  const order = useUiStore((s) => s.pantryOrder);
  const setOrder = useUiStore((s) => s.setPantryOrder);
  const [page, setPage] = useState(0);
  // Per-100 vs whole-quantity macro display, toggled from the card header.
  // Persisted display preference (UI store).
  const macroView = useUiStore((s) => s.pantryMacroView);
  const setMacroView = useUiStore((s) => s.setPantryMacroView);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Any filter/sort/search change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [q, categoryFilter, sort, order]);

  const hasFilters = q !== "" || categoryFilter !== "all";

  // Server-side query: search/filter/sort/pagination params drive the request.
  // React Query keeps the previous page on screen during a refetch, so editing
  // a row or paging never flashes the list through the skeleton (FIXES #6).
  const pantryQ = useGetPantry({
    ...(q ? { q } : {}),
    ...(categoryFilter !== "all" ? { category: categoryFilter } : {}),
    sort,
    order,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const resp = pantryQ.data as unknown as PantryResp | undefined;
  const items = resp?.items ?? null;
  const total = resp?.total ?? 0;
  const categories = resp?.categories ?? [];
  const err = pantryQ.error ? apiErr(pantryQ.error) : null;
  const showLoader = useMinLoading(pantryQ.isPending);

  // After a mutation, invalidate so the active query refetches in the
  // background (no flash) and the total/pager stay accurate.
  const invalidate = () => void queryClient.invalidateQueries();

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setMutateErr(null);
    const error = await runPantryUpdate({ remove: [pendingDelete.name] });
    setDeleting(false);
    if (error) {
      setMutateErr(error);
      return;
    }
    setPendingDelete(null);
    // If this was the last row on a non-first page, step back a page (which
    // refetches via the changed param); otherwise just refetch in place.
    if (items && items.length === 1 && page > 0) {
      setPage((p) => p - 1);
    } else {
      invalidate();
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <PageTitle Icon={Refrigerator} help="pantry">
        {t("nutrition.pantry.title")}
      </PageTitle>
      <AddFoodDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        mode="pantry"
        dateIso=""
        onLogged={invalidate}
      />
      <Button onClick={() => setAddOpen(true)} className="w-full gap-1">
        <Plus className="size-4" /> {t("nutrition.pantry.addItem")}
      </Button>

      <div className="space-y-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t("nutrition.pantry.searchPlaceholder")}
          aria-label={t("nutrition.pantry.searchAria")}
        />
        {/* One row even on phones: two equal columns, the second holding the
            sort select plus its direction toggle. Triggers shrink (min-w-0)
            and truncate. */}
        <div className="grid grid-cols-2 gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger
              className="min-w-0 px-2.5 text-xs sm:text-sm"
              aria-label={t("nutrition.pantry.filterByCategory")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("nutrition.pantry.allCategories")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {humanizeCategory(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Sort field + direction read as one control: the select and the
              asc/desc toggle share a border (rounded only on the outer edges). */}
          <div className="flex min-w-0">
            <Select value={sort} onValueChange={(v) => setSort(v as PantrySort)}>
              <SelectTrigger
                className="min-w-0 rounded-e-none px-2.5 text-xs focus:z-10 sm:text-sm"
                aria-label={t("nutrition.pantry.sortBy")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_KEYS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`nutrition.pantry.sortLabels.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0 rounded-s-none border-s-0 focus-visible:z-10"
              onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
              aria-label={
                order === "asc" ? t("nutrition.pantry.sortAsc") : t("nutrition.pantry.sortDesc")
              }
              title={
                order === "asc" ? t("nutrition.pantry.ascending") : t("nutrition.pantry.descending")
              }
            >
              {order === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
            </Button>
          </div>
        </div>
      </div>

      {showLoader && (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {mutateErr && <p className="text-sm text-destructive">{mutateErr}</p>}
      {items && !showLoader && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>
                {t("nutrition.pantry.whatYouHave")}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  {t("nutrition.pantry.itemCount", { count: total })}
                </span>
              </CardTitle>
              {/* Toggle the per-row macro line between the item's per-100
                  profile and the macros for the whole on-hand quantity. */}
              <div className="flex shrink-0 rounded-md border text-xs soft:gap-1.5 soft:border-transparent">
                {(["per100", "available"] as MacroView[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMacroView(v)}
                    className={cn(
                      "px-2 py-1 font-medium transition-[color,background-color,box-shadow] first:rounded-s-md last:rounded-e-md soft:rounded-md",
                      macroView === v
                        ? "bg-primary/15 text-primary soft:bg-background soft:shadow-pressed"
                        : "text-muted-foreground hover:text-foreground soft:shadow-control soft:hover:text-primary",
                    )}
                    aria-pressed={macroView === v}
                  >
                    {v === "per100"
                      ? t("nutrition.pantry.per100")
                      : t("nutrition.pantry.available")}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <EmptyState icon={hasFilters ? Search : Package}>
                {hasFilters ? t("nutrition.pantry.noMatch") : t("nutrition.pantry.empty")}
              </EmptyState>
            ) : (
              <>
                <Table>
                  <TableBody>
                    {items.map((it) => (
                      <PantryRow
                        key={it.name}
                        item={it}
                        macroView={macroView}
                        onSaved={invalidate}
                        onRequestEdit={() => {
                          setMutateErr(null);
                          setEditing(it);
                        }}
                        onRequestDelete={() => {
                          setMutateErr(null);
                          setPendingDelete(it);
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
                {total > PAGE_SIZE && (
                  <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                    <span className="tabular-nums">
                      {t("nutrition.pantry.range", {
                        start: rangeStart,
                        end: rangeEnd,
                        total,
                      })}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-8"
                        disabled={page === 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        aria-label={t("nutrition.pantry.prevPage")}
                      >
                        <ChevronLeft className="size-4" />
                      </Button>
                      <span className="tabular-nums">
                        {page + 1} / {pageCount}
                      </span>
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-8"
                        disabled={page + 1 >= pageCount}
                        onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                        aria-label={t("nutrition.pantry.nextPage")}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
      {editing && (
        <PantryEditDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingDelete(null);
            setMutateErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("nutrition.pantry.removeTitle", { name: pendingDelete?.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("nutrition.pantry.removeBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open until the request resolves so an error
                // can be surfaced inline; close manually on success.
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className={buttonVariants({ variant: "destructive" })}
            >
              {deleting ? t("nutrition.pantry.removing") : t("common.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// A single pantry row: the kebab menu opens the edit dialog (quantity + the
// item's per-100 macros) or removes the item, and the cart toggles the restock
// (to-buy) flag — that toggle merges straight through update_pantry.
function PantryRow({
  item,
  macroView,
  onSaved,
  onRequestEdit,
  onRequestDelete,
}: {
  item: PantryItem;
  macroView: MacroView;
  // Called after a successful to-buy toggle; the parent refetches the pantry.
  onSaved: () => void;
  onRequestEdit: () => void;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Macro line: per-100 profile or whole-quantity totals per the header toggle.
  const macros = pantryMacros(item, macroView);

  async function toggleToBuy() {
    setBusy(true);
    setErr(null);
    const next = !item.to_buy;
    const error = await runPantryUpdate({
      items: { [item.name]: { to_buy: next } },
      mode: "merge",
    });
    setBusy(false);
    if (error) {
      setErr(error);
      return;
    }
    onSaved();
  }

  return (
    <TableRow className="group soft:hover:bg-transparent">
      <TableCell className="text-sm">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 transition-colors soft:group-hover:text-primary">
            {humanizeFoodName(item.name)}
            {item.to_buy && (
              <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-600 uppercase dark:text-amber-400">
                {t("nutrition.pantry.toBuy")}
              </span>
            )}
          </span>
          {item.category && (
            <span className="text-xs text-muted-foreground">{humanizeCategory(item.category)}</span>
          )}
          {macros && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {macros.kcal.toFixed(0)} kcal · P {macros.p.toFixed(0)} · C {macros.c.toFixed(0)} · F{" "}
              {macros.f.toFixed(0)}
              {macros.fiber != null && ` · Fb ${macros.fiber.toFixed(0)}`}
              {macroView === "per100" && (
                <span className="ms-1 opacity-70">/100{item.unit === "ml" ? "ml" : "g"}</span>
              )}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-end gap-0.5">
          {err && <span className="text-xs text-destructive">{err}</span>}
          <div className="flex items-center gap-1">
            <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
              {item.quantity.toFixed(0)} {item.unit}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className={
                "size-8 " +
                (item.to_buy ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")
              }
              disabled={busy}
              onClick={() => void toggleToBuy()}
              aria-label={
                item.to_buy
                  ? t("nutrition.pantry.unmarkToBuy", { name: item.name })
                  : t("nutrition.pantry.markToBuy", { name: item.name })
              }
            >
              <ShoppingCart className="size-3.5" />
            </Button>
            <RowActions
              onEdit={onRequestEdit}
              onDelete={onRequestDelete}
              editLabel={t("nutrition.pantry.editItem")}
              deleteLabel={t("nutrition.pantry.removeItem")}
              ariaLabel={t("nutrition.pantry.rowActions", { name: item.name })}
            />
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

// Edit one pantry item with the same fields as adding one by hand (name,
// barcode, category / unit / on hand, piece weight, per-100 macros). Saving
// merges through update_pantry, so the to-buy flag is left untouched; a changed
// name moves the item to the new key.
function PantryEditDialog({
  item,
  onClose,
  onSaved,
}: {
  item: PantryItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PantryItemDraft>(() => ({
    name: humanizeFoodName(item.name),
    barcode: item.barcode ?? "",
    category: item.category,
    unit: item.unit,
    quantity: item.quantity,
    gramsPerServing: item.grams_per_serving ?? null,
    macros: item.macros ?? {},
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const patch = (p: Partial<PantryItemDraft>) => setDraft((d) => ({ ...d, ...p }));

  async function save() {
    // Pantry items are keyed by snake_case name; untouched text maps back to
    // the same key, so only a real edit counts as a rename.
    const key = pantryKey(draft.name);
    if (!key) {
      setErr(t("nutrition.pantry.nameRequired"));
      return;
    }
    if (draft.quantity === "" || !Number.isFinite(draft.quantity) || draft.quantity < 0) {
      setErr(t("nutrition.pantry.quantityInvalid"));
      return;
    }
    const fields = pantryDraftFields(draft);
    setSaving(true);
    setErr(null);
    let error: string | null;
    if (key !== item.name) {
      // update_pantry merges into an existing item of the same name, so refuse
      // a name that's already taken instead of silently folding two together.
      try {
        const found = await getPantry({ q: key, limit: 50 });
        if (found.items.some((it) => it.name === key)) {
          setSaving(false);
          setErr(t("nutrition.pantry.nameTaken"));
          return;
        }
      } catch (e) {
        setSaving(false);
        setErr(apiErr(e));
        return;
      }
      // A rename is a new key: write the whole item under it (keeping its
      // to-buy flag and, off `pcs`, its piece weight), then drop the old one —
      // upserts run before removals in the same call.
      error = await runPantryUpdate({
        items: {
          [key]: {
            ...fields,
            to_buy: item.to_buy,
            ...(draft.unit !== "pcs" && item.grams_per_serving != null
              ? { grams_per_serving: item.grams_per_serving }
              : {}),
          },
        },
        mode: "merge",
        remove: [item.name],
      });
    } else {
      error = await runPantryUpdate({ items: { [item.name]: fields }, mode: "merge" });
    }
    setSaving(false);
    if (error) {
      setErr(error);
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Scan only fills the barcode field — the rest of the item is the
          user's to edit, so nothing else is looked up or overwritten. */}
      {scanOpen && (
        <CameraModal
          scan
          onClose={() => setScanOpen(false)}
          onDetect={(code) => {
            setScanOpen(false);
            patch({ barcode: code });
          }}
        />
      )}
      <DialogContent
        className="modal-cap flex flex-col gap-3 sm:max-w-md"
        // The camera overlay portals outside the dialog; keep its clicks and
        // Escape from dismissing the edit.
        onInteractOutside={(e) => {
          if (scanOpen) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (scanOpen) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{draft.name.trim() || humanizeFoodName(item.name)}</DialogTitle>
          <DialogDescription>{t("nutrition.pantry.editDescription")}</DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <PantryItemFields
            value={draft}
            onChange={patch}
            disabled={saving}
            scan={{ onScan: () => setScanOpen(true), loading: false, error: null }}
          />
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
