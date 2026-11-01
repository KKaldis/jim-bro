import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleHelp, type LucideIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Shared page/section title. Every data screen (Dashboard, Nutrition, Pantry,
// Workout, Body) renders this so the heading stays identical across screens.
// The mobile data drawer's close button floats over the drawer itself
// (App.tsx), so it's no longer part of the title row.
// `help` names a pageHelp.* entry; when set, a "?" next to the title opens a
// short list of what the user can do on that screen.
export function PageTitle({
  Icon,
  children,
  help,
}: {
  Icon: LucideIcon;
  children: ReactNode;
  help?: string;
}) {
  return (
    <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
      <Icon className="size-6 sm:size-7" aria-hidden />
      {children}
      {help && <PageHelp id={help} />}
    </h2>
  );
}

function PageHelp({ id }: { id: string }) {
  const { t } = useTranslation();
  const items = t(`pageHelp.${id}.items`, { returnObjects: true }) as string[];
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("pageHelp.aria")}
        className="flex size-6 shrink-0 items-center justify-center self-center rounded-full leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7"
      >
        <CircleHelp className="size-5 sm:size-6" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] text-sm font-normal tracking-normal"
      >
        <p className="mb-2 font-semibold">{t("pageHelp.heading")}</p>
        <ul className="list-disc space-y-1.5 ps-4 text-muted-foreground">
          {Array.isArray(items) && items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// Shared card banner: a gradient wash with a soft glow and an icon "avatar",
// a bold title, optional subtitle, an optional right-aligned slot (badges /
// freshness pill), and optional children rendered under the title (e.g. the
// profile's identity line + goal pills). Gives dashboard and billing cards the
// same hero look.
export function CardHero({
  icon: Icon,
  title,
  subtitle,
  right,
  children,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative isolate overflow-hidden border-b bg-linear-to-br from-primary/20 via-primary/5 to-transparent px-4 py-3 sm:px-5">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-e-10 -top-12 size-28 rounded-full bg-primary/25 blur-3xl"
      />
      <div className="relative flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15 ring-inset">
          <Icon className="size-4.5" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base/tight font-bold tracking-tight">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          {children}
        </div>
        {right && <div className="shrink-0 self-start">{right}</div>}
      </div>
    </div>
  );
}
