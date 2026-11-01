import { Loader2, Package, ScanBarcode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, UnitInput } from "./formKit";
import {
  CategorySelect,
  GramsPerServingInput,
  MacroFields,
  type FoodUnit,
  type Macros,
} from "./foodControls";

// Everything a pantry item is made of, as the add-manually form and the edit
// dialog hold it while the user types.
export type PantryItemDraft = {
  name: string;
  barcode: string;
  category?: string;
  unit: FoodUnit;
  quantity: number | "";
  gramsPerServing: number | null;
  macros: Macros;
};

export const emptyPantryItemDraft = (): PantryItemDraft => ({
  name: "",
  barcode: "",
  unit: "g",
  quantity: 0,
  gramsPerServing: null,
  macros: {},
});

// Shared field set for adding a pantry item by hand and for editing one, so
// both read the same: name, barcode (with an optional on-device scan), then
// category / unit / on hand in one row, the piece weight for `pcs`, and the
// per-100 macros.
export function PantryItemFields({
  value,
  onChange,
  disabled,
  autoFocusName,
  scan,
}: {
  value: PantryItemDraft;
  onChange: (patch: Partial<PantryItemDraft>) => void;
  disabled?: boolean;
  autoFocusName?: boolean;
  // Present when the host can scan a barcode (the add flow); omitted → plain input.
  scan?: { onScan: () => void; loading: boolean; error: string | null };
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <Field label={t("nutrition.pantry.name")} htmlFor="pantry-item-name">
        <Input
          id="pantry-item-name"
          autoFocus={autoFocusName}
          value={value.name}
          disabled={disabled}
          placeholder={t("nutrition.add.namePlaceholder")}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-9"
        />
      </Field>

      <Field label={t("forms.pantry.barcode")} htmlFor="pantry-item-barcode" optional>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <ScanBarcode className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="pantry-item-barcode"
              value={value.barcode}
              disabled={disabled}
              inputMode="numeric"
              placeholder={t("nutrition.add.barcodePlaceholder")}
              onChange={(e) => onChange({ barcode: e.target.value })}
              className="h-9 ps-8"
            />
          </div>
          {scan && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={disabled || scan.loading}
              onClick={scan.onScan}
            >
              {scan.loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ScanBarcode className="size-4" />
              )}
              {t("nutrition.add.scan")}
            </Button>
          )}
        </div>
        {scan?.error && <p className="text-xs text-muted-foreground">{scan.error}</p>}
      </Field>

      {/* min-w-0 on the cells so three selects fit a phone-width dialog. */}
      <div className="grid grid-cols-3 gap-2 *:min-w-0">
        <Field label={t("forms.pantry.category")} optional>
          <CategorySelect
            value={value.category}
            disabled={disabled}
            onChange={(category) => onChange({ category })}
          />
        </Field>
        <Field label={t("forms.pantry.unit")}>
          <Select
            value={value.unit}
            disabled={disabled}
            onValueChange={(v) => onChange({ unit: v as FoodUnit })}
          >
            <SelectTrigger className="h-9 min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="g">{t("nutrition.add.unitGrams")}</SelectItem>
              <SelectItem value="ml">{t("nutrition.add.unitMillilitres")}</SelectItem>
              <SelectItem value="pcs">{t("nutrition.add.unitPieces")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("forms.pantry.onHand")}>
          <UnitInput
            icon={<Package className="size-3.5" />}
            suffix={value.unit}
            value={value.quantity}
            disabled={disabled}
            placeholder="0"
            step="any"
            onChange={(n) => onChange({ quantity: n ?? "" })}
          />
        </Field>
      </div>

      {value.unit === "pcs" && (
        <Field label={t("forms.pantry.gramsPerPiece")} info={t("forms.pantry.gramsPerPieceInfo")}>
          <GramsPerServingInput
            value={value.gramsPerServing}
            disabled={disabled}
            onChange={(gramsPerServing) => onChange({ gramsPerServing })}
          />
        </Field>
      )}

      {/* Per-100 g/ml macros — the same control the agent's gate form uses. */}
      <MacroFields
        value={value.macros}
        disabled={disabled}
        per={t("forms.food.per", { unit: value.unit === "pcs" ? "g" : value.unit })}
        onChange={(macros) => onChange({ macros })}
      />
    </div>
  );
}

// The update_pantry fields for a draft: a complete per-100 macro set when any
// macro was entered (update_pantry replaces the block wholesale and ignores a
// patch without kcal), null to clear them; empty barcode/category → null.
export function pantryDraftFields(d: PantryItemDraft): Record<string, unknown> {
  const m = d.macros;
  const hasMacros = m.kcal != null || m.p != null || m.f != null || m.c != null || m.fiber != null;
  const fields: Record<string, unknown> = {
    quantity: d.quantity === "" ? 0 : d.quantity,
    unit: d.unit,
    category: d.category ?? null,
    barcode: d.barcode.trim() || null,
    macros: hasMacros
      ? {
          kcal: m.kcal ?? 0,
          p: m.p ?? 0,
          f: m.f ?? 0,
          c: m.c ?? 0,
          ...(m.fiber != null ? { fiber: m.fiber } : {}),
        }
      : null,
  };
  if (d.unit === "pcs") fields.grams_per_serving = d.gramsPerServing;
  return fields;
}
