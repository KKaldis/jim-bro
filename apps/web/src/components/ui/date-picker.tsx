import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Input } from "./input";
import { Button } from "./button";
import { cn } from "@/lib/utils";
import {
  displayToIso,
  formatTime24,
  isoToDisplay,
  isValidTime24,
  maskDateInput,
  maskTimeInput,
} from "@/lib/dateFormat";

// DD-MM-YYYY date picker. The displayed value is always DD-MM-YYYY; the
// `value` prop and `onChange` callback use ISO YYYY-MM-DD so the API
// contract with the backend (and the agent's tool schemas) is unchanged.
//
// Two interaction paths:
//   1. Type into the text field — auto-masked to DD-MM-YYYY, parsed on
//      blur or on every valid full-length input.
//   2. Click the calendar icon — a custom month-grid popover (no native
//      <input type="date"> because that picker's display is locale-bound).

type DatePickerProps = {
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
  // When true and value is empty, the input shows nothing and the popover
  // opens on today's month. Same as default, kept for symmetry.
  ariaLabel?: string;
  // Which edge the calendar popover anchors to. Default "right" (opens
  // leftward) suits a right-aligned field; pass "left" for a field near the
  // screen's left edge so the panel opens rightward and stays on screen.
  align?: "left" | "right";
};

export function DatePicker({
  value,
  onChange,
  disabled,
  required,
  placeholder = "DD-MM-YYYY",
  className,
  id,
  ariaLabel,
  align,
}: DatePickerProps) {
  // local mirror of the text field so partial input ("15-0") doesn't snap
  // back to the committed value while the user is still typing.
  const [text, setText] = useState<string>(() => isoToDisplay(value));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(isoToDisplay(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const commit = (next: string) => {
    const iso = displayToIso(next);
    if (iso && iso !== value) onChange(iso);
    else if (next === "" && value !== "") onChange("");
  };

  return (
    <div ref={rootRef} className={cn("relative flex items-center gap-1", className)}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={10}
        onChange={(e) => {
          const masked = maskDateInput(e.target.value);
          setText(masked);
          if (masked.length === 10) commit(masked);
        }}
        onBlur={() => {
          if (text === "") {
            commit("");
            return;
          }
          // Restore last good value if user blurs with malformed text.
          const iso = displayToIso(text);
          if (iso) {
            if (iso !== value) onChange(iso);
          } else {
            setText(isoToDisplay(value));
          }
        }}
        className="h-9 pe-9"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="Open calendar"
        className="absolute inset-e-0 size-9 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        <Calendar className="size-4" />
      </Button>
      {open && (
        <CalendarPopover
          value={value}
          align={align}
          onPick={(iso) => {
            onChange(iso);
            setText(isoToDisplay(iso));
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// 24-hour HH:MM input. Stores and emits the standard "HH:MM" string the
// backend expects on Meal.time / supplements time_taken / etc. Like
// DatePicker: type into the field (auto-masked), or click the clock icon for
// an hour / minute dropdown.
type TimeInputProps = {
  value: string;
  onChange: (hhmm: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
};

export function TimeInput({
  value,
  onChange,
  disabled,
  required,
  placeholder = "HH:MM",
  className,
  id,
  ariaLabel,
}: TimeInputProps) {
  const [text, setText] = useState<string>(() => formatTime24(value));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(formatTime24(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const commit = (next: string) => {
    if (next === "") {
      if (value !== "") onChange("");
      return;
    }
    if (isValidTime24(next)) {
      if (next !== value) onChange(next);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative flex items-center", className)}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={5}
        onChange={(e) => {
          const masked = maskTimeInput(e.target.value);
          setText(masked);
          if (masked.length === 5) commit(masked);
        }}
        onBlur={() => {
          if (text === "") {
            commit("");
            return;
          }
          if (isValidTime24(text)) {
            commit(text);
          } else {
            setText(formatTime24(value));
          }
        }}
        className="h-9 pe-8 tabular-nums"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="Open time picker"
        className="absolute inset-e-0 size-9 w-8 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        <Clock className="size-4" />
      </Button>
      {open && (
        <TimePopover
          value={value}
          onPick={(hhmm) => {
            onChange(hhmm);
            setText(hhmm);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// "DD-MM-YYYY HH:MM" in one field: date (ISO) + optional time (HH:MM) in, both
// out. Typing is auto-masked; the calendar icon opens the month grid with the
// hour / minute columns beside it, so date and time are picked in one place.
type DateTimePickerProps = {
  date: string;
  time: string;
  onChange: (date: string, time: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  ariaLabel?: string;
};

function dateTimeText(date: string, time: string): string {
  const d = isoToDisplay(date);
  return d && time ? `${d} ${formatTime24(time)}` : d;
}

// Digits only, re-punctuated as DD-MM-YYYY HH:MM while typing.
function maskDateTimeInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 12);
  let out = d.slice(0, 2);
  if (d.length > 2) out += "-" + d.slice(2, 4);
  if (d.length > 4) out += "-" + d.slice(4, 8);
  if (d.length > 8) out += " " + d.slice(8, 10);
  if (d.length > 10) out += ":" + d.slice(10, 12);
  return out;
}

export function DateTimePicker({
  date,
  time,
  onChange,
  disabled,
  className,
  id,
  ariaLabel,
}: DateTimePickerProps) {
  const [text, setText] = useState<string>(() => dateTimeText(date, time));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Fixed-position coordinates for the floating panel; null until measured.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    setText(dateTimeText(date, time));
  }, [date, time]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The panel floats in a portal on <body> at fixed coordinates, so a dialog's
  // scroll area can't clip it (or grow a horizontal scrollbar). Placed under
  // the field, flipped above when there's no room below, and clamped so it
  // always stays inside the viewport — on phones it can extend past the dialog.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const m = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const below = anchor.bottom + 4;
      const above = anchor.top - 4 - h;
      const top = below + h <= vh - m ? below : above >= m ? above : Math.max(m, vh - h - m);
      const left = Math.min(Math.max(anchor.left, m), Math.max(m, vw - w - m));
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Parse "DD-MM-YYYY" or "DD-MM-YYYY HH:MM"; null when malformed.
  const parse = (s: string): { date: string; time: string } | null => {
    const iso = displayToIso(s.slice(0, 10));
    if (!iso) return null;
    const rest = s.slice(11);
    if (rest === "") return { date: iso, time: "" };
    return isValidTime24(rest) ? { date: iso, time: rest } : null;
  };

  return (
    <div ref={rootRef} className={cn("relative flex items-center", className)}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        disabled={disabled}
        placeholder="DD-MM-YYYY HH:MM"
        aria-label={ariaLabel}
        maxLength={16}
        onChange={(e) => {
          const masked = maskDateTimeInput(e.target.value);
          setText(masked);
          const v = masked.length === 16 ? parse(masked) : null;
          if (v) onChange(v.date, v.time);
        }}
        onBlur={() => {
          const v = parse(text);
          if (v) {
            if (v.date !== date || v.time !== time) onChange(v.date, v.time);
          } else {
            setText(dateTimeText(date, time));
          }
        }}
        className="h-9 pe-9 tabular-nums"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="Open date and time picker"
        className="absolute inset-e-0 size-9 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        <Calendar className="size-4" />
      </Button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            // A modal dialog sets pointer-events: none on <body>; the panel
            // lives there, so it opts back in.
            className="pointer-events-auto fixed z-100 max-w-[calc(100vw-1rem)] rounded-md border border-primary bg-popover p-2 shadow-overlay soft:border-transparent"
            style={pos ?? { top: 0, left: 0, visibility: "hidden" }}
            role="dialog"
            aria-label="Pick a date and time"
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="w-61 max-w-full">
                <CalendarBody value={date} onPick={(iso) => onChange(iso, time)} />
              </div>
              <div className="w-61 max-w-full border-t pt-2 sm:w-28 sm:border-s sm:border-t-0 sm:ps-2 sm:pt-0">
                <div className="mb-1 flex items-center justify-center gap-1 text-xs font-medium text-muted-foreground">
                  <Clock className="size-3.5" />
                  {time ? formatTime24(time) : "--:--"}
                </div>
                <TimeColumns
                  value={time}
                  onPick={(hhmm) => onChange(date, hhmm)}
                  onMinute={() => setOpen(false)}
                  className="max-h-32 sm:max-h-52"
                />
              </div>
            </div>
            <div className="mt-1 flex justify-between border-t pt-1">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  onChange(toIsoLocal(new Date()), nowHHMM());
                  setOpen(false);
                }}
              >
                Now
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

// Two scrollable columns (hours, 5-minute steps). Picking an hour keeps the
// current minutes (or :00); picking minutes keeps the hour (or the current
// hour). Typing in the field still allows any exact minute.
function TimePopover({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (hhmm: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-e-0 top-full z-50 mt-1 w-38 rounded-md border border-primary bg-popover p-2 shadow-overlay soft:border-transparent"
      role="dialog"
      aria-label="Pick a time"
    >
      <TimeColumns value={value} onPick={onPick} onMinute={onClose} className="max-h-44" />
      <div className="mt-1 flex justify-between border-t pt-1">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => {
            onPick(nowHHMM());
            onClose();
          }}
        >
          Now
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
    </div>
  );
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Hour + 5-minute columns, shared by TimePopover and DateTimePicker. `onMinute`
// fires after a minute pick (the natural "done" moment). `className` sets the
// columns' height.
function TimeColumns({
  value,
  onPick,
  onMinute,
  className,
}: {
  value: string;
  onPick: (hhmm: string) => void;
  onMinute?: () => void;
  className?: string;
}) {
  const valid = isValidTime24(value);
  const hh = valid ? value.slice(0, 2) : null;
  const mm = valid ? value.slice(3, 5) : null;
  const hourCol = useRef<HTMLDivElement>(null);
  const minCol = useRef<HTMLDivElement>(null);

  // Bring the selected (or current) hour / nearest minute into view on open.
  useEffect(() => {
    const now = new Date();
    const h = hh ?? String(now.getHours()).padStart(2, "0");
    const m = mm ? String(Math.floor(Number(mm) / 5) * 5).padStart(2, "0") : "00";
    // Scroll only the column itself (scrollIntoView would also scroll the
    // surrounding dialog / page).
    const center = (col: HTMLDivElement | null, v: string) => {
      const el = col?.querySelector<HTMLElement>(`[data-v="${v}"]`);
      if (col && el) col.scrollTop = el.offsetTop - col.clientHeight / 2 + el.offsetHeight / 2;
    };
    center(hourCol.current, h);
    center(minCol.current, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A modal dialog's scroll lock (react-remove-scroll) cancels wheel / touch
  // scrolling it sees on document, which includes DateTimePicker's panel
  // portaled outside the dialog. Stopping those events at the column keeps
  // them from reaching that listener, so the column scrolls natively.
  useEffect(() => {
    const stop = (e: Event) => e.stopPropagation();
    const cols = [hourCol.current, minCol.current].filter((c): c is HTMLDivElement => c != null);
    for (const c of cols) {
      c.addEventListener("wheel", stop, { passive: true });
      c.addEventListener("touchmove", stop, { passive: true });
    }
    return () => {
      for (const c of cols) {
        c.removeEventListener("wheel", stop);
        c.removeEventListener("touchmove", stop);
      }
    };
  }, []);

  const nowHour = () => String(new Date().getHours()).padStart(2, "0");
  const cell = (active: boolean) =>
    cn(
      "h-7 w-full shrink-0 rounded-sm text-xs tabular-nums transition-colors",
      active
        ? "bg-primary text-primary-foreground hover:bg-primary/90 soft:bg-background soft:font-semibold soft:text-primary soft:shadow-pressed soft:hover:bg-background"
        : "hover:bg-accent",
    );

  const col = cn("relative flex flex-col gap-0.5 overflow-y-auto pe-0.5", className);
  return (
    <div className="grid grid-cols-2 gap-1">
      <div ref={hourCol} className={col}>
        {HOURS.map((h) => (
          <button
            key={h}
            type="button"
            data-v={h}
            className={cell(h === hh)}
            aria-pressed={h === hh}
            onClick={() => onPick(`${h}:${mm ?? "00"}`)}
          >
            {h}
          </button>
        ))}
      </div>
      <div ref={minCol} className={col}>
        {MINUTES.map((m) => (
          <button
            key={m}
            type="button"
            data-v={m}
            className={cell(m === mm)}
            aria-pressed={m === mm}
            onClick={() => {
              onPick(`${hh ?? nowHour()}:${m}`);
              onMinute?.();
            }}
          >
            :{m}
          </button>
        ))}
      </div>
    </div>
  );
}

// Custom month-grid calendar. Week starts Monday (matches dateRange.ts).
// All visible day buttons stay inside the popover so click-outside closing
// works cleanly via the parent's ref. `align` controls which edge the popover
// anchors to (default "right" matches the DatePicker's right-aligned trigger;
// "left" is for triggers near the left edge so the panel opens rightward;
// "center" sits it under the middle of the trigger). `selectWeek` highlights
// the whole Monday–Sunday week holding `value`, for picking a week.
export function CalendarPopover({
  value,
  onPick,
  onClose,
  align = "right",
  selectWeek = false,
}: {
  value: string;
  onPick: (iso: string) => void;
  onClose: () => void;
  align?: PopoverAlign;
  selectWeek?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={cn(
        "absolute top-full z-50 mt-1 w-65 rounded-md border border-primary bg-popover p-2 shadow-overlay soft:border-transparent",
        alignClass(align),
      )}
      role="dialog"
      aria-label="Pick a date"
    >
      <CalendarBody value={value} onPick={onPick} selectWeek={selectWeek} />
      <div className="mt-1 flex justify-between border-t pt-1">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onPick(toIsoLocal(new Date()))}
        >
          Today
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// Month header + day grid, shared by CalendarPopover and DateTimePicker.
function CalendarBody({
  value,
  onPick,
  selectWeek = false,
}: {
  value: string;
  onPick: (iso: string) => void;
  selectWeek?: boolean;
}) {
  const initial = useMemo(() => {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }, [value]);

  const [viewMonth, setViewMonth] = useState<Date>(
    new Date(initial.getFullYear(), initial.getMonth(), 1),
  );

  const grid = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const monthLabel = `${MONTH_LONG[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`;
  const todayIso = toIsoLocal(new Date());
  // Week mode: the selected Monday–Sunday span (ISO strings compare in order).
  const weekStart = selectWeek ? mondayOf(initial) : null;
  const weekFrom = weekStart ? toIsoLocal(weekStart) : null;
  const weekTo = weekStart
    ? toIsoLocal(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6))
    : null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))
          }
          aria-label="Previous month"
          className="size-7"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <div className="text-sm font-medium">{monthLabel}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))
          }
          aria-label="Next month"
          className="size-7"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] tracking-wide text-muted-foreground uppercase">
        {WEEKDAY_SHORT.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {grid.map((cell, i) => {
          const iso = toIsoLocal(cell.date);
          const isSelected = weekFrom && weekTo ? iso >= weekFrom && iso <= weekTo : iso === value;
          const isToday = iso === todayIso;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(iso)}
              className={cn(
                "h-7 rounded-sm text-xs transition-colors",
                cell.inMonth
                  ? "text-foreground hover:bg-accent"
                  : "text-muted-foreground/50 hover:bg-accent/60",
                isSelected &&
                  "bg-primary text-primary-foreground hover:bg-primary/90 soft:bg-background soft:font-semibold soft:text-primary soft:shadow-pressed soft:hover:bg-background",
                !isSelected &&
                  isToday &&
                  "font-semibold text-primary ring-1 ring-primary soft:shadow-control soft:ring-0",
              )}
              aria-pressed={isSelected}
              aria-label={iso}
            >
              {cell.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type PopoverAlign = "left" | "right" | "center";

function alignClass(align: PopoverAlign): string {
  if (align === "left") return "start-0";
  if (align === "center") return "left-1/2 -translate-x-1/2";
  return "end-0";
}

function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

// Month picker: a year header with prev/next and a 3-column grid of months.
// Picks the 1st of the chosen month as an ISO date. Same chrome as
// CalendarPopover.
export function MonthPopover({
  value,
  onPick,
  onClose,
  align = "center",
}: {
  value: string;
  onPick: (iso: string) => void;
  onClose: () => void;
  align?: PopoverAlign;
}) {
  const now = new Date();
  const valid = /^\d{4}-\d{2}/.test(value);
  const selYear = valid ? Number(value.slice(0, 4)) : now.getFullYear();
  const selMonth = valid ? Number(value.slice(5, 7)) - 1 : now.getMonth();
  const [viewYear, setViewYear] = useState(selYear);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (year: number, monthIdx: number) =>
    onPick(`${year}-${String(monthIdx + 1).padStart(2, "0")}-01`);

  return (
    <div
      className={cn(
        "absolute top-full z-50 mt-1 w-65 rounded-md border border-primary bg-popover p-2 shadow-overlay soft:border-transparent",
        alignClass(align),
      )}
      role="dialog"
      aria-label="Pick a month"
    >
      <div className="mb-1 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setViewYear(viewYear - 1)}
          aria-label="Previous year"
          className="size-7"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <div className="text-sm font-medium tabular-nums">{viewYear}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setViewYear(viewYear + 1)}
          aria-label="Next year"
          className="size-7"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {MONTH_LONG.map((name, i) => {
          const isSelected = viewYear === selYear && i === selMonth;
          const isCurrent = viewYear === now.getFullYear() && i === now.getMonth();
          return (
            <button
              key={name}
              type="button"
              onClick={() => pick(viewYear, i)}
              className={cn(
                "h-9 rounded-sm text-xs transition-colors hover:bg-accent",
                isSelected &&
                  "bg-primary text-primary-foreground hover:bg-primary/90 soft:bg-background soft:font-semibold soft:text-primary soft:shadow-pressed soft:hover:bg-background",
                !isSelected &&
                  isCurrent &&
                  "font-semibold text-primary ring-1 ring-primary soft:shadow-control soft:ring-0",
              )}
              aria-pressed={isSelected}
            >
              {name.slice(0, 3)}
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between border-t pt-1">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 text-xs"
          onClick={() => pick(now.getFullYear(), now.getMonth())}
        >
          This month
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type Cell = { date: Date; inMonth: boolean };

function buildMonthGrid(viewMonth: Date): Cell[] {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7; // Mon=0
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === viewMonth.getMonth() });
  }
  return cells;
}

function toIsoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
