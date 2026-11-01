import { useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Dumbbell, Search } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  getExercise,
  listStrengthExercises,
  muscleGroupsForExercise,
  type Equipment,
} from "@fa/shared";
import { exerciseMatches, exerciseName } from "@/lib/catalogLabels";
import { ExerciseTypeBadge } from "@/components/ExerciseTypeBadge";
import { SearchInput } from "@/components/ui/search-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ExerciseIcon, ExerciseThumb } from "../lib/exerciseIcon";
import { MuscleMap } from "../components/MuscleMap";
import { Field, TogglePills, UnitInput } from "../forms/formKit";
import {
  EquipmentSelect,
  ExercisePicker,
  exerciseAtGym,
  MuscleSelect,
  useExerciseMuscleNames,
  useGymMachineIds,
  useMuscleFilter,
} from "../forms/workoutControls";
import { lengthUnit, weightUnit, type Units } from "./units";

// The editable-input half of a calculator card. Each calculator declares a flat
// list of these field descriptors; CalcFieldControl renders one, reusing the
// same formKit primitives (Field / UnitInput / TogglePills) the gate forms use
// so the calculators look native. Values are held in a flat record keyed by
// field id — numbers for numeric fields, the enum value (string) for the rest.

export type CalcValues = Record<string, number | string | undefined>;

// Drives the trailing unit suffix on a number field. weight/length localize to
// the user's unit system; the rest are fixed labels (or none).
export type UnitKind = "weight" | "length" | "pct" | "bpm" | "years" | "min" | "reps" | "score";

type FieldBase = {
  id: string;
  labelKey: string;
  // Span the full width of the two-column input grid.
  full?: boolean;
  // i18n key for an "(i)" help popover next to the label.
  infoKey?: string;
  // When present, the field is only shown (and read) while this returns true —
  // e.g. the Navy method's hip input, shown only for women.
  visible?: (v: CalcValues) => boolean;
};

export type NumberFieldDef = FieldBase & {
  kind: "number";
  unit?: UnitKind;
  min?: number;
  max?: number;
  step?: number | "any";
  optional?: boolean;
  placeholder?: string;
};

export type SegmentedOptionDef = {
  value: string;
  labelKey: string;
  Icon?: ComponentType<{ className?: string }>;
};

export type SegmentedFieldDef = FieldBase & {
  kind: "segmented";
  options: ReadonlyArray<SegmentedOptionDef>;
  cols?: number;
};

export type SelectFieldDef = FieldBase & {
  kind: "select";
  // Options carry a resolved label (activity names etc. aren't worth i18n keys).
  options: ReadonlyArray<{ value: string; label: string }>;
};

export type ExerciseFieldDef = FieldBase & {
  kind: "exercise";
};

// A pick from the workout exercise catalog (catalog ids, as logged sessions and
// plans use), unlike `exercise`, which is the strength-standards slug space.
export type CatalogExerciseFieldDef = FieldBase & {
  kind: "catalogExercise";
  optional?: boolean;
};

export type CalcFieldDef =
  NumberFieldDef | SegmentedFieldDef | SelectFieldDef | ExerciseFieldDef | CatalogExerciseFieldDef;

// Fixed unit labels are literal; localized ones come from the units helper.
function unitSuffix(
  kind: UnitKind | undefined,
  units: Units,
  t: (k: string) => string,
): string | undefined {
  switch (kind) {
    case "weight":
      return weightUnit(units);
    case "length":
      return lengthUnit(units);
    case "pct":
      return "%";
    case "bpm":
      return "bpm";
    case "years":
      return t("calculators.units.years");
    case "min":
      return t("calculators.units.min");
    case "reps":
      return t("calculators.units.reps");
    default:
      return undefined;
  }
}

export function CalcFieldControl({
  field,
  value,
  units,
  disabled,
  onChange,
}: {
  field: CalcFieldDef;
  value: number | string | undefined;
  units: Units;
  disabled?: boolean;
  onChange: (next: number | string | undefined) => void;
}) {
  const { t } = useTranslation();
  const info = field.infoKey ? t(field.infoKey) : undefined;

  if (field.kind === "segmented") {
    return (
      <Field label={t(field.labelKey)} info={info}>
        <TogglePills
          options={field.options.map((o) => ({
            value: o.value,
            label: t(o.labelKey),
            Icon: o.Icon,
          }))}
          value={typeof value === "string" ? value : undefined}
          onChange={(v) => onChange(v)}
          cols={field.cols}
          disabled={disabled}
        />
      </Field>
    );
  }

  if (field.kind === "select") {
    return (
      <Field label={t(field.labelKey)} info={info}>
        <Select
          value={typeof value === "string" ? value : undefined}
          onValueChange={(v) => onChange(v)}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("calculators.select")} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {field.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }

  if (field.kind === "exercise") {
    return (
      <Field label={t(field.labelKey)} info={info}>
        <StrengthExercisePicker
          value={typeof value === "string" ? value : undefined}
          onPick={(slug) => onChange(slug)}
          disabled={disabled}
        />
      </Field>
    );
  }

  if (field.kind === "catalogExercise") {
    return (
      <Field label={t(field.labelKey)} optional={field.optional} info={info}>
        <ExercisePicker
          value={typeof value === "string" ? value : undefined}
          onPick={(id) => onChange(id)}
          disabled={disabled}
          gymFilterDefault={false}
        />
      </Field>
    );
  }

  // number
  return (
    <Field label={t(field.labelKey)} optional={field.optional} info={info}>
      <UnitInput
        value={typeof value === "number" ? value : ""}
        suffix={unitSuffix(field.unit, units, t)}
        min={field.min}
        max={field.max}
        step={field.step ?? "any"}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(n) => onChange(n)}
      />
    </Field>
  );
}

// ---- strength-standards exercise picker ----
// Sourced from the shared strength-standards catalog (287 lifts) rather than the
// workout exercise catalog, since the assess_strength_level math resolves by
// StrengthLevel slug/name. Searchable popover, value is the slug. Every lift
// maps onto a catalog exercise, which drives the muscle / equipment / gym
// filters shared with the workout pickers.
const STRENGTH_EXERCISES = listStrengthExercises();
const STRENGTH_ROWS = STRENGTH_EXERCISES.map((s) => ({
  s,
  ex: s.catalog_id ? getExercise(s.catalog_id) : undefined,
}));

export function strengthExerciseName(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const ex = STRENGTH_EXERCISES.find((e) => e.slug === slug);
  return ex && strengthName(ex);
}

// Lifts that map onto the workout catalog take its localized name; the rest keep
// the StrengthLevel name.
function strengthName(ex: { name: string; catalog_id?: string | null }): string {
  return ex.catalog_id ? exerciseName(ex.catalog_id) : ex.name;
}

function StrengthExercisePicker({
  value,
  onPick,
  disabled,
}: {
  value: string | undefined;
  onPick: (slug: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const gym = useGymMachineIds();
  const hasGym = gym.size > 0;
  const [onlyGym, setOnlyGym] = useState(true);
  const muscle = useMuscleFilter();
  const muscleMatches = muscle.matches;
  const muscleNames = useExerciseMuscleNames();
  const [equipmentFilter, setEquipmentFilter] = useState<Equipment | "all">("all");

  // No display cap — the full strength-standards catalog (287 lifts) is
  // browsable; the list scrolls and search narrows it. A hard cap made the
  // catalog look incomplete when browsing without a query.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtering = equipmentFilter !== "all" || muscle.value !== "all" || (onlyGym && hasGym);
    return STRENGTH_ROWS.filter(({ s, ex }) => {
      if (filtering) {
        // A lift without a catalog entry has nothing to filter on.
        if (!ex) return false;
        if (equipmentFilter !== "all" && ex.equipment !== equipmentFilter) return false;
        if (onlyGym && hasGym && !exerciseAtGym(ex.machine_id, gym)) return false;
        if (!muscleMatches(ex)) return false;
      }
      if (!q) return true;
      return (
        strengthName(s).toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.slug.includes(q) ||
        (ex ? exerciseMatches(ex, q) : false)
      );
    });
  }, [query, equipmentFilter, muscle.value, muscleMatches, onlyGym, hasGym, gym]);

  const selectedRow = value ? STRENGTH_ROWS.find((r) => r.s.slug === value) : undefined;
  const selected = selectedRow?.s;
  const label = selected && strengthName(selected);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-lg border border-edge bg-background/40 px-3 text-start text-sm shadow-well transition-colors",
            "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
            !label && "text-muted-foreground",
          )}
        >
          {selected ? (
            <ExerciseIcon exerciseId={selected.catalog_id} className="size-5" placeholder />
          ) : (
            <Dumbbell className="size-3.5 shrink-0 text-primary" />
          )}
          <span className="flex-1 truncate">{label || t("calculators.pickExercise")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <div className="space-y-2 border-b p-2">
          <SearchInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("calculators.searchExercises")}
          />
          <div className="flex gap-2">
            <MuscleSelect
              value={muscle.value}
              onChange={muscle.onChange}
              view={muscle.view}
              onViewChange={muscle.onViewChange}
            />
            <EquipmentSelect
              value={equipmentFilter}
              onChange={setEquipmentFilter}
              gym={{ on: onlyGym, onChange: setOnlyGym, available: hasGym }}
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <EmptyState icon={Search} compact className="m-2">
              {t("calculators.noMatches")}
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {results.map(({ s, ex }) => (
                <li key={s.slug}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(s.slug);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm transition-[color,background-color,box-shadow] hover:bg-accent soft:hover:bg-background soft:hover:text-primary soft:hover:shadow-pressed",
                      s.slug === value &&
                        "bg-primary/10 soft:bg-background soft:text-primary soft:shadow-pressed",
                    )}
                  >
                    <ExerciseThumb exerciseId={s.catalog_id} className="size-12" placeholder />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="font-medium">{strengthName(s)}</span>
                      {ex ? (
                        <>
                          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            <ExerciseTypeBadge type={ex.type} />
                            {ex.equipment}
                          </span>
                          <span className="text-[11px] text-muted-foreground/80">
                            {muscleNames(ex)}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-muted-foreground capitalize">
                          {s.bodypart}
                        </span>
                      )}
                    </span>
                    {ex && (
                      <MuscleMap
                        groups={muscleGroupsForExercise(ex)}
                        muscles={ex.primary_muscles}
                        className="h-12"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
