import { Flame, Package, ShoppingCart, Tag } from "lucide-react";
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

// Bespoke gate form shared by add_food and update_food (mirrors how
// LogMealForm serves log_meal + update_meal). Same flat input contract the
// tools declare: name, per-100 macros (kcal/p/f/c/fiber), category, barcode,
// unit, grams_per_serving, and — for add_food only — quantity + to_buy.
//
// Macros / category / barcode / grams-per-piece are the shared foodControls,
// so this form and the pantry forms render them identically.
//
// add_food vs update_food is detected from the schema: only add_food carries a
// `quantity` field. update_food treats `name` as the identity key, so the name
// is shown read-only there (renaming would target a different pantry item).

type FoodInput = Macros & {
  name?: string;
  category?: string;
  barcode?: string | null;
  unit?: FoodUnit;
  grams_per_serving?: number | null;
  quantity?: number;
  to_buy?: boolean;
};

export function FoodForm({ schema, value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const f = (value as FoodInput) ?? {};
  const isAdd = "quantity" in (schema.properties ?? {});
  const unit: FoodUnit = f.unit ?? "g";
  const per = t("forms.food.per", { unit: unit === "pcs" ? "g" : unit });

  const set = (patch: Partial<FoodInput>) => onChange({ ...f, ...patch });

  return (
    <div className="space-y-6">
      {/* ── Identity ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Tag}>{t("forms.food.identity")}</SectionLabel>
        <Field label={t("forms.food.name")} info={t("forms.food.nameInfo")}>
          <Input
            value={f.name ?? ""}
            disabled={disabled || !isAdd}
            placeholder={t("forms.food.namePlaceholder")}
            onChange={(e) => set({ name: e.target.value || undefined })}
            className="h-9 font-mono text-[13px]"
          />
        </Field>
      </section>

      {/* ── Macros ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Flame} hint={per}>
          {t("forms.food.macros")}
        </SectionLabel>
        <MacroFields
          value={{ kcal: f.kcal, p: f.p, f: f.f, c: f.c, fiber: f.fiber }}
          disabled={disabled}
          onChange={(m) => set(m)}
        />
      </section>

      {/* ── Classification ─────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Package}>{t("forms.food.classification")}</SectionLabel>

        <Field label={t("forms.food.category")} optional>
          <CategorySelect
            schema={schema}
            value={f.category}
            disabled={disabled}
            onChange={(v) => set({ category: v })}
          />
        </Field>

        <Field label={t("forms.food.unit")} info={t("forms.food.unitInfo")}>
          <TogglePills<FoodUnit>
            options={unitOptions()}
            value={unit}
            disabled={disabled}
            onChange={(v) => set({ unit: v })}
          />
        </Field>

        {/* Serving weight. For pcs it's the per-piece weight needed to convert
            macros to a count; for g/ml it's the scoop/serving size, so the
            agent can answer "one serving" without asking. Shown for every unit
            now that lookup_product auto-fills it from the label serving size. */}
        <Field
          label={unit === "pcs" ? t("forms.food.gramsPerPiece") : t("forms.food.gramsPerServing")}
          optional={unit !== "pcs"}
          info={
            unit === "pcs" ? t("forms.food.gramsPerPieceInfo") : t("forms.food.gramsPerServingInfo")
          }
        >
          <GramsPerServingInput
            value={f.grams_per_serving}
            disabled={disabled}
            onChange={(n) => set({ grams_per_serving: n })}
          />
        </Field>

        <Field label={t("forms.food.barcode")} optional info={t("forms.food.barcodeInfo")}>
          <BarcodeInput
            value={f.barcode}
            disabled={disabled}
            onChange={(v) => set({ barcode: v })}
          />
        </Field>
      </section>

      {/* ── Stock (add_food only) ──────────────────────────────── */}
      {isAdd && (
        <section className="space-y-3">
          <SectionLabel Icon={ShoppingCart}>{t("forms.food.stock")}</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("forms.food.onHand")} optional>
              <UnitInput
                icon={<Package className="size-3.5" />}
                suffix={unit}
                value={f.quantity ?? ""}
                disabled={disabled}
                placeholder="0"
                step="any"
                onChange={(n) => set({ quantity: n })}
              />
            </Field>
            <Field label={t("forms.food.shoppingList")}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => set({ to_buy: !f.to_buy })}
                aria-pressed={!!f.to_buy}
                className={cn(
                  "flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border text-sm font-medium transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  toggleItemClass(!!f.to_buy),
                )}
              >
                <ShoppingCart className={cn("size-4", f.to_buy && "text-primary")} />
                {f.to_buy ? t("forms.food.toBuy") : t("forms.food.notListed")}
              </button>
            </Field>
          </div>
        </section>
      )}
    </div>
  );
}
