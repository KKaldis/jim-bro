import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Ruler } from "lucide-react";
import { Button } from "@/components/ui/button";
import { patchMeProfile } from "@/api/endpoints/default/default";
import { invalidateFormContext } from "@/forms/formContext";
import type { Subject } from "./analyse";

// Asked before scanning when the profile has no height (or sex): the height is
// the scan's only ruler — silhouette pixels ÷ real height = cm per pixel — so
// without it every width stays a pixel count. Saved to the profile by default
// so the next scan (and the calculators) already have it.

const MIN_CM = 120;
const MAX_CM = 230;

export function SubjectGate({
  subject,
  onDone,
  onSkip,
}: {
  subject: Subject;
  onDone: (s: { sex: "male" | "female"; heightCm: number }) => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [sex, setSex] = useState<"male" | "female" | null>(subject.sex);
  const [height, setHeight] = useState(subject.heightCm ? String(subject.heightCm) : "");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);

  const h = Number(height);
  const valid = sex != null && Number.isFinite(h) && h >= MIN_CM && h <= MAX_CM;

  const submit = async () => {
    if (!valid || !sex) return;
    setBusy(true);
    if (save) {
      try {
        await patchMeProfile({ sex, height_cm: h });
        invalidateFormContext();
      } catch {
        // Still scan with the typed values; the profile can be set later.
      }
    }
    setBusy(false);
    onDone({ sex, heightCm: h });
  };

  return (
    <form
      className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-neutral-900/95 p-5 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
          <Ruler className="size-5" />
        </span>
        <div>
          <p className="font-semibold">{t("physique.gate.title")}</p>
          <p className="text-sm text-white/60">{t("physique.gate.why")}</p>
        </div>
      </div>

      {!subject.sex && (
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1">
          {(["male", "female"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSex(s)}
              aria-pressed={sex === s}
              className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                sex === s ? "bg-white text-black" : "text-white/70 hover:text-white"
              }`}
            >
              {t(`physique.gate.${s}`)}
            </button>
          ))}
        </div>
      )}

      <label className="block space-y-1.5">
        <span className="text-xs tracking-wide text-white/60 uppercase">
          {t("physique.gate.height")}
        </span>
        <div className="flex items-center rounded-xl border border-white/15 bg-white/5 px-3 focus-within:border-emerald-400">
          <input
            type="number"
            inputMode="decimal"
            min={MIN_CM}
            max={MAX_CM}
            step={0.5}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            placeholder="178"
            autoFocus={!!subject.sex}
            className="w-full bg-transparent py-3 text-2xl font-semibold tabular-nums outline-none placeholder:text-white/25"
          />
          <span className="text-white/50">cm</span>
        </div>
      </label>

      <label className="flex items-center gap-2 text-sm text-white/70">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => setSave(e.target.checked)}
          className="size-4 accent-emerald-500"
        />
        {t("physique.gate.save")}
      </label>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          className="text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onSkip}
        >
          {t("physique.gate.skip")}
        </Button>
        <Button type="submit" className="flex-1" disabled={!valid || busy}>
          {t("physique.gate.start")}
        </Button>
      </div>
    </form>
  );
}
