import { useState } from "react";
import { Barcode, Beef, Droplet, Flame, Hash, Leaf, ScanBarcode, Wheat } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FOOD_CATEGORIES, CATEGORY_ENUM_LABELS } from "@fa/shared";
import { CameraModal } from "@/components/CameraModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import i18n from "../i18n";
import { Field, UnitInput } from "./formKit";
import type { JsonSchema } from "./ToolForm";

// Shared food sub-controls, factored out of FoodForm so the pantry forms
// (update_pantry rows, import_pantry review table) render macros, category, and
// barcode with the exact same look + behaviour rather than re-implementing
// them. FoodForm carries macros as flat top-level keys; the pantry tools nest
// them under `macros{}` — both speak this `Macros` shape.

export type Macros = {
  kcal?: number;
  p?: number;
  f?: number;
  c?: number;
  fiber?: number | null;
};

export type FoodUnit = "g" | "ml" | "pcs";

// Localized unit options for the TogglePills. Value codes (g/ml/pcs) stay fixed;
// only the display labels are translated. A getter (not a const) so the labels
// follow the active language.
export function unitOptions(): { value: FoodUnit; label: string }[] {
  return [
    { value: "g", label: i18n.t("forms.foodControls.unitGrams") },
    { value: "ml", label: i18n.t("forms.foodControls.unitMillilitres") },
    { value: "pcs", label: i18n.t("forms.foodControls.unitPieces") },
  ];
}

// Atwater factors — a sanity cross-check of entered kcal against the macros.
export function atwater(p = 0, f = 0, c = 0): number {
  return 4 * p + 9 * f + 4 * c;
}

// Category options for the select: prefer the tool schema's enum (+ x-enumLabels)
// so labels match what the agent sees; fall back to the shared catalog when a
// page dialog drives a form without a schema.
export function categoryOptions(schema?: JsonSchema | null): { value: string; label: string }[] {
  const cat = schema?.properties?.category;
  if (!cat?.enum) {
    return FOOD_CATEGORIES.map((v, i) => ({
      value: v,
      label: CATEGORY_ENUM_LABELS[i] ?? v.replace(/_/g, " "),
    }));
  }
  const values = cat.enum.map(String);
  const labels = cat["x-enumLabels"];
  return values.map((v, i) => ({ value: v, label: labels?.[i] ?? v.replace(/_/g, " ") }));
}

// Calories, protein, fat, carbs and (optional) fiber in one row, with the live
// Atwater cross-check above it. Five columns are tight on a phone, so each
// column's label carries the macro's icon and the input is just the number (the
// unit is in the label). Operates on a whole `Macros` object and emits the next
// one, so callers can store it flat (FoodForm) or nested (pantry).
export function MacroFields({
  value,
  onChange,
  disabled,
  per,
}: {
  value: Macros;
  onChange: (next: Macros) => void;
  disabled?: boolean;
  // Unit hint shown above the row, e.g. "per 100 g".
  per?: string;
}) {
  const { t } = useTranslation();
  const m = value ?? {};
  const set = (patch: Partial<Macros>) => onChange({ ...m, ...patch });
  const estKcal = atwater(m.p, m.f, m.c);
  const kcalGap =
    m.kcal != null && estKcal > 0 ? Math.abs(m.kcal - estKcal) / Math.max(estKcal, 1) : 0;
  const kcalOff = kcalGap > 0.12 && m.kcal != null; // >12% drift from Atwater

  const cols: {
    key: keyof Macros;
    label: string;
    unit: string;
    Icon: typeof Flame;
    tint: string;
    optional?: boolean;
  }[] = [
    {
      key: "kcal",
      label: t("forms.foodControls.calories"),
      unit: "kcal",
      Icon: Flame,
      tint: "text-primary",
    },
    {
      key: "p",
      label: t("forms.foodControls.protein"),
      unit: "g",
      Icon: Beef,
      tint: "text-chart-2",
    },
    {
      key: "f",
      label: t("forms.foodControls.fat"),
      unit: "g",
      Icon: Droplet,
      tint: "text-chart-3",
    },
    {
      key: "c",
      label: t("forms.foodControls.carbs"),
      unit: "g",
      Icon: Wheat,
      tint: "text-chart-1",
    },
    {
      key: "fiber",
      label: t("forms.foodControls.fiber"),
      unit: "g",
      Icon: Leaf,
      tint: "text-chart-5",
      optional: true,
    },
  ];

  return (
    <div className="space-y-1.5">
      {(per || estKcal > 0) && (
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{per}</span>
          {estKcal > 0 && (
            <span className={cn("tabular-nums", kcalOff && "text-warning")}>
              ≈ {Math.round(estKcal)} kcal {t("forms.foodControls.fromMacros")}
            </span>
          )}
        </div>
      )}
      <div className="grid grid-cols-5 gap-1.5 *:min-w-0 [&_label]:min-w-0">
        {cols.map(({ key, label, unit, Icon, tint, optional }) => (
          <Field
            key={key}
            optional={optional}
            label={
              <span className="flex min-w-0 items-center gap-1" title={`${label} (${unit})`}>
                <Icon className={cn("size-3 shrink-0", tint)} />
                <span className="truncate">{key === "kcal" ? unit : label}</span>
              </span>
            }
          >
            <UnitInput
              value={m[key] ?? ""}
              disabled={disabled}
              placeholder={optional ? "—" : "0"}
              step="any"
              className="px-2 text-center tabular-nums"
              onChange={(n) => set({ [key]: key === "fiber" ? (n ?? null) : n })}
            />
          </Field>
        ))}
      </div>
    </div>
  );
}

// Category dropdown. `schema` is optional so page dialogs can drive it from the
// shared catalog.
export function CategorySelect({
  value,
  onChange,
  disabled,
  schema,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  disabled?: boolean;
  schema?: JsonSchema | null;
}) {
  const { t } = useTranslation();
  const cats = categoryOptions(schema);
  return (
    <Select value={value ?? ""} disabled={disabled} onValueChange={(v) => onChange(v || undefined)}>
      <SelectTrigger className="h-9 min-w-0">
        <SelectValue placeholder={t("forms.foodControls.choose")} />
      </SelectTrigger>
      <SelectContent>
        {cats.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Barcode input with a leading scanner glyph and a camera scan button that just
// fills the field. Emits null when cleared so the tool's "pass null to clear"
// contract is honoured.
export function BarcodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [scanOpen, setScanOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Barcode className="pointer-events-none absolute inset-s-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value ?? ""}
          disabled={disabled}
          inputMode="numeric"
          placeholder="0049000028911"
          onChange={(e) => onChange(e.target.value || null)}
          className="h-9 ps-8 font-mono text-[13px]"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 shrink-0"
        disabled={disabled}
        onClick={() => setScanOpen(true)}
        aria-label={t("nutrition.add.scanBarcode")}
        title={t("nutrition.add.scanBarcode")}
      >
        <ScanBarcode className="size-4" />
      </Button>
      {scanOpen && (
        <CameraModal
          scan
          onClose={() => setScanOpen(false)}
          onDetect={(code) => {
            setScanOpen(false);
            onChange(code);
          }}
        />
      )}
    </div>
  );
}

// Grams-per-piece input — only relevant for unit='pcs' so macros can convert.
export function GramsPerServingInput({
  value,
  onChange,
  disabled,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <UnitInput
      icon={<Hash className="size-3.5" />}
      suffix="g"
      value={value ?? ""}
      disabled={disabled}
      placeholder={t("forms.foodControls.gramsPerPiecePlaceholder")}
      step="any"
      onChange={(n) => onChange(n ?? null)}
    />
  );
}
