import { useTranslation } from "react-i18next";
import {
  Footprints,
  Frame,
  Lock,
  PersonStanding,
  Repeat,
  Shirt,
  Smartphone,
  Sun,
  Wallpaper,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// Photo guidelines for the body scan. The measurements are only as good as
// the silhouette, and the silhouette is only as good as the photo: these are
// the things that most often break it (busy backgrounds, arms against the
// body, baggy clothes, the head or feet out of frame).

const TIPS = [
  { key: "background", Icon: Wallpaper },
  { key: "light", Icon: Sun },
  { key: "phone", Icon: Smartphone },
  { key: "frame", Icon: Frame },
  { key: "pose", Icon: PersonStanding },
  { key: "clothes", Icon: Shirt },
  { key: "barefoot", Icon: Footprints },
  { key: "repeat", Icon: Repeat },
] as const;

const SEEN_KEY = "fa.physique.guideSeen";

export function guideSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private mode: the guide just shows again next time.
  }
}

/** Side view of the setup: phone on a shelf at chest height, ~2.5 m, arms out. */
function SetupDiagram() {
  const { t } = useTranslation();
  return (
    <svg
      viewBox="0 0 300 150"
      className="w-full"
      role="img"
      aria-label={t("physique.guide.diagramAria")}
    >
      {/* floor */}
      <line
        x1="10"
        y1="138"
        x2="290"
        y2="138"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      {/* shelf + phone at chest height */}
      <line
        x1="34"
        y1="138"
        x2="34"
        y2="78"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="3"
      />
      <line
        x1="20"
        y1="78"
        x2="48"
        y2="78"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="3"
      />
      <rect x="36" y="52" width="10" height="24" rx="2" fill="#10b981" />
      {/* camera field of view */}
      <path
        d="M46 60 L232 8 M46 60 L232 140"
        stroke="#10b981"
        strokeOpacity="0.35"
        strokeDasharray="3 4"
        fill="none"
      />
      {/* distance */}
      <line
        x1="52"
        y1="148"
        x2="214"
        y2="148"
        stroke="currentColor"
        strokeOpacity="0.5"
        strokeWidth="1.2"
      />
      <path d="M52 148 l6 -3 v6 z M214 148 l-6 -3 v6 z" fill="currentColor" fillOpacity="0.5" />
      <text
        x="133"
        y="144"
        textAnchor="middle"
        fontSize="10"
        fill="currentColor"
        fillOpacity="0.75"
      >
        ~2.5 m
      </text>
      {/* person, front-on, arms ~20° out, feet hip-width */}
      <g stroke="currentColor" strokeWidth="5" strokeLinecap="round" fill="none">
        <circle cx="232" cy="30" r="9" fill="currentColor" stroke="none" />
        <line x1="232" y1="42" x2="232" y2="88" />
        <line x1="232" y1="48" x2="214" y2="94" />
        <line x1="232" y1="48" x2="250" y2="94" />
        <line x1="232" y1="88" x2="222" y2="136" />
        <line x1="232" y1="88" x2="242" y2="136" />
      </g>
      {/* 20° arc */}
      <path d="M232 70 A22 22 0 0 0 224 68" stroke="#10b981" strokeWidth="1.5" fill="none" />
      <text x="203" y="66" fontSize="9" fill="#10b981">
        20°
      </text>
      {/* chest-height guide */}
      <line
        x1="48"
        y1="64"
        x2="222"
        y2="64"
        stroke="currentColor"
        strokeOpacity="0.15"
        strokeDasharray="2 4"
      />
    </svg>
  );
}

export function GuideSheet({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex max-h-full w-full max-w-md flex-col rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl">
      <div className="space-y-1 p-5 pb-3">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-emerald-300/80 uppercase">
          {t("physique.guide.kicker")}
        </p>
        <p className="text-xl font-bold">{t("physique.guide.title")}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5">
        <div className="flex gap-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3">
          <Lock className="mt-0.5 size-4 shrink-0 text-emerald-300" />
          <div>
            <p className="text-sm font-semibold text-emerald-200">{t("physique.privacy.title")}</p>
            <p className="text-xs/relaxed text-emerald-100/75">{t("physique.privacy.body")}</p>
          </div>
        </div>
        <div className="rounded-xl bg-white/4 p-3 text-white">
          <SetupDiagram />
        </div>
        <ul className="space-y-3">
          {TIPS.map(({ key, Icon }) => (
            <li key={key} className="flex gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
                <Icon className="size-4.5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t(`physique.guide.tips.${key}.title`)}</p>
                <p className="text-xs/relaxed text-white/60">
                  {t(`physique.guide.tips.${key}.body`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="p-5 pt-4">
        <Button
          className="w-full"
          onClick={() => {
            markSeen();
            onDone();
          }}
        >
          {t("physique.guide.done")}
        </Button>
      </div>
    </div>
  );
}
