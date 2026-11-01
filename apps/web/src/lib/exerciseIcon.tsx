// Exercise silhouette icon. The catalog ships a black-on-transparent PNG per
// exercise (see packages/shared/src/data/exercise-icons.ts); we render it as-is
// in light mode and invert it to white in dark mode. Renders nothing for
// exercises without an icon so callers can drop it in unconditionally.
import { exerciseIconUrl, getExercise, machineIconUrl } from "@fa/shared";

import { cn } from "./utils";

export function ExerciseIcon({
  exerciseId,
  className,
  placeholder = false,
}: {
  exerciseId: string | undefined | null;
  className?: string;
  // When true, exercises without an icon reserve an empty box of the same size
  // so rows/labels stay aligned instead of the text shifting left.
  placeholder?: boolean;
}) {
  return (
    <IconImg
      url={exerciseId ? exerciseIconUrl(exerciseId) : null}
      {...{ className, placeholder }}
    />
  );
}

// Same treatment for a gym machine (see MACHINE_ICONS).
export function MachineIcon({
  machineId,
  className,
  placeholder = false,
}: {
  machineId: string | undefined | null;
  className?: string;
  placeholder?: boolean;
}) {
  return (
    <IconImg url={machineId ? machineIconUrl(machineId) : null} {...{ className, placeholder }} />
  );
}

// Picture for an exercise row: the machine it's done on when that machine has
// an icon, otherwise the exercise's own silhouette.
export function ExerciseThumb({
  exerciseId,
  machineId,
  className,
  placeholder = false,
}: {
  exerciseId: string | undefined | null;
  machineId?: string | null;
  className?: string;
  placeholder?: boolean;
}) {
  const machine = machineId ?? (exerciseId ? getExercise(exerciseId)?.machine_id : null);
  const url =
    (machine && machineIconUrl(machine)) || (exerciseId ? exerciseIconUrl(exerciseId) : null);
  return <IconImg {...{ url, className, placeholder }} />;
}

function IconImg({
  url,
  className,
  placeholder,
}: {
  url: string | null;
  className?: string;
  placeholder?: boolean;
}) {
  if (!url) {
    return placeholder ? <div aria-hidden className={cn("size-8 shrink-0", className)} /> : null;
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      loading="lazy"
      className={cn("size-8 shrink-0 object-contain dark:invert", className)}
    />
  );
}
