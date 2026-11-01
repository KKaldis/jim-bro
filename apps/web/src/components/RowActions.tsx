import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "../lib/utils";

// A compact kebab (3-dots) menu collecting a row's edit / delete actions, so
// list rows don't carry a cluster of always-visible icon buttons. Used across
// Diets, Workout plans, Pantry rows, Body entries, and Nutrition meal
// slots. Either action is optional; pass extra items via `children` (e.g. the
// pantry "to buy" toggle) and they render above the edit/delete group, or via
// `middle` (e.g. "Export PDF") to sit between edit and delete.
export function RowActions({
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
  ariaLabel,
  align = "end",
  disabled,
  triggerClassName,
  children,
  middle,
}: {
  onEdit?: () => void;
  onDelete?: () => void;
  editLabel?: string;
  deleteLabel?: string;
  ariaLabel?: string;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  triggerClassName?: string;
  children?: React.ReactNode;
  middle?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          className={cn("size-8 text-muted-foreground", triggerClassName)}
          aria-label={ariaLabel ?? t("components.rowActions.aria")}
        >
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {children}
        {onEdit && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" />
            {editLabel ?? t("common.edit")}
          </DropdownMenuItem>
        )}
        {middle}
        {onDelete && (
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive soft:focus:text-destructive"
          >
            <Trash2 className="size-4" />
            {deleteLabel ?? t("common.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
