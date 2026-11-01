import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Dumbbell,
  Info,
  Layers,
  Minus,
  Play,
  Plus,
  Search,
  Target,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  getExercise,
  muscleGroupsForExercise,
  searchExercises,
  type Equipment,
  type Exercise,
  type ExerciseMetadata,
} from "@fa/shared";
import { MuscleMap } from "@/components/MuscleMap";
import { exerciseMatches, exerciseName } from "@/lib/catalogLabels";
import { ExerciseTypeBadge } from "@/components/ExerciseTypeBadge";
import { SearchInput } from "@/components/ui/search-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type MuscleView, useUiStore } from "@/lib/uiStore";
import {
  allBuckets,
  BucketMap,
  bucketLabel,
  bucketsForExercise,
  MuscleViewToggle,
} from "@/components/MuscleViewToggle";
import { ExerciseThumb } from "../lib/exerciseIcon";
import { useGetMeProfile } from "../api/endpoints/default/default";
import { toggleItemClass } from "../lib/navItem";

// The machines the user's gym has (catalog ids), from their profile. Empty when
// none curated — callers treat empty as "no equipment constraint". Backed by
// React Query, so calling it from several pickers shares one cached fetch.
export function useGymMachineIds(): Set<string> {
  const q = useGetMeProfile();
  const ids = (q.data?.profile?.gym_machine_ids ?? []) as string[];
  // Key the memo on the id list so downstream filters keep a stable Set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Set(ids), [ids.join("|")]);
}

// An exercise is doable at the user's gym when it needs no machine (free-weight
// / cable / bodyweight) OR its machine is on the saved list. With no list saved,
// every exercise passes — the filter is a no-op.
export function exerciseAtGym(machineId: string | null | undefined, gym: Set<string>): boolean {
  return !machineId || gym.size === 0 || gym.has(machineId);
}

// "Only my gym" / "All machines" switch for the "only show exercises my gym can
// do" filter. Styled like MuscleViewToggle, since it lives in the equipment menu
// the same way that one lives in the muscle menu. Disabled until the user has
// curated a gym machine list.
function GymScopeToggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const { t: tr } = useTranslation();
  return (
    <div
      role="group"
      className={cn(
        "inline-flex shrink-0 rounded-md bg-muted p-0.5 text-[11px]",
        disabled && "opacity-60",
      )}
    >
      {([true, false] as const).map((v) => (
        <button
          key={String(v)}
          type="button"
          disabled={disabled}
          aria-pressed={on === v}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium transition-colors",
            on === v
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground enabled:hover:text-foreground",
          )}
        >
          {v && <Dumbbell className="size-3" />}
          {v
            ? tr("formsAdmin.workoutControls.onlyMyGym")
            : tr("formsAdmin.workoutControls.allMachines")}
        </button>
      ))}
    </div>
  );
}

// Gym scope for EquipmentSelect: the filter state plus whether the user has a
// machine list to filter by at all.
export type GymScope = { on: boolean; onChange: (on: boolean) => void; available: boolean };

// Shared workout sub-controls for the gate forms (log_workout_session,
// save_workout_plan, plan-day edits). The exercise catalog is bundled in
// @fa/shared, so the picker resolves names + searches entirely client-side —
// no API round-trip.

// Resolve a catalog exercise id to its display name; fall back to a humanized
// id for anything not in the catalog (the model can pass arbitrary ids).
export function exerciseLabel(id: string | undefined): string {
  return exerciseName(id);
}

// Searchable exercise picker rendered as a popover. The trigger shows the
// current selection (or a placeholder); picking one calls onPick(id) and
// closes. Text search matches name + id via the shared searchExercises.
export function ExercisePicker({
  value,
  onPick,
  disabled,
  gymFilterDefault = true,
}: {
  value: string | undefined;
  onPick: (id: string) => void;
  disabled?: boolean;
  // When the user has saved gym machines, start with the "only my gym" filter
  // on (default). Pass false for contexts where hiding equipment is unhelpful.
  gymFilterDefault?: boolean;
}) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // When this picker is rendered inside a modal Dialog, portal the popover into
  // that dialog (not document.body) so its search input stays inside the
  // dialog's focus trap — otherwise the trap pulls focus back and typing fails.
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const dialogContainer = useMemo<HTMLElement | null>(
    () => (triggerEl?.closest('[role="dialog"]') as HTMLElement | null) ?? null,
    // Re-resolve when the popover opens in case the trigger moved between dialogs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [triggerEl, open],
  );

  const gym = useGymMachineIds();
  const hasGym = gym.size > 0;
  const [onlyGym, setOnlyGym] = useState(gymFilterDefault);
  const muscle = useMuscleFilter();
  const muscleNames = useExerciseMuscleNames();
  const [equipmentFilter, setEquipmentFilter] = useState<Equipment | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ExerciseTypeFilter>("all");

  const results = useMemo<Exercise[]>(() => {
    // Search wide, then apply the gym filter. No display cap: the full catalog
    // (~300 exercises) is browsable — the list scrolls (max-h below) and search
    // narrows it. searchExercises already bounds the pool at 500.
    const all = searchExercises({
      equipment: equipmentFilter === "all" ? undefined : equipmentFilter,
      limit: 500,
    })
      .filter(muscle.matches)
      .filter((e) => exerciseTypeMatches(e, typeFilter))
      .filter((e) => exerciseMatches(e, query));
    return onlyGym && hasGym ? all.filter((e) => exerciseAtGym(e.machine_id, gym)) : all;
  }, [query, muscle.matches, typeFilter, equipmentFilter, onlyGym, hasGym, gym]);

  const label = exerciseLabel(value);
  const selected = value ? getExercise(value) : undefined;
  const selectedGroups = selected ? muscleGroupsForExercise(selected) : [];

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          ref={setTriggerEl}
          type="button"
          disabled={disabled}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg border border-edge bg-background/40 text-start text-sm shadow-well transition-colors",
            "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
            selected ? "px-3 py-2" : "h-9 gap-2 px-3",
            !label && "text-muted-foreground",
          )}
        >
          {selected ? (
            // Same row layout as the list below, so the pick reads as that row.
            <>
              <ExerciseThumb exerciseId={selected.id} className="size-12" placeholder />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="font-medium">{selected.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <ExerciseTypeBadge type={selected.type} />
                  {selected.equipment}
                </span>
                {selectedGroups.length > 0 && (
                  <span className="text-[11px] text-muted-foreground/80">
                    {muscleNames(selected)}
                  </span>
                )}
              </span>
              {selectedGroups.length > 0 && (
                <MuscleMap
                  groups={selectedGroups}
                  muscles={selected.primary_muscles}
                  className="h-12"
                />
              )}
            </>
          ) : (
            <>
              <Dumbbell className="size-3.5 shrink-0 text-primary" />
              <span className="flex-1 truncate">
                {label || tr("formsAdmin.workoutControls.chooseExercise")}
              </span>
            </>
          )}
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        container={dialogContainer}
        // As wide as the trigger, but never squeezed below a usable width. The
        // var() form (not v4's w-(--x)) so tailwind-merge drops PopoverContent's w-72.
        className="w-(--radix-popover-trigger-width) min-w-72 p-0"
      >
        <div className="space-y-2 border-b p-2">
          <SearchInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={tr("formsAdmin.workoutControls.searchExercises")}
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
          <ExerciseTypeToggle value={typeFilter} onChange={setTypeFilter} />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <EmptyState icon={Search} compact className="m-2">
              {tr("formsAdmin.workoutControls.noMatches")}
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {results.map((ex) => (
                <li key={ex.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(ex.id);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm transition-[color,background-color,box-shadow] hover:bg-accent soft:hover:bg-background soft:hover:text-primary soft:hover:shadow-pressed",
                      ex.id === value &&
                        "bg-primary/10 soft:bg-background soft:text-primary soft:shadow-pressed",
                    )}
                  >
                    <ExerciseThumb exerciseId={ex.id} className="size-12" placeholder />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="font-medium">{exerciseName(ex)}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <ExerciseTypeBadge type={ex.type} />
                        {ex.equipment}
                      </span>
                      <span className="text-[11px] text-muted-foreground/80">
                        {muscleNames(ex)}
                      </span>
                    </span>
                    <MuscleMap
                      groups={muscleGroupsForExercise(ex)}
                      muscles={ex.primary_muscles}
                      className="h-12"
                    />
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

// What an exercise trains, joined for a row's caption — groups or targets per
// the Groups/Muscles toggle.
export function useExerciseMuscleNames(): (ex: Exercise) => string {
  const view = useUiStore((s) => s.muscleView);
  return (ex) =>
    bucketsForExercise(ex, view)
      .map((id) => bucketLabel(id, view))
      .join(", ");
}

// Muscle filter for exercise pickers ("all" = no filter), by group or by
// target per its own Groups/Muscles toggle. Pair with useMuscleFilter.
export function MuscleSelect({
  value,
  onChange,
  view,
  onViewChange,
}: {
  value: string;
  onChange: (v: string) => void;
  view: MuscleView;
  onViewChange: (v: MuscleView) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    // "all" has no item of its own, so map it to "" to show the placeholder.
    <Select
      open={open}
      onOpenChange={setOpen}
      value={value === "all" ? "" : value}
      onValueChange={onChange}
    >
      <SelectTrigger className="min-w-0 flex-1">
        <SelectValue placeholder={t("workout.muscleGroup")} />
      </SelectTrigger>
      <SelectContent>
        {/* The Groups/Muscles switch lives in the menu it reshapes; "All"
            (clear the filter) sits beside it. */}
        <div className="flex items-center justify-center gap-2 p-1">
          <MuscleViewToggle value={view} onChange={onViewChange} />
          <button
            type="button"
            aria-pressed={value === "all"}
            onClick={() => {
              onChange("all");
              setOpen(false);
            }}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              value === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {t("workout.allGroups")}
          </button>
        </div>
        <SelectSeparator />
        {allBuckets(view).map((b) => (
          <SelectItem key={b.id} value={b.id}>
            <span className="flex items-center gap-2">
              <BucketMap id={b.id} view={view} className="h-5" />
              {b.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// State for MuscleSelect: a local Groups/Muscles view (seeded from the shared
// preference but never written back, so it only reshapes this menu), the
// picked bucket, cleared when the view flips (a group id means nothing as a
// target), and a predicate for the result list.
export function useMuscleFilter() {
  const initialView = useUiStore((s) => s.muscleView);
  const [picked, setPicked] = useState<{ view: MuscleView; id: string }>({
    view: initialView,
    id: "all",
  });
  const { view, id: value } = picked;
  const matches = useCallback(
    (ex: Exercise) => value === "all" || bucketsForExercise(ex, view).includes(value),
    [value, view],
  );
  return {
    value,
    onChange: (id: string) => setPicked({ view, id }),
    view,
    onViewChange: (v: MuscleView) => setPicked({ view: v, id: "all" }),
    matches,
  };
}

// Compound / isolation filter for exercise pickers ("all" = any type, cardio
// included). A full-width segmented switch under the muscle/equipment selects.
export type ExerciseTypeFilter = "all" | "compound" | "isolation";

export function exerciseTypeMatches(ex: Exercise, filter: ExerciseTypeFilter): boolean {
  return filter === "all" || ex.type === filter;
}

const TYPE_FILTER_OPTIONS: { value: ExerciseTypeFilter; Icon?: typeof Layers }[] = [
  { value: "all" },
  { value: "compound", Icon: Layers },
  { value: "isolation", Icon: Target },
];

export function ExerciseTypeToggle({
  value,
  onChange,
}: {
  value: ExerciseTypeFilter;
  onChange: (v: ExerciseTypeFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" className="flex rounded-md bg-muted p-0.5 text-xs">
      {TYPE_FILTER_OPTIONS.map(({ value: v, Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-1 font-medium transition-colors",
            value === v
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {Icon && <Icon className="size-3" />}
          {v === "all" ? t("workout.allTypes") : t(`workout.exerciseType.${v}`)}
        </button>
      ))}
    </div>
  );
}

const EQUIPMENT_OPTIONS: Equipment[] = [
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "bodyweight",
  "band",
  "smith_machine",
  "cardio",
];

// Title Case the equipment id for display. Done in the text itself rather
// than via a `capitalize` class so SelectValue (which mirrors raw text) also
// shows the formatted label in the trigger.
function equipmentLabel(e: Equipment): string {
  return e
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Equipment filter for exercise pickers ("all" = any). With `gym`, the menu
// also carries the only-my-gym switch at its top, like MuscleSelect's
// Groups/Muscles switch.
export function EquipmentSelect({
  value,
  onChange,
  gym,
}: {
  value: Equipment | "all";
  onChange: (v: Equipment | "all") => void;
  gym?: GymScope;
}) {
  const { t } = useTranslation();
  const gymOn = !!gym && gym.on && gym.available;
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Equipment | "all")}>
      <SelectTrigger className="min-w-0 flex-1">
        {gymOn && <Dumbbell className="size-3.5 shrink-0 text-primary" />}
        <SelectValue placeholder={t("workout.equipment")} />
      </SelectTrigger>
      <SelectContent>
        {gym && (
          <>
            <div className="flex justify-center p-1">
              <GymScopeToggle on={gymOn} onChange={gym.onChange} disabled={!gym.available} />
            </div>
            <SelectSeparator />
          </>
        )}
        <SelectItem value="all">{t("workout.anyEquipment")}</SelectItem>
        {EQUIPMENT_OPTIONS.map((e) => (
          <SelectItem key={e} value={e}>
            {equipmentLabel(e)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Renders an exercise's optional reference media: a how-to description, demo
// images, and a link out to a video. Shared so any surface that lists exercises
// can reveal the same panel. Render only when an exercise actually has metadata
// (most don't yet — see ExerciseMetadata / the catalog).
// Turn a how-to video URL into something playable inline: an iframe embed URL
// for YouTube / Vimeo, or the file itself for direct video links. null = we
// don't know how to embed it (caller falls back to a plain link).
export function videoEmbed(url: string): { kind: "iframe" | "video"; src: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  let yt: string | null = null;
  if (host === "youtu.be") yt = u.pathname.slice(1);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    yt =
      u.searchParams.get("v") ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ?? null;
  }
  if (yt) return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${yt}?rel=0` };
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = u.pathname.match(/(\d+)/)?.[1];
    if (id) return { kind: "iframe", src: `https://player.vimeo.com/video/${id}` };
  }
  if (/\.(mp4|webm|ogg|mov)$/i.test(u.pathname)) return { kind: "video", src: url };
  return null;
}

// `embed` plays the video inline (used by the how-to modal); otherwise it's a
// "Watch video" link so compact inline panels stay small.
export function ExerciseMetaPanel({
  meta,
  embed = false,
}: {
  meta: ExerciseMetadata;
  embed?: boolean;
}) {
  const { t: tr } = useTranslation();
  const player = embed && meta.video_url ? videoEmbed(meta.video_url) : null;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      {player && (
        <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
          {player.kind === "iframe" ? (
            <iframe
              src={player.src}
              title={tr("formsAdmin.workoutControls.watchVideo")}
              className="size-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <video src={player.src} controls playsInline className="size-full" />
          )}
        </div>
      )}
      {meta.image_urls && meta.image_urls.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {meta.image_urls.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              className="h-20 shrink-0 rounded-md border object-cover"
            />
          ))}
        </div>
      )}
      {meta.video_url && !player && (
        <a
          href={meta.video_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <Play className="size-3" />
          {tr("formsAdmin.workoutControls.watchVideo")}
        </a>
      )}
      {meta.description && (
        <p className="text-xs/relaxed text-muted-foreground">{meta.description}</p>
      )}
    </div>
  );
}

// Collapsible "How to" disclosure for an exercise's reference media. Resolves
// the exercise's metadata from the catalog by id and renders NOTHING when it
// has none — so it's safe to drop into any exercise row/card unconditionally.
// Owns its own open state.
export function ExerciseMetaDisclosure({
  exerciseId,
  className,
}: {
  exerciseId: string | undefined;
  className?: string;
}) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  const meta = exerciseId ? getExercise(exerciseId)?.metadata : undefined;
  if (!meta) return null;
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="size-3.5" />
        {tr("formsAdmin.workoutControls.howTo")}
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2">
          <ExerciseMetaPanel meta={meta} />
        </div>
      )}
    </div>
  );
}

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_ABBR: Record<Weekday, string> = {
  monday: "Mo",
  tuesday: "Tu",
  wednesday: "We",
  thursday: "Th",
  friday: "Fr",
  saturday: "Sa",
  sunday: "Su",
};

export function weekdayAbbr(wd: Weekday): string {
  return WEEKDAY_ABBR[wd];
}

// 7-pill weekday multi-select. Emits a new list in canonical (Mon→Sun) order.
export function WeekdayPicker({
  value,
  onChange,
  disabled,
  unavailable,
}: {
  value: Weekday[] | undefined;
  onChange: (next: Weekday[]) => void;
  disabled?: boolean;
  // Weekdays already claimed elsewhere (e.g. by another diet-plan day): shown
  // disabled so the same weekday can't be assigned twice. An already-selected
  // day is never blocked (so it can still be deselected).
  unavailable?: ReadonlySet<Weekday>;
}) {
  const { t: tr } = useTranslation();
  const selected = new Set(value ?? []);
  const toggle = (wd: Weekday) => {
    const next = new Set(selected);
    if (next.has(wd)) next.delete(wd);
    else next.add(wd);
    onChange(WEEKDAYS.filter((w) => next.has(w)));
  };
  return (
    <div className="grid grid-cols-7 gap-1">
      {WEEKDAYS.map((wd) => {
        const active = selected.has(wd);
        const blocked = !active && (unavailable?.has(wd) ?? false);
        return (
          <button
            key={wd}
            type="button"
            disabled={disabled || blocked}
            onClick={() => toggle(wd)}
            aria-pressed={active}
            title={blocked ? tr("formsAdmin.workoutControls.alreadyUsed") : undefined}
            className={cn(
              "rounded-md border py-1.5 text-[11px] font-medium transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-60",
              toggleItemClass(active),
            )}
          >
            {WEEKDAY_ABBR[wd]}
          </button>
        );
      })}
    </div>
  );
}

// Compact integer stepper (− value +) for counts like reps / sets. Emits
// undefined when cleared so the parent can drop the key.
export function Stepper({
  value,
  onChange,
  disabled,
  min = 0,
  max,
  step = 1,
  placeholder,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  const { t: tr } = useTranslation();
  const clamp = (n: number) => {
    let out = n;
    if (min != null) out = Math.max(min, out);
    if (max != null) out = Math.min(max, out);
    return out;
  };
  const bump = (delta: number) => onChange(clamp((value ?? 0) + delta));

  return (
    <div className="flex h-9 items-stretch overflow-hidden rounded-lg border border-edge bg-background/40 shadow-well">
      <button
        type="button"
        disabled={disabled || (value != null && min != null && value <= min)}
        onClick={() => bump(-step)}
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent disabled:opacity-40"
        aria-label={tr("formsAdmin.workoutControls.decrease")}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={value ?? ""}
        disabled={disabled}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const s = e.target.value;
          if (s === "") return onChange(undefined);
          const n = Number(s);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
        className="w-full min-w-0 [appearance:textfield] border-x bg-transparent text-center text-sm tabular-nums outline-none disabled:opacity-60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        disabled={disabled || (value != null && max != null && value >= max)}
        onClick={() => bump(step)}
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent disabled:opacity-40"
        aria-label={tr("formsAdmin.workoutControls.increase")}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
