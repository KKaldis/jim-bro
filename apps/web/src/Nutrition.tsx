import { EmptyState } from "@/components/EmptyState";
import { useQueryClient } from "@tanstack/react-query";
import {
  Apple,
  BookOpen,
  CalendarRange,
  type LucideIcon,
  Plus,
  Refrigerator,
  Utensils,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AddFoodDialog } from "./AddFoodDialog.tsx";
import { MacroBars } from "./Dashboard.tsx";
import { DietSection } from "./Diet.tsx";
import { HydrationSection } from "./HydrationCard.tsx";
import { RangeNav } from "./RangeNav.tsx";
import { RecipesSection } from "./Recipes.tsx";
import { useGetProgressNutrition } from "./api/endpoints/default/default";
import { SectionSubNav } from "./components/SectionSubNav";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Skeleton } from "./components/ui/skeleton";
import type { Granularity } from "./dateRange.ts";
import { apiErr } from "./lib/apiErr";
import { useDayContext } from "./lib/dayContext";
import { PageTitle } from "./lib/pageChrome";
import { type NutritionSection, useUiStore } from "./lib/uiStore";
import { useDateRange } from "./lib/useDateRange.ts";
import { useMinLoading } from "./lib/useMinLoading";
import {
  DayMacrosSection,
  DayMeals,
  DayOutline,
  SelectedDayCard,
  useDayEnergy,
} from "./nutrition/DayView";
import { KcalBars, KcalHeatmap } from "./nutrition/KcalCharts";
import { PantrySection } from "./nutrition/PantrySection";
import type { Day, Macros } from "./nutrition/shared";

type NutritionResp = {
  from: string;
  to: string;
  days: Day[];
  totals: { eaten: Macros; target: Macros | null; days_with_logs: number };
  averages: { eaten: Macros | null; target: Macros | null };
};

// Nutrition splits into sub-sections (Summary, Pantry, ...) switched by a
// bottom-locked sub-nav bar styled like the app's mobile bottom nav and
// stacked on top of it. `sticky bottom-0` keeps it pinned to the bottom of the
// scroll container — the left-hand data column on desktop, the full-screen
// data drawer on mobile (which covers the primary nav while open).
type NutSection = NutritionSection;

const NUT_SECTIONS: Array<{ id: NutSection; Icon: LucideIcon }> = [
  { id: "summary", Icon: Apple },
  { id: "pantry", Icon: Refrigerator },
  { id: "recipes", Icon: BookOpen },
  { id: "diet", Icon: CalendarRange },
];

export function Nutrition({
  navTab = null,
}: {
  // Agent-driven sub-tab navigation (show_screen tab arg). `key` changes on
  // every request so the sync effect re-fires even for a repeat of the same tab.
  navTab?: { tab: string; key: number } | null;
}) {
  // Last sub-section the user viewed, persisted in the UI store so reopening
  // Food lands back where they left off, not always on Summary.
  const { t } = useTranslation();
  const section = useUiStore((s) => s.nutritionSection);
  const setSection = useUiStore((s) => s.setNutritionSection);
  useEffect(() => {
    if (navTab && NUT_SECTIONS.some((s) => s.id === navTab.tab)) {
      setSection(navTab.tab as NutSection);
    }
    // Trigger only on navTab.key (bumps per show_screen request); setSection is
    // a stable Zustand setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTab?.key]);
  // Only the content area scrolls (scrollbar lives in this inner div); the
  // sub-nav sits below it so the scrollbar stops above the bar, like the chat
  // input. The scroller is full-width so the scrollbar sits at the panel edge;
  // content is centered to max-w-3xl inside it.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The sub-nav sits in-flow just below this scroll area, pinning to the
          bottom of the data panel (just above the primary nav). */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 md:pb-0">
        <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-5 sm:py-6">
          {section === "summary" ? (
            <NutritionSummary />
          ) : section === "pantry" ? (
            <PantrySection />
          ) : section === "recipes" ? (
            <RecipesSection />
          ) : (
            <DietSection />
          )}
        </div>
      </div>
      <SectionSubNav
        sections={NUT_SECTIONS}
        section={section}
        onSection={setSection}
        label={(id) => t(`nutrition.tabs.${id}`)}
        ariaLabel={t("nutrition.sectionsAria")}
        tourPrefix="nutrition"
      />
    </div>
  );
}

function NutritionSummary() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [addOpen, setAddOpen] = useState(false);
  const { selectedDate, selectedDateIso, setSelectedDate, setSelectedDateIso } = useDayContext();
  // Drilling into a single day from the week/month overview: jump to that
  // date and flip to day granularity so the meal-level detail shows.
  const onSelectDay = (iso: string) => {
    setSelectedDateIso(iso);
    setGranularity("day");
  };
  const { range, customRange, setCustomRange } = useDateRange(granularity, selectedDate);

  const nutQ = useGetProgressNutrition({ from: range.from, to: range.to });
  const rawData = (nutQ.data as unknown as NutritionResp | undefined) ?? null;
  // "All" fetches a year back; start it at the first logged day instead (see
  // clipToData) so the breakdown and "x of y days" don't count empty months.
  const firstLogged = rawData?.days.find((d) => d.meal_count > 0)?.date ?? null;
  const data = useMemo(() => {
    if (!rawData || granularity !== "all" || !firstLogged) return rawData;
    return { ...rawData, days: rawData.days.filter((d) => d.date >= firstLogged) };
  }, [rawData, granularity, firstLogged]);
  const err = nutQ.error ? apiErr(nutQ.error) : null;
  const showLoader = useMinLoading(nutQ.isPending);

  return (
    <div className="space-y-4">
      <PageTitle Icon={Apple} help="nutrition">
        {t("nutrition.summary.title")}
      </PageTitle>
      <AddFoodDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        dateIso={selectedDateIso}
        onLogged={() => void queryClient.invalidateQueries()}
      />
      <RangeNav
        granularity={granularity}
        anchor={selectedDate}
        onGranularity={setGranularity}
        onAnchor={setSelectedDate}
        customRange={customRange}
        onCustomRange={setCustomRange}
        dataFrom={firstLogged}
      />
      {granularity === "day" && (
        <Button onClick={() => setAddOpen(true)} className="w-full gap-1">
          <Plus className="size-4" /> {t("nutrition.summary.addFood")}
        </Button>
      )}
      {showLoader && (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-60 w-full" />
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {data && !showLoader && (
        <NutritionContent
          data={data}
          granularity={granularity}
          onSelectDay={onSelectDay}
          onChanged={() => void queryClient.invalidateQueries()}
        />
      )}
    </div>
  );
}

function NutritionContent({
  data,
  granularity,
  onSelectDay,
  onChanged,
}: {
  data: NutritionResp;
  granularity: Granularity;
  onSelectDay: (iso: string) => void;
  // Invalidate the nutrition queries after a meal edit/delete.
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  // Range view: the day tapped on the chart, detailed in a card beneath it
  // (like Workout's burn chart). Ignored once the range no longer holds it.
  const [picked, setPicked] = useState<string | null>(null);
  // Days without a diet-plan target fall back to the profile goal's target
  // (recomp/maintain/cut/bulk off TDEE), taken at the range's end, so the
  // bars, heatmap and averages still measure against something.
  const { goalTarget } = useDayEnergy(data.to);
  const days = useMemo(
    () =>
      goalTarget ? data.days.map((d) => (d.target ? d : { ...d, target: goalTarget })) : data.days,
    [data.days, goalTarget],
  );
  const avgTarget = useMemo(
    () => averageTarget(days) ?? data.averages.target,
    [days, data.averages.target],
  );
  const selectedDay = days.find((d) => d.date === picked) ?? null;
  if (granularity === "day") {
    const d = data.days[0];
    if (!d) return <EmptyState icon={Utensils}>{t("nutrition.summary.noData")}</EmptyState>;
    return (
      <>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 divide-x">
            <div>
              <DayOutline day={d} />
            </div>
            <div>
              <HydrationSection dateIso={d.date} />
            </div>
          </div>
          <DayMacrosSection day={d} />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              {t("nutrition.summary.whatYouAte")}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {t("nutrition.summary.mealCount", { count: d.meal_count })}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DayMeals day={d} onChanged={onChanged} />
          </CardContent>
        </Card>
      </>
    );
  }

  // week / month
  const avgEaten = data.averages.eaten;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            {t("nutrition.summary.averagesPerDay")}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {t("nutrition.summary.loggedOf", {
                logged: data.totals.days_with_logs,
                total: data.days.length,
              })}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {avgEaten ? (
            <MacroBars eaten={avgEaten} target={avgTarget} />
          ) : (
            <EmptyState icon={Utensils}>{t("nutrition.summary.noMealsInRange")}</EmptyState>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("nutrition.summary.perDayBreakdown")}</CardTitle>
        </CardHeader>
        <CardContent>
          {granularity === "month" ? (
            <KcalHeatmap
              days={days}
              selectedDate={selectedDay?.date ?? null}
              onSelectDate={setPicked}
            />
          ) : (
            <KcalBars
              days={days}
              selectedDate={selectedDay?.date ?? null}
              onSelectDate={setPicked}
            />
          )}
        </CardContent>
      </Card>
      {selectedDay && (
        <SelectedDayCard day={selectedDay} onGoToDay={onSelectDay} onChanged={onChanged} />
      )}
    </>
  );
}

// Mean target over the days that have one — mirrors the server's
// averages.target, but over days already backfilled with the goal target.
function averageTarget(days: Day[]): Macros | null {
  const targets = days.flatMap((d) => (d.target ? [d.target] : []));
  if (targets.length === 0) return null;
  const n = targets.length;
  const sum = (k: "kcal" | "p" | "f" | "c") => targets.reduce((s, m) => s + m[k], 0) / n;
  const fibers = targets.flatMap((m) => (m.fiber != null ? [m.fiber] : []));
  return {
    kcal: sum("kcal"),
    p: sum("p"),
    f: sum("f"),
    c: sum("c"),
    ...(fibers.length > 0 ? { fiber: fibers.reduce((s, v) => s + v, 0) / n } : {}),
  };
}
