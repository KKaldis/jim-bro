import { useRef, useState } from "react";
import { ChevronDown, Layers, Package, Plus, ShoppingCart, Trash2, X } from "lucide-react";
import { humanizeFoodName } from "@fa/shared";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Field, SectionLabel, TogglePills, UnitInput } from "./formKit";
import {
  BarcodeInput,
  CategorySelect,
  GramsPerServingInput,
  MacroFields,
  unitOptions,
  type FoodUnit,
  type Macros,
} from "./foodControls";
import type { ToolOverrideProps } from "./overrides";
import { toggleItemClass } from "../lib/navItem";

// Bespoke gate form for update_pantry. The tool's input keys items by name
// (`items: { chicken_breast: {…} }`) plus a merge/replace `mode` and a `remove`
// list. A keyed map is awful to edit directly, so this form keeps an internal
// array of rows (each with a stable local id so renaming doesn't reorder) and
// serializes back to the map shape on every change. Each item reuses the shared
// foodControls so it reads exactly like FoodForm / the import table.

type ItemFields = {
  quantity?: number;
  unit?: FoodUnit;
  grams_per_serving?: number | null;
  to_buy?: boolean;
  category?: string;
  barcode?: string | null;
  macros?: Macros | null;
};

type PantryInput = {
  items?: Record<string, ItemFields>;
  mode?: "merge" | "replace";
  remove?: string[];
};

type Row = { id: number; name: string; fields: ItemFields };

function macrosEmpty(m: Macros | null | undefined): boolean {
  if (!m) return true;
  return m.kcal == null && m.p == null && m.f == null && m.c == null && m.fiber == null;
}

// Drop empties so a merge only touches fields the user actually filled.
function cleanFields(fields: ItemFields): ItemFields {
  const out: ItemFields = {};
  if (fields.quantity != null) out.quantity = fields.quantity;
  if (fields.unit) out.unit = fields.unit;
  if (fields.grams_per_serving != null) out.grams_per_serving = fields.grams_per_serving;
  if (fields.to_buy) out.to_buy = true;
  if (fields.category) out.category = fields.category;
  if (fields.barcode) out.barcode = fields.barcode;
  if (!macrosEmpty(fields.macros)) out.macros = fields.macros ?? undefined;
  return out;
}

export function PantryForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const MODE_OPTIONS = [
    { value: "merge" as const, label: t("forms.pantry.merge"), Icon: Plus, tint: "text-chart-2" },
    {
      value: "replace" as const,
      label: t("forms.pantry.replaceAll"),
      Icon: Layers,
      tint: "text-warning",
    },
  ];
  const v = (value as PantryInput) ?? {};

  // Internal row state, seeded once from the proposed input. The keyed map is
  // the contract; rows are just an editing convenience.
  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(v.items ?? {}).map(([name, fields]) => ({
      id: nextId.current++,
      name,
      fields: fields ?? {},
    })),
  );
  const [removeList, setRemoveList] = useState<string[]>(v.remove ?? []);
  const [removeDraft, setRemoveDraft] = useState("");
  const [open, setOpen] = useState<Set<number>>(
    // Expand a lone item by default; collapse when several so the list stays scannable.
    () => new Set(rows.length === 1 ? [rows[0].id] : []),
  );

  const mode: "merge" | "replace" = v.mode ?? "merge";

  // Serialize rows + remove + mode back into the flat tool input.
  const emit = (nextRows: Row[], nextRemove: string[], nextMode: "merge" | "replace") => {
    const items: Record<string, ItemFields> = {};
    for (const r of nextRows) {
      const name = r.name.trim();
      if (!name) continue;
      items[name] = cleanFields(r.fields); // last write wins on duplicate names
    }
    const out: PantryInput = { mode: nextMode };
    if (Object.keys(items).length > 0) out.items = items;
    if (nextRemove.length > 0) out.remove = nextRemove;
    onChange(out);
  };

  const patchRow = (id: number, patch: Partial<ItemFields>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, fields: { ...r.fields, ...patch } } : r));
    setRows(next);
    emit(next, removeList, mode);
  };

  const renameRow = (id: number, name: string) => {
    const next = rows.map((r) => (r.id === id ? { ...r, name } : r));
    setRows(next);
    emit(next, removeList, mode);
  };

  const addRow = () => {
    const id = nextId.current++;
    const next = [...rows, { id, name: "", fields: { unit: "g" as FoodUnit } }];
    setRows(next);
    setOpen((s) => new Set(s).add(id));
    emit(next, removeList, mode);
  };

  const deleteRow = (id: number) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next, removeList, mode);
  };

  const toggleOpen = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const addRemove = () => {
    const name = removeDraft.trim();
    if (!name || removeList.includes(name)) {
      setRemoveDraft("");
      return;
    }
    const next = [...removeList, name];
    setRemoveList(next);
    setRemoveDraft("");
    emit(rows, next, mode);
  };

  const dropRemove = (name: string) => {
    const next = removeList.filter((n) => n !== name);
    setRemoveList(next);
    emit(rows, next, mode);
  };

  return (
    <div className="space-y-6">
      {/* ── Mode ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Layers} info={t("forms.pantry.writeModeInfo")}>
          {t("forms.pantry.writeMode")}
        </SectionLabel>
        <TogglePills
          options={MODE_OPTIONS}
          value={mode}
          disabled={disabled}
          onChange={(m) => emit(rows, removeList, m)}
        />
        {mode === "replace" && (
          <p className="text-[11px] text-warning">{t("forms.pantry.replaceWarning")}</p>
        )}
      </section>

      {/* ── Items ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Package} hint={t("forms.pantry.items", { count: rows.length })}>
          {t("forms.pantry.itemsTitle")}
        </SectionLabel>
        <div className="space-y-2">
          {rows.map((r) => {
            const isOpen = open.has(r.id);
            const unit: FoodUnit = r.fields.unit ?? "g";
            const kcal = r.fields.macros?.kcal;
            return (
              <div
                key={r.id}
                className="rounded-lg border border-edge bg-background/40 shadow-well"
              >
                <div className="flex items-center gap-1.5 p-1.5">
                  <button
                    type="button"
                    onClick={() => toggleOpen(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-60"
                    aria-label={isOpen ? t("forms.pantry.collapse") : t("forms.pantry.expand")}
                  >
                    <ChevronDown
                      className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                    />
                  </button>
                  <Input
                    value={r.name}
                    disabled={disabled}
                    placeholder={t("forms.pantry.namePlaceholder")}
                    onChange={(e) => renameRow(r.id, e.target.value)}
                    className="h-8 flex-1 font-mono text-[13px]"
                  />
                  {!isOpen && (
                    <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                      {kcal != null ? `${kcal} kcal` : "—"}
                      {r.fields.quantity != null ? ` · ${r.fields.quantity}${unit}` : ""}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteRow(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                    aria-label={t("forms.pantry.removeItem")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {isOpen && (
                  <div className="space-y-4 border-t p-3">
                    <Field label={t("forms.pantry.onHand")} optional>
                      <UnitInput
                        icon={<Package className="size-3.5" />}
                        suffix={unit}
                        value={r.fields.quantity ?? ""}
                        disabled={disabled}
                        placeholder="0"
                        step="any"
                        onChange={(n) => patchRow(r.id, { quantity: n })}
                      />
                    </Field>

                    <Field label={t("forms.pantry.unit")}>
                      <TogglePills<FoodUnit>
                        options={unitOptions()}
                        value={unit}
                        disabled={disabled}
                        onChange={(u) => patchRow(r.id, { unit: u })}
                      />
                    </Field>

                    {unit === "pcs" && (
                      <Field
                        label={t("forms.pantry.gramsPerPiece")}
                        info={t("forms.pantry.gramsPerPieceInfo")}
                      >
                        <GramsPerServingInput
                          value={r.fields.grams_per_serving}
                          disabled={disabled}
                          onChange={(n) => patchRow(r.id, { grams_per_serving: n })}
                        />
                      </Field>
                    )}

                    <MacroFields
                      value={r.fields.macros ?? {}}
                      disabled={disabled}
                      per={t("forms.food.per", { unit: unit === "pcs" ? "g" : unit })}
                      onChange={(macros) =>
                        patchRow(r.id, { macros: macrosEmpty(macros) ? null : macros })
                      }
                    />

                    <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                      <Field label={t("forms.pantry.category")} optional>
                        <CategorySelect
                          value={r.fields.category}
                          disabled={disabled}
                          onChange={(c) => patchRow(r.id, { category: c })}
                        />
                      </Field>
                      <Field label={t("forms.pantry.shoppingList")}>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => patchRow(r.id, { to_buy: !r.fields.to_buy })}
                          aria-pressed={!!r.fields.to_buy}
                          className={cn(
                            "flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors",
                            "disabled:cursor-not-allowed disabled:opacity-60",
                            toggleItemClass(!!r.fields.to_buy),
                          )}
                        >
                          <ShoppingCart
                            className={cn("size-4", r.fields.to_buy && "text-primary")}
                          />
                          {r.fields.to_buy ? t("forms.pantry.toBuy") : t("forms.pantry.stocked")}
                        </button>
                      </Field>
                    </div>

                    <Field label={t("forms.pantry.barcode")} optional>
                      <BarcodeInput
                        value={r.fields.barcode}
                        disabled={disabled}
                        onChange={(b) => patchRow(r.id, { barcode: b })}
                      />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={addRow}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
          >
            <Plus className="size-4" />
            {t("forms.pantry.addItem")}
          </button>
        </div>
      </section>

      {/* ── Remove ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Trash2} hint={t("forms.pantry.optional")}>
          {t("forms.pantry.removeFromPantry")}
        </SectionLabel>
        {removeList.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {removeList.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-md border bg-background/60 py-1 ps-2 pe-1 text-xs"
              >
                <span className="font-mono">{humanizeFoodName(name)}</span>
                <button
                  type="button"
                  onClick={() => dropRemove(name)}
                  disabled={disabled}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-60"
                  aria-label={t("forms.pantry.keep", { name })}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <Input
          value={removeDraft}
          disabled={disabled}
          placeholder={t("forms.pantry.nameToDelete")}
          onChange={(e) => setRemoveDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRemove();
            }
          }}
          className="h-9 font-mono text-[13px]"
        />
      </section>
    </div>
  );
}
