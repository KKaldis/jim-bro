import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolOverrideProps } from "./overrides";

type Option = {
  value?: string;
  label?: string;
  emoji?: string;
};

type AskUserMultiInput = {
  question?: string;
  options?: Option[];
  choices?: string[];
};

// Self-submitting multi-select sibling of AskUserForm. The user toggles any
// number of options (checkbox-style pills tracked in `choices`), then clicks
// Confirm to commit them through the gate in one shot. Unlike ask_user, the
// click on an option doesn't submit — only Confirm does, so the user can build
// up a set. After submission the picks stay highlighted and everything goes
// disabled so the card reads cleanly in chat history.
export function AskUserMultiForm({ value, disabled, onChange, onSubmit }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const data = (value as AskUserMultiInput) ?? {};
  const options = Array.isArray(data.options) ? data.options : [];
  // Once the gate is resolved the override is rendered disabled — that's our
  // signal to show the committed selection as read-only.
  const committed = disabled;
  const selected = new Set(Array.isArray(data.choices) ? data.choices : []);

  const toggle = (opt: Option) => {
    if (!opt.value || disabled) return;
    const next = new Set(selected);
    if (next.has(opt.value)) next.delete(opt.value);
    else next.add(opt.value);
    // Emit in option order so the model gets a stable, predictable shape.
    const choices = options.map((o) => o.value).filter((v): v is string => !!v && next.has(v));
    onChange({ ...data, choices });
  };

  const confirm = () => {
    if (disabled) return;
    onSubmit?.({ ...data, choices: Array.from(selected) });
  };

  return (
    <div className="space-y-3">
      {data.question && <p className="text-sm/snug font-medium">{data.question}</p>}
      <div className="flex flex-col gap-2">
        {options.map((opt, i) => {
          const isPicked = opt.value != null && selected.has(opt.value);
          return (
            <Button
              key={opt.value ?? `opt-${i}`}
              type="button"
              variant={isPicked ? "default" : "outline"}
              size="sm"
              disabled={disabled}
              aria-pressed={isPicked}
              onClick={() => toggle(opt)}
              className={cn(
                "h-auto min-h-8 w-full justify-start gap-1.5 py-1.5 text-start whitespace-normal",
                committed && !isPicked && "opacity-40",
              )}
            >
              {isPicked && <Check className="size-3.5 shrink-0" />}
              {opt.emoji && <span aria-hidden>{opt.emoji}</span>}
              <span className="wrap-break-word">
                {opt.label ?? opt.value ?? tr("formsAdmin.ask.unnamed")}
              </span>
            </Button>
          );
        })}
      </div>
      {!committed && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {selected.size === 0
              ? tr("formsAdmin.ask.selectAnyThatApply")
              : tr("formsAdmin.ask.selectedCount", { count: selected.size })}
          </span>
          <Button type="button" size="sm" disabled={disabled} onClick={confirm} className="gap-1.5">
            <Check className="size-3.5" />
            {tr("common.confirm")}
          </Button>
        </div>
      )}
    </div>
  );
}
