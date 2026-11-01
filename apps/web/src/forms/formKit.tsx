import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus, X } from "lucide-react";
import { Collapsible } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";
import { toggleItemClass } from "../lib/navItem";

// Shared building blocks for bespoke gate forms (UpdateProfileForm, FoodForm,
// …). Every tool form is just a tactile skin over the tool's flat JSON-Schema
// input; these primitives give them one consistent visual language — section
// headers, labelled fields with optional "(i)" help, unit-suffixed number
// inputs, and segmented pill toggles — all driven by the theme tokens.

type IconType = ComponentType<{ className?: string }>;

// Bordered sub-card whose uppercase header toggles the body open and closed;
// starts closed. Uncontrolled unless `open` / `onOpenChange` are passed. `hint`
// shows muted text by the chevron (e.g. a selection count). While closed the
// body sits in a disabled fieldset, so its controls drop out of the Tab order.
export function CollapsibleSection({
  Icon,
  title,
  hint,
  open,
  onOpenChange,
  disabled,
  children,
}: {
  Icon: IconType;
  title: ReactNode;
  hint?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const toggle = () => {
    setOwnOpen(!isOpen);
    onOpenChange?.(!isOpen);
  };

  return (
    <section className="rounded-lg border bg-muted/40 soft:border-transparent soft:bg-background soft:shadow-tile">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        disabled={disabled}
        className="flex w-full items-center gap-1.5 p-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground disabled:opacity-50 soft:hover:text-primary"
      >
        <Icon className="size-3.5 text-primary" />
        {title}
        <span className="ms-auto text-[11px] font-normal tracking-normal normal-case">{hint}</span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform", isOpen && "rotate-180")}
        />
      </button>
      <Collapsible open={isOpen}>
        <fieldset disabled={!isOpen} className="min-w-0 space-y-3 px-3 pb-3">
          {children}
        </fieldset>
      </Collapsible>
    </section>
  );
}

// Uppercase header that introduces a group of related fields. `info` adds an
// "(i)" popover next to the title; `hint` shows muted text right-aligned.
export function SectionLabel({
  Icon,
  children,
  info,
  hint,
}: {
  Icon: IconType;
  children: ReactNode;
  info?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5 text-primary" />
        {children}
        {info && <InfoHint text={info} />}
      </div>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

// Labelled field row: name on the left (optional fields marked by a dashed
// control, see styles.css, rather than a tag; plus an
// info popover), a right-aligned live hint (e.g. computed age / kcal), and the
// control beneath.
export function Field({
  label,
  hint,
  optional,
  info,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  optional?: boolean;
  info?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const { t: tr } = useTranslation();
  return (
    // Optional fields aren't labelled visually: data-optional gives their empty
    // controls a dashed border instead (styles.css). The word stays for screen
    // readers.
    <div className={cn("space-y-1.5", className)} data-optional={optional ? "" : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
        >
          {label}
          {optional && <span className="sr-only">({tr("formsAdmin.field.optional")})</span>}
          {info && <InfoHint text={info} />}
        </label>
        {hint != null && <span className="text-[11px] text-primary/80 tabular-nums">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// Number input with an optional leading icon and trailing unit suffix.
// Emits `undefined` when cleared so the parent can drop the key entirely.
export function UnitInput({
  icon,
  suffix,
  value,
  disabled,
  placeholder,
  min,
  max,
  step,
  id,
  className,
  onChange,
}: {
  icon?: ReactNode;
  suffix?: ReactNode;
  value: number | "";
  disabled?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | "any";
  id?: string;
  // Extra classes for the input itself (e.g. tighter padding in a dense grid).
  className?: string;
  onChange: (n: number | undefined) => void;
}) {
  // Local text buffer so an in-progress edit — a trailing "." (1.5), a leading
  // zero, or a momentarily-empty field — survives the parent's re-render with
  // the parsed number. A plain controlled `type="number"` echoes the canonical
  // numeric value straight back into the input, wiping the partial text the
  // user just typed (the "reverts to the previous value" bug). We only re-seed
  // the buffer from the prop when it represents a genuinely different number
  // (an external reset/prefill), never while the user's own keystroke is
  // round-tripping through onChange.
  const [text, setText] = useState(value === "" || value == null ? "" : String(value));
  useEffect(() => {
    const incoming = value === "" || value == null ? "" : value;
    const parsed = text.trim() === "" ? "" : Number(text);
    if (parsed !== incoming) setText(incoming === "" ? "" : String(incoming));
    // Only reconcile when the external value changes; buffer owns in-progress text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative">
      {icon && (
        <span className="pointer-events-none absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
          {icon}
        </span>
      )}
      <Input
        id={id}
        // Text (not number) so browser value-sanitization doesn't discard a
        // half-typed decimal like "1." before we can read it; inputMode keeps
        // the numeric keypad on mobile. min/max/step are advisory only here.
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          // Keep only number-ish characters so the buffer can't hold garbage,
          // while still allowing a lone "-" or "." mid-type.
          const s = e.target.value.replace(/[^\d.eE+-]/g, "");
          setText(s);
          if (s.trim() === "") return onChange(undefined);
          const n = Number(s);
          // Skip emitting on a not-yet-a-number partial ("-", ".") — keep the
          // last committed value until the text parses cleanly.
          if (Number.isFinite(n)) onChange(n);
        }}
        className={cn("h-9", icon && "ps-8", suffix && "pe-9", className)}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

// Lets a single-target gate form edit SEVERAL targets in ONE tool call so a
// multi-row change shows one card instead of one per row. The tool input is
// either a flat single patch or `{ edits: [...] }`; this normalizes both to a
// list, renders each row via `renderItem`, and writes back the FLAT object for a
// lone row (keeping the simple shape the handler's single-mode path expects) or
// `{ edits }` for two-or-more. See docs note in overrides.tsx.
export function BatchRepeater<T extends Record<string, unknown>>({
  value,
  onChange,
  disabled,
  Icon,
  title,
  addLabel,
  emptyItem,
  renderItem,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  Icon: IconType;
  title: string;
  // Add button is shown only when both are given. Omit for "update" forms whose
  // per-row identity is an opaque id the user can't type into a blank row.
  addLabel?: string;
  emptyItem?: () => T;
  renderItem: (item: T, set: (patch: Partial<T>) => void, index: number) => ReactNode;
}) {
  const { t: tr } = useTranslation();
  const v = (value as ({ edits?: T[] } & T) | null) ?? ({} as T);
  const items: T[] = Array.isArray(v.edits) ? v.edits : [v as T];
  // A lone row stays flat; two-or-more become `{ edits }`. The handler accepts
  // both, so single edits are byte-for-byte unchanged from before batching.
  const commit = (next: T[]) =>
    onChange(next.length <= 1 ? ((next[0] ?? {}) as unknown) : { edits: next });
  const setItem = (i: number, patch: Partial<T>) =>
    commit(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () => emptyItem && commit([...items, emptyItem()]);
  const removeItem = (i: number) => commit(items.filter((_, idx) => idx !== i));
  const multi = items.length > 1;
  return (
    <div className="space-y-3">
      <SectionLabel
        Icon={Icon}
        hint={multi ? tr("formsAdmin.batch.itemCount", { count: items.length }) : undefined}
      >
        {title}
      </SectionLabel>
      {items.map((item, i) => (
        <div
          key={i}
          className={cn(multi && "rounded-md border border-edge bg-background/40 p-2 shadow-well")}
        >
          {multi && (
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                #{i + 1}
              </span>
              <button
                type="button"
                onClick={() => removeItem(i)}
                disabled={disabled}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                aria-label={tr("common.remove")}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          <div className="space-y-4">{renderItem(item, (patch) => setItem(i, patch), i)}</div>
        </div>
      ))}
      {addLabel && emptyItem && (
        <button
          type="button"
          onClick={addItem}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          <Plus className="size-3" />
          {addLabel}
        </button>
      )}
    </div>
  );
}

export type PillOption<T extends string> = {
  value: T;
  label: string;
  Icon?: IconType;
  // Static tailwind class for the icon tint when active (e.g. "text-chart-2").
  tint?: string;
};

// Segmented control: a row (or grid) of mutually-exclusive pills. Used for
// small closed enums — sex, g/ml/pcs unit, merge/replace mode, …
export function TogglePills<T extends string>({
  options,
  value,
  onChange,
  disabled,
  cols,
}: {
  options: ReadonlyArray<PillOption<T>>;
  value: T | undefined;
  onChange: (v: T) => void;
  disabled?: boolean;
  cols?: number;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map(({ value: v, label, Icon, tint }) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(v)}
            aria-pressed={active}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-60",
              toggleItemClass(active),
            )}
          >
            {Icon && <Icon className={cn("size-4", active && (tint ?? "text-primary"))} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
