import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { getResultCard } from "../cards/resultCards";
import { categoryMeta, categoryOf } from "../lib/toolCategory";
import { useFormContext } from "../forms/formContext";
import { cn } from "../lib/utils";
import { CalcFieldControl, type CalcValues } from "./fields";
import type { Calculator } from "./registry";
import type { Units } from "./units";

// One manual calculator: a collapsed header row that expands to reveal prefilled
// editable inputs and the live result card. Every edit recomputes synchronously
// via the calculator's shared-math adapter (no agent, no save) and re-renders the
// SAME result card the chat draws for that tool. Inputs are seeded from the
// user's profile but fully editable — change any of them to run the numbers for
// a different scenario (or another person). When the inputs are incomplete the
// adapter returns null and we show a hint instead of a card.
export function CalculatorCard({ calc }: { calc: Calculator }) {
  const { t } = useTranslation();
  const { ctx, ready } = useFormContext();
  const units: Units = ctx.profile?.units === "imperial" ? "imperial" : "metric";

  // Collapsed by default — the page is a scannable list; open one to use it.
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CalcValues>({});
  // Seed from the profile + last weigh-in, and RE-seed whenever that context
  // changes (a late load, or a profile / weigh-in written from chat while this
  // page is open) — but only the fields the user hasn't touched, so their own
  // edits are never clobbered. Seeding just once used to leave frame fields
  // (wrist / ankle) empty whenever the profile arrived after the first seed.
  const touchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ready) return;
    const seed = calc.prefill(ctx, units);
    setValues((v) => {
      const next = { ...v };
      for (const [k, val] of Object.entries(seed)) {
        if (val !== undefined && !touchedRef.current.has(k)) next[k] = val;
      }
      return next;
    });
  }, [ready, ctx, units, calc]);

  const setField = (id: string, next: number | string | undefined) => {
    touchedRef.current.add(id);
    setValues((v) => ({ ...v, [id]: next }));
  };

  // Adapters throw on out-of-range inputs (mirroring the shared validators); a
  // throw just means "not ready yet", so fall back to the hint.
  const data = useMemo(() => {
    try {
      return calc.compute(values, units);
    } catch {
      return null;
    }
  }, [values, units, calc]);

  const ResultCard = getResultCard(calc.toolName);
  const category = categoryOf(calc.toolName);
  const { Icon, iconClass } = categoryMeta(category);

  const fields = calc.fields.filter((f) => !f.visible || f.visible(values));

  // Result node: a calculator's bespoke renderer (renderResult) wins; otherwise
  // the chat result card for its tool. Null when inputs are incomplete or the
  // card declines to render — then we show the fill-in hint.
  const resultNode =
    data == null ? null : calc.renderResult ? (
      calc.renderResult(data, t, units)
    ) : ResultCard ? (
      <ResultCard data={data} category={category} />
    ) : null;

  return (
    <div className="rounded-xl border bg-muted/20 soft:border-transparent soft:bg-background soft:shadow-tile brutal:border-2 brutal:border-edge brutal:bg-card brutal:shadow-tile">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl p-3 text-start transition-colors hover:bg-muted/40 sm:p-4 soft:hover:bg-transparent soft:hover:text-primary brutal:hover:bg-accent"
      >
        <Icon aria-hidden className={cn("size-4 shrink-0", iconClass)} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t(calc.titleKey)}</span>
          {!open && calc.descKey && (
            <span className="block truncate text-xs text-muted-foreground">{t(calc.descKey)}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-4 px-3 pb-3 sm:px-4 sm:pb-4">
          {calc.descKey && (
            <p className="text-xs/relaxed text-muted-foreground">{t(calc.descKey)}</p>
          )}

          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <div key={f.id} className={cn(f.full && "col-span-2")}>
                <CalcFieldControl
                  field={f}
                  value={values[f.id]}
                  units={units}
                  onChange={(next) => setField(f.id, next)}
                />
              </div>
            ))}
          </div>

          {resultNode ?? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              {t("calculators.fillIn")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
