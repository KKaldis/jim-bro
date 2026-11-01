import { useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bone,
  Cake,
  Droplets,
  Plus,
  Ruler,
  Salad,
  Scale,
  StickyNote,
  Target,
  Venus,
  Mars,
  Dumbbell,
  X,
} from "lucide-react";
import { MACHINES } from "@fa/shared";
import { MuscleMap, muscleGroupNames } from "@/components/MuscleMap";
import { machineName } from "@/lib/catalogLabels";
import { MachineIcon } from "@/lib/exerciseIcon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { GOAL_META } from "@/lib/goalMeta";
import { CollapsibleSection, Field, SectionLabel, TogglePills, UnitInput } from "./formKit";
import { useFormContext } from "./formContext";
import type { JsonSchema } from "./ToolForm";
import type { ToolOverrideProps } from "./overrides";
import { toggleItemClass } from "../lib/navItem";

// Bespoke gate form for update_profile. Replaces the schema-driven renderer
// with a tactile, on-theme layout: segmented sex toggle, goal cards, an
// activity-level ladder, unit-suffixed number fields, and a tag editor for
// dietary restrictions. The data contract is unchanged — every control reads
// and writes the same flat input keys the tool's JSON Schema declares
// (sex, birth_year, height_cm, activity_level, goal, target_weight_kg,
// restrictions[], notes). The parent ToolFormCard owns Save/Cancel.

type Sex = "male" | "female";
type Goal = "cut" | "maintain" | "recomp" | "lean_bulk";
type ActivityLevel = "sedentary" | "light" | "moderate" | "very" | "extreme";
type UnitSystem = "metric" | "imperial";

type ProfileInput = {
  sex?: Sex;
  birth_year?: number;
  height_cm?: number;
  activity_level?: ActivityLevel;
  goal?: Goal;
  target_weight_kg?: number | null;
  restrictions?: string[];
  notes?: string;
  // Stable skeletal-frame proxies (stored metric) — drive the muscular-potential
  // estimate. Optional; many users never measure them.
  wrist_cm?: number | null;
  ankle_cm?: number | null;
  // Preferred unit system for entering/reading measurements. Display-only —
  // every value above stays metric in the payload.
  units?: UnitSystem;
  // Persistent everyday hydration target (ml). Single source of truth for the
  // daily water goal; null/absent = app default. Unit-independent (always ml).
  water_goal_ml?: number | null;
  // Catalog machine ids the user's gym has. Optional — empty/absent means
  // "no constraint"; when set, the coach prefers these when planning.
  gym_machine_ids?: string[] | null;
  // Tolerated if the model passed it instead of birth_year — we don't surface
  // a separate control, but we won't clobber it either.
  age?: number;
};

// Storage is metric; the unit toggle only changes the entry boundary. Display
// helpers convert the stored cm/kg value into the chosen unit (rounded for
// legibility), and the inverse converts user input back to metric before it
// lands in the draft — so flipping units never rewrites stored values, and
// untouched fields keep their exact metric precision.
const CM_PER_IN = 2.54;
const LB_PER_KG = 2.2046226218;
const round1 = (n: number) => Math.round(n * 10) / 10;

// value → { labelKey, descKey } under formsAdmin.profile.*. Labels/descriptions
// are resolved via t() at render time so they localize.
const UNIT_OPTIONS: ReadonlyArray<{ value: UnitSystem; labelKey: string }> = [
  { value: "metric", labelKey: "metric" },
  { value: "imperial", labelKey: "imperial" },
];

const SEXES: ReadonlyArray<{
  value: Sex;
  labelKey: string;
  Icon: ComponentType<{ className?: string }>;
}> = [
  { value: "male", labelKey: "sexMale", Icon: Mars },
  { value: "female", labelKey: "sexFemale", Icon: Venus },
];

// Icon + tint come from the shared GOAL_META (the same chrome the dashboard
// GoalTile and the chat result cards use) so a goal looks identical wherever it
// appears; only the picker-specific label + description live here.
const GOALS: ReadonlyArray<{
  value: Goal;
  labelKey: string;
  descKey: string;
}> = [
  { value: "cut", labelKey: "goalCut", descKey: "goalCutDesc" },
  { value: "maintain", labelKey: "goalMaintain", descKey: "goalMaintainDesc" },
  { value: "recomp", labelKey: "goalRecomp", descKey: "goalRecompDesc" },
  { value: "lean_bulk", labelKey: "goalLeanBulk", descKey: "goalLeanBulkDesc" },
];

const ACTIVITY: ReadonlyArray<{
  value: ActivityLevel;
  labelKey: string;
  descKey: string;
}> = [
  { value: "sedentary", labelKey: "activitySedentary", descKey: "activitySedentaryDesc" },
  { value: "light", labelKey: "activityLight", descKey: "activityLightDesc" },
  { value: "moderate", labelKey: "activityModerate", descKey: "activityModerateDesc" },
  { value: "very", labelKey: "activityVery", descKey: "activityVeryDesc" },
  { value: "extreme", labelKey: "activityExtreme", descKey: "activityExtremeDesc" },
];

// Common hard constraints offered as one-tap chips. Snake_case matches the
// convention the agent uses when it writes restrictions itself.
const RESTRICTION_SUGGESTIONS = [
  "lactose_intolerant",
  "gluten_free",
  "vegetarian",
  "vegan",
  "no_pork",
  "nut_allergy",
  "shellfish_allergy",
  "halal",
  "kosher",
] as const;

const CURRENT_YEAR = new Date().getFullYear();

function humanizeTag(tag: string): string {
  return tag.replace(/_/g, " ");
}

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

export function UpdateProfileForm({ schema, value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const p = (value as ProfileInput) ?? {};
  const { ctx } = useFormContext();
  const currentWeight = ctx.lastBodyComp?.weight_kg ?? null;

  // Per-field help text straight from the tool's JSON Schema, so the (i) hints
  // here stay in sync with what the agent sees — no duplicated copy.
  const props = (schema as JsonSchema | undefined)?.properties ?? {};
  const fieldDesc = (key: string) => props[key]?.description;

  const set = (patch: Partial<ProfileInput>) => onChange({ ...p, ...patch });

  const age =
    p.birth_year != null && p.birth_year >= 1900 && p.birth_year <= CURRENT_YEAR
      ? CURRENT_YEAR - p.birth_year
      : null;

  const targetDelta =
    currentWeight != null && p.target_weight_kg != null ? p.target_weight_kg - currentWeight : null;

  // Unit boundary: the draft always carries metric values; these convert to the
  // chosen display unit (and back on input).
  const units: UnitSystem = p.units === "imperial" ? "imperial" : "metric";
  const lenSuffix = units === "imperial" ? "in" : "cm";
  const massSuffix = units === "imperial" ? "lb" : "kg";
  const toLen = (cm?: number | null): number | "" =>
    cm == null ? "" : round1(units === "imperial" ? cm / CM_PER_IN : cm);
  const fromLen = (v: number | undefined): number | undefined =>
    v == null ? undefined : units === "imperial" ? v * CM_PER_IN : v;
  const toMass = (kg?: number | null): number | "" =>
    kg == null ? "" : round1(units === "imperial" ? kg * LB_PER_KG : kg);
  const fromMass = (v: number | undefined): number | undefined =>
    v == null ? undefined : units === "imperial" ? v / LB_PER_KG : v;
  const fmtMass = (kg: number) =>
    `${(units === "imperial" ? round1(kg * LB_PER_KG) : round1(kg)).toFixed(1)} ${massSuffix}`;

  return (
    <div className="space-y-6">
      {/* ── Units ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Ruler} info={tr("formsAdmin.profile.unitsInfo")}>
          {tr("formsAdmin.profile.units")}
        </SectionLabel>
        <TogglePills
          options={UNIT_OPTIONS.map((o) => ({
            value: o.value,
            label: tr(`formsAdmin.profile.${o.labelKey}`),
          }))}
          value={units}
          disabled={disabled}
          onChange={(v) => set({ units: v })}
          cols={2}
        />
      </section>

      {/* ── Basics ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Cake}>{tr("formsAdmin.profile.basics")}</SectionLabel>

        <Field label={tr("formsAdmin.profile.sex")} info={fieldDesc("sex")}>
          <div className="grid grid-cols-2 gap-2">
            {SEXES.map(({ value: v, labelKey, Icon }) => {
              const active = p.sex === v;
              return (
                <button
                  key={v}
                  type="button"
                  disabled={disabled}
                  onClick={() => set({ sex: v })}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    toggleItemClass(active),
                  )}
                  aria-pressed={active}
                >
                  <Icon className={cn("size-4", active && "text-primary")} />
                  {tr(`formsAdmin.profile.${labelKey}`)}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label={tr("formsAdmin.profile.birthYear")}
            info={fieldDesc("birth_year") ?? fieldDesc("age")}
            hint={age != null ? tr("formsAdmin.profile.yearsOld", { age }) : undefined}
          >
            <UnitInput
              icon={<Cake className="size-3.5" />}
              value={p.birth_year ?? ""}
              disabled={disabled}
              placeholder="1990"
              min={1900}
              max={CURRENT_YEAR}
              step={1}
              onChange={(n) => set({ birth_year: n, age: undefined })}
            />
          </Field>

          <Field label={tr("formsAdmin.profile.height")} info={fieldDesc("height_cm")}>
            <UnitInput
              icon={<Ruler className="size-3.5" />}
              suffix={lenSuffix}
              value={toLen(p.height_cm)}
              disabled={disabled}
              placeholder={units === "imperial" ? "70" : "178"}
              step="any"
              onChange={(n) => set({ height_cm: fromLen(n) })}
            />
          </Field>
        </div>
      </section>

      {/* ── Frame measurements (optional) ──────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Bone} info={tr("formsAdmin.profile.frameInfo")}>
          {tr("formsAdmin.profile.frame")}
        </SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr("formsAdmin.profile.wrist")} optional info={fieldDesc("wrist_cm")}>
            <UnitInput
              icon={<Bone className="size-3.5" />}
              suffix={lenSuffix}
              value={toLen(p.wrist_cm)}
              disabled={disabled}
              placeholder={units === "imperial" ? "6.7" : "17"}
              step="any"
              onChange={(n) => set({ wrist_cm: fromLen(n) ?? null })}
            />
            <p className="text-[11px] leading-tight text-muted-foreground">
              {tr("formsAdmin.profile.wristHelp")}
            </p>
          </Field>
          <Field label={tr("formsAdmin.profile.ankle")} optional info={fieldDesc("ankle_cm")}>
            <UnitInput
              icon={<Bone className="size-3.5" />}
              suffix={lenSuffix}
              value={toLen(p.ankle_cm)}
              disabled={disabled}
              placeholder={units === "imperial" ? "8.7" : "22"}
              step="any"
              onChange={(n) => set({ ankle_cm: fromLen(n) ?? null })}
            />
            <p className="text-[11px] leading-tight text-muted-foreground">
              {tr("formsAdmin.profile.ankleHelp")}
            </p>
          </Field>
        </div>
      </section>

      {/* ── Goal ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Target} info={fieldDesc("goal")}>
          {tr("formsAdmin.profile.goal")}
        </SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          {GOALS.map(({ value: v, labelKey, descKey }) => {
            const active = p.goal === v;
            const { Icon, accent } = GOAL_META[v];
            return (
              <button
                key={v}
                type="button"
                disabled={disabled}
                onClick={() => set({ goal: v })}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  toggleItemClass(active, { muted: false }),
                  active && "ring-1 ring-primary/40 soft:ring-0",
                )}
                aria-pressed={active}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className={cn("size-4", accent)} />
                  {tr(`formsAdmin.profile.${labelKey}`)}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {tr(`formsAdmin.profile.${descKey}`)}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Activity level ─────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Activity} info={fieldDesc("activity_level")}>
          {tr("formsAdmin.profile.activityLevel")}
        </SectionLabel>
        <div className="overflow-hidden rounded-lg border border-edge soft:shadow-control">
          {ACTIVITY.map(({ value: v, labelKey, descKey }, i) => {
            const active = p.activity_level === v;
            return (
              <button
                key={v}
                type="button"
                disabled={disabled}
                onClick={() => set({ activity_level: v })}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  i > 0 && "border-t",
                  active
                    ? "bg-primary/10 soft:bg-background soft:text-primary soft:shadow-pressed"
                    : "bg-background/40 hover:bg-accent",
                )}
                aria-pressed={active}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-primary" : "border-muted-foreground/40",
                  )}
                >
                  {active && <span className="size-2 rounded-full bg-primary" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium">
                    {tr(`formsAdmin.profile.${labelKey}`)}
                  </span>
                  <span className="ms-2 text-[11px] text-muted-foreground">
                    {tr(`formsAdmin.profile.${descKey}`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Target weight (optional) ───────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Scale} info={fieldDesc("target_weight_kg")}>
          {tr("formsAdmin.profile.targetWeight")}
        </SectionLabel>
        <Field
          label={tr("formsAdmin.profile.goalWeight")}
          optional
          hint={
            currentWeight != null
              ? targetDelta != null
                ? `${tr("formsAdmin.profile.nowMass", { mass: fmtMass(currentWeight) })} · ${
                    targetDelta === 0
                      ? tr("formsAdmin.profile.atTarget")
                      : tr("formsAdmin.profile.toGo", {
                          delta: `${targetDelta > 0 ? "+" : "-"}${fmtMass(Math.abs(targetDelta))}`,
                        })
                  }`
                : tr("formsAdmin.profile.currentWeight", { mass: fmtMass(currentWeight) })
              : undefined
          }
        >
          <UnitInput
            icon={<Target className="size-3.5" />}
            suffix={massSuffix}
            value={toMass(p.target_weight_kg)}
            disabled={disabled}
            placeholder={tr("formsAdmin.profile.optionalPlaceholder")}
            step="any"
            onChange={(n) => set({ target_weight_kg: fromMass(n) ?? null })}
          />
        </Field>
      </section>

      {/* ── Hydration goal ─────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Droplets} info={tr("formsAdmin.profile.hydrationInfo")}>
          {tr("formsAdmin.profile.hydration")}
        </SectionLabel>
        <Field
          label={tr("formsAdmin.profile.hydrationGoal")}
          optional
          info={fieldDesc("water_goal_ml")}
        >
          <UnitInput
            icon={<Droplets className="size-3.5" />}
            suffix="ml"
            value={p.water_goal_ml ?? ""}
            disabled={disabled}
            placeholder="2500"
            min={0}
            step={100}
            onChange={(n) => set({ water_goal_ml: n == null ? null : Math.round(n) })}
          />
          <p className="text-[11px] leading-tight text-muted-foreground">
            {tr("formsAdmin.profile.hydrationHelp")}
          </p>
        </Field>
      </section>

      {/* ── Dietary restrictions ───────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Salad} info={fieldDesc("restrictions")}>
          {tr("formsAdmin.profile.dietaryRestrictions")}
        </SectionLabel>
        <RestrictionsEditor
          value={p.restrictions ?? []}
          disabled={disabled}
          onChange={(next) => set({ restrictions: next })}
        />
      </section>

      {/* ── Notes ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={StickyNote} info={fieldDesc("notes")}>
          {tr("formsAdmin.profile.notes")}
        </SectionLabel>
        <Textarea
          value={p.notes ?? ""}
          disabled={disabled}
          rows={2}
          placeholder={tr("formsAdmin.profile.notesPlaceholder")}
          onChange={(e) => set({ notes: e.target.value || undefined })}
          className="min-h-14 resize-y"
        />
      </section>

      {/* ── Gym machines ───────────────────────────────────────── */}
      <CollapsibleSection
        Icon={Dumbbell}
        title={tr("formsAdmin.profile.gymMachines")}
        hint={p.gym_machine_ids?.length || null}
      >
        <p className="text-xs text-muted-foreground">{tr("formsAdmin.profile.gymMachinesHelp")}</p>
        <MachineSelector
          value={p.gym_machine_ids ?? []}
          disabled={disabled}
          onChange={(next) => set({ gym_machine_ids: next })}
        />
      </CollapsibleSection>
    </div>
  );
}

// Tag editor for the free-text restrictions[] array: removable chips, a
// type-to-add input (Enter / comma commits), and one-tap common suggestions.
function RestrictionsEditor({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t: tr } = useTranslation();
  const [draft, setDraft] = useState("");

  const has = (tag: string) => value.includes(tag);

  const add = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag || has(tag)) return;
    onChange([...value, tag]);
  };

  const remove = (tag: string) => onChange(value.filter((t) => t !== tag));

  const commitDraft = () => {
    if (draft.trim()) add(draft);
    setDraft("");
  };

  const suggestions = useMemo(
    () => RESTRICTION_SUGGESTIONS.filter((s) => !value.includes(s)),
    [value],
  );

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-1 ps-2.5 pe-1 text-xs font-medium"
            >
              {humanizeTag(tag)}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                  aria-label={tr("formsAdmin.profile.removeTag", { tag: humanizeTag(tag) })}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <Input
        value={draft}
        disabled={disabled}
        placeholder={tr("formsAdmin.profile.addConstraintPlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitDraft();
          } else if (e.key === "Backspace" && !draft && value.length) {
            remove(value[value.length - 1]);
          }
        }}
        onBlur={commitDraft}
        className="h-9"
      />

      {!disabled && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3" />
              {humanizeTag(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Multi-select for the gym's available machines: a checkbox list over the
// static catalog (MACHINES). Stores the selected catalog ids; empty = no constraint.
// Unknown ids already on the profile (e.g. from a catalog rename) are kept and
// shown by id so a save round-trip never silently drops them.
function MachineSelector({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t: tr, i18n } = useTranslation();
  const selected = new Set(value);
  const catalog = useMemo(
    () =>
      MACHINES.map((m) => ({ ...m, name: machineName(m.id) })).sort((a, b) =>
        a.name.localeCompare(b.name, i18n.language),
      ),
    [i18n.language],
  );
  // Selected ids not present in the catalog — surface them so they're editable.
  const orphans = value.filter((id) => !MACHINES.some((m) => m.id === id));

  const toggle = (id: string) => {
    if (selected.has(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  };

  // The checkbox is visually hidden — a selected row is highlighted instead —
  // but kept for keyboard and screen-reader toggling.
  const row =
    "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent/50 has-[:checked]:bg-primary/10 has-[:disabled]:cursor-default has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset";
  const box = "sr-only";

  return (
    <div className="space-y-2">
      <ul className="divide-y overflow-hidden rounded-lg border bg-background">
        {catalog.map((m) => {
          const on = selected.has(m.id);
          return (
            <li key={m.id}>
              <label className={row}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() => toggle(m.id)}
                  className={box}
                />
                <MachineIcon machineId={m.id} className="size-10" placeholder />
                <span className="flex min-w-0 flex-col leading-tight font-medium">
                  {m.name}
                  <span className="text-[10px] font-normal text-muted-foreground">
                    {muscleGroupNames(m.muscle_groups)}
                  </span>
                </span>
                <MuscleMap
                  groups={m.muscle_groups}
                  className={cn("ms-auto h-10 shrink-0", !on && "opacity-70")}
                />
              </label>
            </li>
          );
        })}
        {orphans.map((id) => (
          <li key={id}>
            <label className={row}>
              <input
                type="checkbox"
                checked
                disabled={disabled}
                onChange={() => toggle(id)}
                className={box}
              />
              <span className="font-medium">{id}</span>
            </label>
          </li>
        ))}
      </ul>
      {value.length > 0 && !disabled && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {tr("formsAdmin.profile.clearAll", { count: value.length })}
        </button>
      )}
    </div>
  );
}
