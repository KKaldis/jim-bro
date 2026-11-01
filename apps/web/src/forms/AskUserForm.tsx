import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolOverrideProps } from "./overrides";

type Option = {
  value?: string;
  label?: string;
  emoji?: string;
};

type AskUserInput = {
  question?: string;
  options?: Option[];
  choice?: string;
};

// Self-submitting override: clicking a button immediately commits the choice
// through the gate (no Save/Cancel footer). After submission, the picked
// option is highlighted and the buttons go disabled so the card stays
// readable in chat history.
export function AskUserForm({ value, disabled, onSubmit }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const data = (value as AskUserInput) ?? {};
  const options = Array.isArray(data.options) ? data.options : [];
  const picked = data.choice;

  const pick = (opt: Option) => {
    if (!opt.value || disabled) return;
    onSubmit?.({ ...data, choice: opt.value });
  };

  return (
    <div className="space-y-3">
      {data.question && <p className="text-sm/snug font-medium">{data.question}</p>}
      <div className="flex flex-col gap-2">
        {options.map((opt, i) => {
          const isPicked = picked != null && opt.value === picked;
          const isOtherPicked = picked != null && !isPicked;
          return (
            <Button
              key={opt.value ?? `opt-${i}`}
              type="button"
              variant={isPicked ? "default" : "outline"}
              size="sm"
              disabled={disabled || isOtherPicked}
              onClick={() => pick(opt)}
              className={cn(
                "h-auto min-h-8 w-full justify-start gap-1.5 py-1.5 text-start whitespace-normal",
                isOtherPicked && "opacity-40",
              )}
            >
              {opt.emoji && <span aria-hidden>{opt.emoji}</span>}
              <span className="wrap-break-word">
                {opt.label ?? opt.value ?? tr("formsAdmin.ask.unnamed")}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
