import { useRef, useState } from "react";
import { ChevronDown, Download, Layers, Package, Plus, Sparkles, Trash2 } from "lucide-react";
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

// Bespoke gate form for import_pantry — the receipt/CSV/photo batch import. The
// gate IS the confirmation: the agent parses every line item, and this form
// shows the full parsed list as an editable, per-row-toggleable review table
// before anything is written. Macros are FLAT here (per-100 kcal/p/f/c/fiber on
// the item), unlike update_pantry's nested macros{}.

type ImportItem = {
  name?: string;
  quantity?: number;
  unit?: FoodUnit;
  barcode?: string | null;
  kcal?: number;
  p?: number;
  f?: number;
  c?: number;
  fiber?: number | null;
  category?: string;
  grams_per_serving?: number | null;
};

type ImportInput = {
  items?: ImportItem[];
  quantity_mode?: "add" | "set";
  lookup_barcodes?: boolean;
  source?: "receipt" | "csv" | "photo" | "text";
};

type Row = ImportItem & { id: number; enabled: boolean };

function macrosOf(r: Row): Macros {
  return { kcal: r.kcal, p: r.p, f: r.f, c: r.c, fiber: r.fiber };
}

export function ImportPantryForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const QTY_MODE_OPTIONS = [
    {
      value: "add" as const,
      label: t("forms.import.addToStock"),
      Icon: Plus,
      tint: "text-chart-2",
    },
    {
      value: "set" as const,
      label: t("forms.import.overwrite"),
      Icon: Layers,
      tint: "text-warning",
    },
  ];
  const SOURCE_LABELS: Record<NonNullable<ImportInput["source"]>, string> = {
    receipt: t("forms.import.sources.receipt"),
    csv: t("forms.import.sources.csv"),
    photo: t("forms.import.sources.photo"),
    text: t("forms.import.sources.text"),
  };
  const v = (value as ImportInput) ?? {};

  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    (v.items ?? []).map((it) => ({ id: nextId.current++, enabled: true, ...it })),
  );
  const [open, setOpen] = useState<Set<number>>(new Set());

  const quantityMode: "add" | "set" = v.quantity_mode ?? "add";
  const lookupBarcodes = v.lookup_barcodes ?? true;

  const emit = (
    nextRows: Row[],
    mode: "add" | "set" = quantityMode,
    lookup: boolean = lookupBarcodes,
  ) => {
    const items: ImportItem[] = nextRows
      .filter((r) => r.enabled && (r.name ?? "").trim())
      .map(({ id: _id, enabled: _enabled, ...item }) => {
        void _id;
        void _enabled;
        return { ...item, name: (item.name ?? "").trim() };
      });
    const out: ImportInput = { items, quantity_mode: mode, lookup_barcodes: lookup };
    if (v.source) out.source = v.source;
    onChange(out);
  };

  const patchRow = (id: number, patch: Partial<Row>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows(next);
    emit(next);
  };

  const deleteRow = (id: number) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next);
  };

  const addRow = () => {
    const id = nextId.current++;
    const next = [...rows, { id, enabled: true, unit: "g" as FoodUnit }];
    setRows(next);
    setOpen((s) => new Set(s).add(id));
    emit(next);
  };

  const toggleOpen = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const activeCount = rows.filter((r) => r.enabled && (r.name ?? "").trim()).length;

  return (
    <div className="space-y-6">
      {/* ── Import options ─────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel
          Icon={Download}
          info={t("forms.import.importInfo")}
          hint={
            v.source ? t("forms.import.fromSource", { source: SOURCE_LABELS[v.source] }) : undefined
          }
        >
          {t("forms.import.importTitle")}
        </SectionLabel>
        <TogglePills
          options={QTY_MODE_OPTIONS}
          value={quantityMode}
          disabled={disabled}
          onChange={(m) => emit(rows, m)}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => emit(rows, quantityMode, !lookupBarcodes)}
          aria-pressed={lookupBarcodes}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-60",
            toggleItemClass(lookupBarcodes),
          )}
        >
          <Sparkles className={cn("size-4 shrink-0", lookupBarcodes && "text-primary")} />
          <span className="flex-1">
            {t("forms.import.autoFetch")}
            <span className="block text-[11px] text-muted-foreground">
              {t("forms.import.autoFetchHint")}
            </span>
          </span>
        </button>
      </section>

      {/* ── Parsed items ───────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel
          Icon={Package}
          hint={t("forms.import.importing", { active: activeCount, total: rows.length })}
        >
          {t("forms.import.parsedItems")}
        </SectionLabel>
        <div className="space-y-2">
          {rows.map((r) => {
            const isOpen = open.has(r.id);
            const unit: FoodUnit = r.unit ?? "g";
            return (
              <div
                key={r.id}
                className={cn(
                  "rounded-lg border border-edge bg-background/40 shadow-well transition-opacity",
                  !r.enabled && "opacity-50",
                )}
              >
                <div className="flex items-center gap-1.5 p-1.5">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={disabled}
                    onChange={(e) => patchRow(r.id, { enabled: e.target.checked })}
                    className="ms-1 size-4 shrink-0 accent-primary"
                    aria-label={t("forms.import.includeInImport")}
                  />
                  <button
                    type="button"
                    onClick={() => toggleOpen(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-60"
                    aria-label={isOpen ? t("forms.import.collapse") : t("forms.import.expand")}
                  >
                    <ChevronDown
                      className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                    />
                  </button>
                  <Input
                    value={r.name ?? ""}
                    disabled={disabled || !r.enabled}
                    placeholder={t("forms.import.namePlaceholder")}
                    onChange={(e) => patchRow(r.id, { name: e.target.value })}
                    className="h-8 flex-1 font-mono text-[13px]"
                  />
                  {!isOpen && (
                    <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                      {r.quantity != null ? `${r.quantity}${unit}` : ""}
                      {r.kcal != null ? `${r.quantity != null ? " · " : ""}${r.kcal} kcal` : ""}
                      {r.barcode ? " · ▮" : ""}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteRow(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                    aria-label={t("forms.import.dropLine")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {isOpen && (
                  <div className="space-y-4 border-t p-3">
                    <Field label={t("forms.import.quantity")} optional>
                      <UnitInput
                        icon={<Package className="size-3.5" />}
                        suffix={unit}
                        value={r.quantity ?? ""}
                        disabled={disabled}
                        placeholder="0"
                        step="any"
                        onChange={(n) => patchRow(r.id, { quantity: n })}
                      />
                    </Field>

                    <Field label={t("forms.import.unit")}>
                      <TogglePills<FoodUnit>
                        options={unitOptions()}
                        value={unit}
                        disabled={disabled}
                        onChange={(u) => patchRow(r.id, { unit: u })}
                      />
                    </Field>

                    {unit === "pcs" && (
                      <Field label={t("forms.import.gramsPerPiece")}>
                        <GramsPerServingInput
                          value={r.grams_per_serving}
                          disabled={disabled}
                          onChange={(n) => patchRow(r.id, { grams_per_serving: n })}
                        />
                      </Field>
                    )}

                    <MacroFields
                      value={macrosOf(r)}
                      disabled={disabled}
                      per={t("forms.food.per", { unit: unit === "pcs" ? "g" : unit })}
                      onChange={(m) =>
                        patchRow(r.id, {
                          kcal: m.kcal,
                          p: m.p,
                          f: m.f,
                          c: m.c,
                          fiber: m.fiber,
                        })
                      }
                    />

                    <div className="grid grid-cols-2 gap-3">
                      <Field label={t("forms.import.category")} optional>
                        <CategorySelect
                          value={r.category}
                          disabled={disabled}
                          onChange={(cat) => patchRow(r.id, { category: cat })}
                        />
                      </Field>
                      <Field label={t("forms.import.barcode")} optional>
                        <BarcodeInput
                          value={r.barcode}
                          disabled={disabled}
                          onChange={(b) => patchRow(r.id, { barcode: b })}
                        />
                      </Field>
                    </div>
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
            {t("forms.import.addLine")}
          </button>
        </div>
      </section>
    </div>
  );
}
