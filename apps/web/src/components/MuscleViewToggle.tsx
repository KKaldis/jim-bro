// One switch for every muscle breakdown — progress volume and plan totals —
// between the 8 coarse groups and the finer per-muscle targets. The choice is a
// shared, persisted preference, so flipping it anywhere flips it everywhere.
// Pass value/onChange to drive a local view instead (the exercise pickers'
// filter menu, which shouldn't reshape the rest of the UI).
import { useTranslation } from "react-i18next";
import {
  type Exercise,
  type ExerciseId,
  MUSCLE_GROUPS,
  MUSCLE_TARGETS,
  MUSCLE_TO_GROUP,
  muscleGroupsForExercise,
  targetsForExercise,
} from "@fa/shared";
import { MuscleMap } from "@/components/MuscleMap";
import { muscleGroupLabel, muscleTargetLabel } from "@/lib/catalogLabels";
import { type MuscleView, useUiStore } from "@/lib/uiStore";
import { cn } from "@/lib/utils";

// The buckets (group or target ids) an exercise counts toward, primary muscles only.
export function bucketsForExercise(ex: Exercise | ExerciseId, view: MuscleView): string[] {
  return view === "target" ? targetsForExercise(ex) : muscleGroupsForExercise(ex);
}

export function bucketLabel(id: string, view: MuscleView): string {
  return view === "target" ? muscleTargetLabel(id) : muscleGroupLabel(id);
}

// Every bucket of a view, in catalog order — for filter menus.
export function allBuckets(view: MuscleView): { id: string; label: string }[] {
  return (view === "target" ? MUSCLE_TARGETS : MUSCLE_GROUPS).map((b) => ({
    id: b.id,
    label: bucketLabel(b.id, view),
  }));
}

// A bucket's anatomy icon: a target highlights its own muscles.
export function BucketMap({
  id,
  view,
  className,
}: {
  id: string;
  view: MuscleView;
  className?: string;
}) {
  if (view === "group") return <MuscleMap groups={[id]} className={className} />;
  const muscles = MUSCLE_TARGETS.find((t) => t.id === id)?.muscles ?? [];
  return (
    <MuscleMap
      groups={muscles.length ? [MUSCLE_TO_GROUP[muscles[0]]] : []}
      muscles={muscles}
      title={bucketLabel(id, view)}
      className={className}
    />
  );
}

export function MuscleViewToggle({
  className,
  value,
  onChange,
}: {
  className?: string;
  value?: MuscleView;
  onChange?: (v: MuscleView) => void;
}) {
  const { t } = useTranslation();
  const storeView = useUiStore((s) => s.muscleView);
  const setStoreView = useUiStore((s) => s.setMuscleView);
  const view = value ?? storeView;
  const setView = onChange ?? setStoreView;
  return (
    <div
      role="group"
      aria-label={t("workout.muscleViewAria")}
      className={cn(
        "inline-flex shrink-0 rounded-md bg-muted p-0.5 text-[11px] soft:gap-1.5 soft:bg-transparent soft:p-0",
        className,
      )}
    >
      {(["group", "target"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => setView(v)}
          className={cn(
            "rounded-sm px-2 py-0.5 font-medium transition-[color,box-shadow]",
            view === v
              ? "bg-background text-foreground shadow-xs soft:text-primary soft:shadow-pressed"
              : "text-muted-foreground hover:text-foreground soft:shadow-control soft:hover:text-primary",
          )}
        >
          {t(v === "group" ? "workout.muscleViewGroups" : "workout.muscleViewMuscles")}
        </button>
      ))}
    </div>
  );
}
