import { useTranslation } from "react-i18next";
import { Calculator } from "lucide-react";
import { PageTitle } from "./lib/pageChrome";
import { SectionLabel } from "./forms/formKit";
import { CalculatorCard } from "./calculators/CalculatorCard";
import { CALCULATOR_SECTIONS } from "./calculators/registry";

// Manual calculators page — every compute tool the coach can run, available as a
// standalone form so the user can do the math themselves without asking the
// agent. Each calculator reuses the exact result card the chat renders, wrapped
// in inputs prefilled from the user's profile but freely editable for "what-if".
export function Calculators() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto md:pb-0">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-3 py-4 sm:px-5 sm:py-6">
          <div className="space-y-1">
            <PageTitle Icon={Calculator} help="calculators">
              {t("calculators.title")}
            </PageTitle>
            <p className="text-sm text-muted-foreground">{t("calculators.subtitle")}</p>
          </div>

          {CALCULATOR_SECTIONS.map((section) => (
            <section key={section.id} className="space-y-3">
              <SectionLabel Icon={section.Icon}>{t(section.titleKey)}</SectionLabel>
              <div className="space-y-4">
                {section.calculators.map((calc) => (
                  <CalculatorCard key={calc.id} calc={calc} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
