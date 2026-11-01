import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Languages, Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { patchMeProfile } from "../api/endpoints/default/default";
import { LANGUAGES, type Language } from "../i18n";
import { brand } from "../lib/brand";
import { useChatBridge } from "../lib/chatBridge";
import {
  useUiStore,
  type BodySection,
  type NutritionSection,
  type View,
  type WorkoutSection,
} from "../lib/uiStore";
import { cn } from "../lib/utils";

// First-run app tour: a coach-mark walkthrough that spotlights the real UI
// (composer, day picker, user menu, then every screen and sub-tab) and explains
// how the app works. Screen steps switch the data view and sub-tab themselves
// (raising the data drawer on mobile); the user's view and tabs are restored
// when the tour closes. Anchors are plain `data-tour="<id>"` attributes on the target
// elements. Mobile and desktop render different copies of several of them (the
// coach bar vs the chat panel composer, the bottom nav vs the header nav), so
// each step spotlights the first VISIBLE match. A step without a visible target
// falls back to a centered card, so a layout change never strands the tour.
//
// Auto-opens once per new account on this device (see `tourSeenBy` in the UI
// store); the user menu can replay it any time.

type Step = {
  id: string;
  // data-tour anchor to spotlight; omitted for centered, explanatory steps.
  target?: string;
  // A second anchor lit alongside the target — the primary-nav item a sub-tab
  // belongs to, so the user sees both levels (Food › Pantry). The card is
  // placed against `target`.
  also?: string;
  // Data screen (and sub-tab) to show behind the step. Steps without one show
  // the chat — on mobile that means the data drawer is closed, so the header
  // anchors (day picker, user menu) aren't covered.
  screen?: {
    view: View;
    nutrition?: NutritionSection;
    workout?: WorkoutSection;
    body?: BodySection;
  };
  // i18n key of the screen name shown above the title, grouping its sub-tabs.
  group?: string;
};

const STEPS: Step[] = [
  { id: "welcome" },
  { id: "chat", target: "composer" },
  { id: "confirm" },
  { id: "day", target: "day" },
  { id: "menu", target: "menu" },
  { id: "screens", target: "nav" },
  {
    id: "dashboard",
    target: "nav-dashboard",
    screen: { view: "dashboard" },
    group: "nav.dashboard",
  },
  {
    id: "foodLog",
    target: "nutrition-summary",
    also: "nav-nutrition",
    screen: { view: "nutrition", nutrition: "summary" },
    group: "nav.food",
  },
  {
    id: "pantry",
    target: "nutrition-pantry",
    also: "nav-nutrition",
    screen: { view: "nutrition", nutrition: "pantry" },
    group: "nav.food",
  },
  {
    id: "recipes",
    target: "nutrition-recipes",
    also: "nav-nutrition",
    screen: { view: "nutrition", nutrition: "recipes" },
    group: "nav.food",
  },
  {
    id: "diet",
    target: "nutrition-diet",
    also: "nav-nutrition",
    screen: { view: "nutrition", nutrition: "diet" },
    group: "nav.food",
  },
  {
    id: "training",
    target: "workout-training",
    also: "nav-workout",
    screen: { view: "workout", workout: "training" },
    group: "nav.workout",
  },
  {
    id: "progress",
    target: "workout-progress",
    also: "nav-workout",
    screen: { view: "workout", workout: "progress" },
    group: "nav.workout",
  },
  {
    id: "plans",
    target: "workout-plans",
    also: "nav-workout",
    screen: { view: "workout", workout: "plans" },
    group: "nav.workout",
  },
  {
    id: "bodyComposition",
    target: "body-composition",
    also: "nav-body",
    screen: { view: "body", body: "composition" },
    group: "nav.body",
  },
  {
    id: "bodyMeasurements",
    target: "body-measurements",
    also: "nav-body",
    screen: { view: "body", body: "measurements" },
    group: "nav.body",
  },
  { id: "finish" },
];

// Accounts younger than this get the tour automatically; older accounts that
// log in on a new device don't, since they already know their way around.
const NEW_ACCOUNT_MS = 14 * 24 * 60 * 60 * 1000;

const PAD = 6; // spotlight padding around the target
const GAP = 12; // space between spotlight and card
const MARGIN = 12; // minimum distance from the viewport edges

type Rect = { top: number; left: number; width: number; height: number };

function findTarget(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

function measure(id: string): Rect | null {
  const el = findTarget(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r.top - PAD,
    left: r.left - PAD,
    width: r.width + PAD * 2,
    height: r.height + PAD * 2,
  };
}

// Spotlight rects for a step: the main target first (the card anchors to it),
// then the companion. Anchors that aren't on screen are dropped.
function measureStep(step: Step): Rect[] {
  return [step.target, step.also]
    .filter((id): id is string => !!id)
    .map(measure)
    .filter((r): r is Rect => !!r);
}

// Place the card below the spotlight when it fits, else above, else pinned to
// the bottom of the viewport. Horizontally it follows the target, clamped to
// the viewport.
function placeCard(
  rect: Rect | null,
  card: { width: number; height: number },
): { top: number; left: number } | null {
  if (!rect) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - card.width / 2, MARGIN),
    vw - card.width - MARGIN,
  );
  const below = rect.top + rect.height + GAP;
  if (below + card.height <= vh - MARGIN) return { top: below, left };
  const above = rect.top - GAP - card.height;
  if (above >= MARGIN) return { top: above, left };
  return { top: Math.max(vh - card.height - MARGIN, MARGIN), left };
}

export function AppTour({ userId, createdAt }: { userId: string; createdAt?: Date | string }) {
  const open = useUiStore((s) => s.tourOpen);
  const seen = useUiStore((s) => s.tourSeenBy.includes(userId));
  const startTour = useUiStore((s) => s.startTour);
  const chatReady = useChatBridge((s) => s.ready);

  // Auto-start for new accounts, once the chat (and so the composer anchor) has
  // mounted — the screens are lazy-loaded, so starting earlier would spotlight
  // nothing.
  useEffect(() => {
    if (seen || !chatReady) return;
    const created = createdAt ? new Date(createdAt).getTime() : NaN;
    if (Number.isFinite(created) && Date.now() - created > NEW_ACCOUNT_MS) return;
    const timer = window.setTimeout(startTour, 600);
    return () => window.clearTimeout(timer);
  }, [seen, chatReady, createdAt, startTour]);

  if (!open) return null;
  return <TourOverlay userId={userId} />;
}

// Language switch on the welcome card, so a user who landed in the wrong
// language can fix it before reading the tour. Same flow as Settings: flip the
// UI store (and i18next) at once, persist to the profile fire-and-forget.
function TourLanguageSelect() {
  const { t } = useTranslation();
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  return (
    <Select
      value={language}
      onValueChange={(v) => {
        const next = v as Language;
        setLanguage(next);
        void patchMeProfile({ language: next });
      }}
    >
      <SelectTrigger className="h-8 w-auto gap-1.5 px-2 text-xs" aria-label={t("tour.language")}>
        <Languages className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      {/* Above the tour overlay (z-[70]); the default popover layer is z-50. */}
      <SelectContent className="z-80">
        {LANGUAGES.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TourOverlay({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const endTour = useUiStore((s) => s.endTour);
  const requestProfile = useUiStore((s) => s.requestProfile);
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const [rects, setRects] = useState<Rect[]>([]);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });

  // Track the target's position: on step change, resize, scroll, and briefly
  // after (lazy content and the mobile coach bar can shift the layout).
  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRects(measureStep(step)));
    };
    setRects(measureStep(step));
    const settle = window.setInterval(update, 250);
    const stopSettle = window.setTimeout(() => window.clearInterval(settle), 1500);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(settle);
      window.clearTimeout(stopSettle);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setCardSize({ width: el.offsetWidth, height: el.offsetHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
    // The card is re-keyed per step, so observe the new element each time.
  }, [step.id]);

  useEffect(() => {
    primaryRef.current?.focus();
  }, [index]);

  // Show the step's screen. Snapshot the user's view + tabs on open and put
  // them back on close, so the tour doesn't leave them somewhere unexpected.
  useEffect(() => {
    const { view, nutritionSection, workoutSection, bodySection } = useUiStore.getState();
    return () => {
      const s = useUiStore.getState();
      s.setView(view);
      s.setNutritionSection(nutritionSection);
      s.setWorkoutSection(workoutSection);
      s.setBodySection(bodySection);
    };
  }, []);
  useEffect(() => {
    const s = useUiStore.getState();
    const screen = step.screen;
    s.setTourDrawer(!!screen);
    if (!screen) return;
    s.setView(screen.view);
    if (screen.nutrition) s.setNutritionSection(screen.nutrition);
    if (screen.workout) s.setWorkoutSection(screen.workout);
    if (screen.body) s.setBodySection(screen.body);
  }, [step]);

  const finish = useCallback(() => endTour(userId), [endTour, userId]);
  const next = useCallback(() => (last ? finish() : setIndex((i) => i + 1)), [last, finish]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Leave keys to the welcome step's language dropdown while it has focus.
      if ((e.target as HTMLElement | null)?.closest?.('[role="combobox"],[role="listbox"]')) return;
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, next, back]);

  const pos = placeCard(rects[0] ?? null, cardSize);
  const vars = { agent: brand.agentName, brand: brand.name };

  return (
    <div
      className="fixed inset-0 z-70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-tour-title"
      aria-describedby="app-tour-body"
    >
      {/* Click shield + dimming. With targets, an SVG mask cuts one hole per
          spotlight so the targets themselves stay undimmed. */}
      <div className={cn("absolute inset-0", !rects.length && "bg-black/60")} />
      {rects.length > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
          <defs>
            <mask id="app-tour-mask">
              <rect width="100%" height="100%" fill="white" />
              {rects.map((r, i) => (
                <rect
                  key={i}
                  rx={12}
                  fill="black"
                  className="transition-all duration-300 ease-out"
                  style={{ x: r.left, y: r.top, width: r.width, height: r.height }}
                />
              ))}
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgb(0 0 0 / 0.6)" mask="url(#app-tour-mask)" />
        </svg>
      )}
      {rects.map((r, i) => (
        <div
          key={i}
          aria-hidden
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary transition-all duration-300 ease-out"
          style={r}
        />
      ))}

      <div
        ref={cardRef}
        className={cn(
          "absolute w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-edge bg-background p-4 shadow-overlay",
          "animate-in duration-200 fade-in-0 zoom-in-95",
          !pos && "top-1/2 left-1/2 -translate-1/2",
        )}
        style={pos ?? undefined}
        // Re-key per step so the enter animation replays.
        key={step.id}
      >
        {(step.id === "welcome" || step.id === "finish") && (
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="grid size-10 place-items-center rounded-full bg-primary/15 text-primary">
              <Sparkles className="size-5" />
            </div>
            {step.id === "welcome" && <TourLanguageSelect />}
          </div>
        )}
        {step.group && (
          <p className="mb-1 text-xs font-medium tracking-wide text-primary uppercase">
            {t(step.group)}
          </p>
        )}
        <h2 id="app-tour-title" className="text-base font-semibold">
          {t(`tour.steps.${step.id}.title`, vars)}
        </h2>
        <p id="app-tour-body" className="mt-1.5 text-sm text-muted-foreground">
          {t(`tour.steps.${step.id}.body`, vars)}
        </p>

        <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${((index + 1) / STEPS.length) * 100}%` }}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex-1 text-xs text-muted-foreground tabular-nums">
            <span aria-hidden>
              {index + 1} / {STEPS.length}
            </span>
            <span className="sr-only">
              {t("tour.progress", { current: index + 1, total: STEPS.length })}
            </span>
          </span>
          {!last && (
            <Button variant="ghost" size="sm" onClick={finish}>
              {t("tour.skip")}
            </Button>
          )}
          {index > 0 && (
            <Button variant="ghost" size="icon" onClick={back} aria-label={t("tour.back")}>
              <ArrowLeft />
            </Button>
          )}
          {last ? (
            <>
              <Button variant="outline" size="sm" onClick={finish}>
                {t("tour.done")}
              </Button>
              <Button
                ref={primaryRef}
                size="sm"
                onClick={() => {
                  finish();
                  requestProfile();
                }}
              >
                {t("tour.setUpProfile")}
              </Button>
            </>
          ) : (
            <Button ref={primaryRef} size="sm" onClick={next}>
              {index === 0 ? t("tour.start") : t("tour.next")}
              <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
