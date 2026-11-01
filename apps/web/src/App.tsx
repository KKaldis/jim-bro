import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dumbbell,
  HeartPulse,
  LayoutDashboard,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "./auth.ts";
import { AvatarSprite } from "./avatar-sprite.tsx";
import { InstallToast } from "./InstallToast.tsx";
import { AppTour } from "./components/AppTour.tsx";

// Code-split every screen so the initial bundle is just the app shell (header,
// nav, auth gate). Each screen — and its form/chart dependencies — loads on
// first navigation to it. Named exports are adapted to lazy's default-export
// contract via the `.then` mapping below.
const Login = lazy(() => import("./Login.tsx").then((m) => ({ default: m.Login })));
const ResetPassword = lazy(() =>
  import("./ResetPassword.tsx").then((m) => ({ default: m.ResetPassword })),
);
const Chat = lazy(() => import("./Chat.tsx").then((m) => ({ default: m.Chat })));
const Dashboard = lazy(() => import("./Dashboard.tsx").then((m) => ({ default: m.Dashboard })));
const Nutrition = lazy(() => import("./Nutrition.tsx").then((m) => ({ default: m.Nutrition })));
const Body = lazy(() => import("./Body.tsx").then((m) => ({ default: m.Body })));
const Workout = lazy(() => import("./Workout.tsx").then((m) => ({ default: m.Workout })));
const Calculators = lazy(() =>
  import("./Calculators.tsx").then((m) => ({ default: m.Calculators })),
);
const Usage = lazy(() => import("./Usage.tsx").then((m) => ({ default: m.Usage })));
import { UserMenu } from "./UserMenu.tsx";
import { BrandMark } from "./BrandMark.tsx";
import { DayContextBadge } from "./DayContextBadge.tsx";
import { ChatDock } from "./components/ChatDock.tsx";
import { Button } from "./components/ui/button";
import { FlexLoader } from "./components/FlexLoader";
import { useDayContext } from "./lib/dayContext";
import { useMinLoading } from "./lib/useMinLoading";
import { LanguageSync } from "./lib/useLanguageSync";
import { useUiStore, type View } from "./lib/uiStore";
import { cn } from "./lib/utils";
import { navBarSoftBottom, navBarSoftTop, navItemBase, navItemClass } from "./lib/navItem";

// Label is a translation key resolved at render (t(labelKey)) so the nav
// re-labels itself when the language changes.
const VIEWS: Array<{ id: View; labelKey: string; Icon: LucideIcon }> = [
  { id: "dashboard", labelKey: "nav.dashboard", Icon: LayoutDashboard },
  { id: "nutrition", labelKey: "nav.food", Icon: UtensilsCrossed },
  { id: "workout", labelKey: "nav.workout", Icon: Dumbbell },
  { id: "body", labelKey: "nav.body", Icon: HeartPulse },
];

// The mobile primary nav. Rendered twice: as the fixed bar over the chat
// (drawer closed) and stacked at the bottom of the open data drawer — there it
// sits beneath the page's secondary sub-nav so both levels stay reachable
// without closing the drawer. `activeView` is null in the fixed/chat context
// (nothing is "on screen" yet) so no tab reads as selected there.
function PrimaryNav({
  activeView,
  onSelect,
  className,
}: {
  activeView: View | null;
  onSelect: (v: View) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <nav
      className={cn(
        // No safe-area inset here — the coach bar sits below this nav and the
        // wrapping chrome carries the inset.
        "flex h-18 items-stretch border-t bg-background/95 py-3.5 backdrop-blur-sm supports-backdrop-filter:bg-background/80",
        navBarSoftTop,
        className,
      )}
      aria-label={t("nav.primary")}
      data-tour="nav"
    >
      {VIEWS.map((v) => {
        const active = activeView === v.id;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id)}
            className="group flex flex-1 flex-col items-center justify-center gap-1"
            data-tour={`nav-${v.id}`}
            aria-current={active ? "page" : undefined}
          >
            <span
              className={cn(
                "flex h-7 w-12 items-center justify-center",
                navItemBase,
                navItemClass(active, "group"),
              )}
            >
              <v.Icon className="size-4.5" />
            </span>
            <span
              className={cn(
                "text-[10px] leading-none font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              {t(v.labelKey)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// Suspense fallback for lazily-loaded screens: a centered flexing arm that fills
// whatever panel the screen would occupy, so chunk-loading never collapses the
// layout.
function ScreenFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <FlexLoader className="size-12" label={t("common.loading")} />
    </div>
  );
}

export function App() {
  // Reset-password flow lives at the root with `?reset-password=true` (plus
  // Better Auth's appended `token` / `error`) so the SW serves the precached
  // shell normally — no dedicated path, no navigateFallback gymnastics.
  if (new URLSearchParams(window.location.search).get("reset-password") === "true") {
    return (
      <main className="min-h-screen">
        <Suspense fallback={<ScreenFallback />}>
          <ResetPassword />
        </Suspense>
      </main>
    );
  }
  return <AppInner />;
}

function AppInner() {
  const { t } = useTranslation();
  const { data: session, isPending } = useSession();
  const showAuthLoader = useMinLoading(isPending);
  // Last primary screen is persisted in the UI store, so reopening the app
  // returns to where the user left off instead of always Dashboard.
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const [dataDrawerOpen, setDataDrawerOpen] = useState(false);
  const queryClient = useQueryClient();
  // Called at the end of every assistant turn (and after a profile save):
  // invalidate the React Query cache so every data screen does a background
  // refetch that keeps stale data on screen — no full-screen flash (FIXES #6).
  // Stable ref so the Chat sibling keeps its memoization on no-mutation turns.
  const invalidateData = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);
  // Selected day is shared across every data screen (Dashboard, Nutrition,
  // Workout, Body) via DayContext. Chat reads it too so context_date follows
  // the user's frame of reference no matter which screen they're on.
  const { selectedDateIso, isToday, setSelectedDateIso } = useDayContext();
  const chatContextDate = isToday ? null : selectedDateIso;
  // Sync the shared selected day with the agent's frame of reference:
  // when get_todays_macros fires with an explicit `date`, the chat emits a
  // view_date_hint event and we follow it here.
  const handleAgentViewDate = useCallback(
    (iso: string) => {
      setSelectedDateIso(iso);
    },
    [setSelectedDateIso],
  );
  // Agent-driven sub-tab navigation. show_screen may carry an optional `tab`
  // (e.g. workout → plans). We bump `key` on every navigation so a repeat
  // request to the same tab still re-fires the target page's sync effect even
  // when the tab string is unchanged. Only the page matching `view` reads it.
  const [navTab, setNavTab] = useState<{
    view: View;
    tab: string;
    key: number;
  } | null>(null);
  // Agent-driven navigation: the show_screen tool emits a show_screen event
  // and we switch the data view here. Below md the data panel only exists
  // inside the drawer, so open it too; on desktop it's already visible.
  const handleShowScreen = useCallback(
    (screen: string, tab?: string) => {
      if (!VIEWS.some((v) => v.id === screen)) return;
      const next = screen as View;
      setView(next);
      if (tab) {
        setNavTab((prev) => ({ view: next, tab, key: (prev?.key ?? 0) + 1 }));
      }
      if (!window.matchMedia("(min-width: 768px)").matches) {
        setDataDrawerOpen(true);
      }
      // setView is a stable Zustand setter; setNavTab/setDataDrawerOpen are stable
      // useState setters.
    },
    [setView],
  );

  // Calculators and AI usage live in the user menu (not the primary apps nav).
  // Selecting one switches the data view and, on mobile, raises the data drawer
  // over the chat.
  const openMenuView = useCallback(
    (next: View) => {
      setView(next);
      if (!window.matchMedia("(min-width: 768px)").matches) setDataDrawerOpen(true);
    },
    [setView],
  );
  // Same, for views requested from elsewhere (e.g. the out-of-tokens CTA).
  const viewRequest = useUiStore((s) => s.viewRequest);
  useEffect(() => {
    if (viewRequest) openMenuView(viewRequest.view);
  }, [viewRequest, openMenuView]);
  // The app tour walks between the chat chrome and the data screens; on mobile
  // the data drawer follows each step (closed for the header/chat steps, which
  // it would cover). Closing the tour drops back to the chat.
  const tourOpen = useUiStore((s) => s.tourOpen);
  const tourDrawer = useUiStore((s) => s.tourDrawer);
  useEffect(() => {
    setDataDrawerOpen(tourOpen && tourDrawer && !window.matchMedia("(min-width: 768px)").matches);
  }, [tourOpen, tourDrawer]);

  if (showAuthLoader) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6">
        <FlexLoader className="size-16" />
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="min-h-screen">
        <Suspense fallback={<ScreenFallback />}>
          <Login />
        </Suspense>
      </main>
    );
  }

  const user = session.user;

  // Mobile primary-nav tap: open the chosen data view, or — if it's already
  // the open view — collapse the panel back to the chat. Tapping the active
  // tab again is the way back, since the panel no longer covers the nav.
  const handlePrimaryNav = (next: View) => {
    if (dataDrawerOpen && view === next) {
      setDataDrawerOpen(false);
      return;
    }
    setView(next);
    setDataDrawerOpen(true);
  };

  const dataContent = (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <Suspense fallback={<ScreenFallback />}>
        {view === "dashboard" && <Dashboard />}
        {view === "nutrition" && (
          <Nutrition navTab={navTab?.view === "nutrition" ? navTab : null} />
        )}
        {view === "workout" && <Workout navTab={navTab?.view === "workout" ? navTab : null} />}
        {view === "body" && <Body navTab={navTab?.view === "body" ? navTab : null} />}
        {view === "calculators" && <Calculators />}
        {view === "usage" && <Usage />}
      </Suspense>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* Hidden <symbol> sprite for the chat avatars — referenced via <use> so
          the ~10KB path data is loaded once, not re-fetched per message. */}
      <AvatarSprite />
      {/* z-35: above the chat's floating thinking/reset drawer handle (z-30)
          so the mobile day-context calendar popover — trapped in this header's
          stacking context — isn't covered by it, yet below the full-screen
          mobile overlays (data panel / nav z-40, ChatDock z-50). */}
      <header
        className={cn(
          "sticky top-0 z-35 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur-sm supports-backdrop-filter:bg-background/80 sm:px-5",
          navBarSoftBottom,
        )}
      >
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <BrandMark variant="header" />
        </div>
        {/* Chat day-context picker, hoisted into the header on mobile and
            centered between the brand and the user menu that flank it. On md+
            it lives as a floating badge over the chat (see Chat.tsx). */}
        <div className="flex flex-1 justify-center md:hidden">
          <DayContextBadge
            selectedDateIso={selectedDateIso}
            onSelectDate={setSelectedDateIso}
            size="md"
            align="right"
          />
        </div>
        <nav className="hidden items-center gap-1 md:flex soft:gap-3" data-tour="nav">
          {VIEWS.map((v) => (
            <Button
              key={v.id}
              variant="ghost"
              size="sm"
              onClick={() => setView(v.id)}
              data-tour={`nav-${v.id}`}
              className={cn("gap-1.5", navItemBase, navItemClass(view === v.id))}
            >
              <v.Icon className="size-4" />
              {t(v.labelKey)}
            </Button>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <LanguageSync />
          <UserMenu
            label={user.name || user.email}
            onProfileSaved={invalidateData}
            onOpenCalculators={() => openMenuView("calculators")}
            onOpenUsage={() => openMenuView("usage")}
          />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="hidden min-h-0 min-w-0 flex-col md:flex">{dataContent}</section>
        <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-s-0 pb-[calc(7.5rem+env(safe-area-inset-bottom))] md:border-s md:pb-0">
          <Suspense fallback={<ScreenFallback />}>
            <Chat
              user={user}
              onTurnComplete={invalidateData}
              contextDate={chatContextDate}
              selectedDateIso={selectedDateIso}
              onSelectDate={setSelectedDateIso}
              onAgentViewDate={handleAgentViewDate}
              onShowScreen={handleShowScreen}
              // When a data screen covers the chat (mobile), replies surface as
              // coach toasts; "open chat" / gate taps close the drawer.
              dockActive={dataDrawerOpen}
              onOpenChat={() => setDataDrawerOpen(false)}
            />
          </Suspense>
        </aside>
      </div>

      {/* Mobile data panel — lives in the app layout (not a portal). It fills
          the screen from the top down to the fixed bottom chrome (primary nav +
          coach bar), so that chrome stays put and uncovered while the panel
          covers the header. The page's secondary sub-nav pins to the bottom of
          the scroll area, just above the primary nav. */}
      {dataDrawerOpen && (
        <div
          className="fixed inset-x-0 top-0 bottom-[calc(7.5rem+env(safe-area-inset-bottom))] z-40 flex animate-in flex-col overflow-hidden bg-background duration-200 fade-in-0 slide-in-from-bottom-2 md:hidden"
          role="region"
          aria-label={t(
            VIEWS.find((v) => v.id === view)?.labelKey ??
              (view === "calculators" || view === "usage" ? `nav.${view}` : "nav.dashboard"),
          )}
        >
          <button
            type="button"
            onClick={() => setDataDrawerOpen(false)}
            className="absolute inset-e-4 top-4 z-10 flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-muted/80 text-primary shadow-control backdrop-blur-sm transition-colors hover:bg-primary/10 hover:text-primary focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none"
            aria-label={t("common.close")}
          >
            <X className="size-5" />
          </button>
          <div className="flex min-h-0 flex-1 flex-col">{dataContent}</div>
        </div>
      )}

      {/* Mobile bottom chrome, two stacked fixed layers. The primary nav pins
          just above the collapsed coach bar (bottom = the bar's collapsed
          height, 3rem + safe inset). ChatDock is the bottom-most layer and owns
          the safe-area inset; it grows UP over the nav (z-50 vs the nav's z-40)
          when its input opens, so the coach stays visible on every screen —
          including the chat itself. */}
      <PrimaryNav
        activeView={dataDrawerOpen ? view : null}
        onSelect={handlePrimaryNav}
        className="fixed inset-x-0 bottom-[calc(3rem+env(safe-area-inset-bottom))] z-40 md:hidden"
      />
      <ChatDock />

      <InstallToast />
      <AppTour userId={user.id} createdAt={user.createdAt} />
    </div>
  );
}
