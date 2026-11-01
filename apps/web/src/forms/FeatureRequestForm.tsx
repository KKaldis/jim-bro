import { useTranslation } from "react-i18next";
import { Lightbulb, MessageSquareText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionLabel } from "./formKit";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for submit_feature_request. The model pre-fills the title +
// details from what the user asked for; this card lets them review and edit the
// wording before the Accept/Decline footer files it with the team. Same flat
// contract the tool reads: { title, details }. There's no update_* counterpart,
// so the card goes read-only after save (like log_body_comp).

type FeatureRequestInput = {
  title?: string;
  details?: string;
};

export function FeatureRequestForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const data = (value as FeatureRequestInput) ?? {};
  const set = (patch: Partial<FeatureRequestInput>) => onChange({ ...data, ...patch });

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SectionLabel Icon={Lightbulb}>{tr("formsAdmin.feature.featureRequest")}</SectionLabel>
        <Field
          label={
            <>
              {tr("formsAdmin.feature.title")}
              <span className="text-destructive"> *</span>
            </>
          }
          htmlFor="feature-title"
        >
          <Input
            id="feature-title"
            value={data.title ?? ""}
            disabled={disabled}
            placeholder={tr("formsAdmin.feature.titlePlaceholder")}
            maxLength={120}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
      </section>

      <section className="space-y-2">
        <SectionLabel Icon={MessageSquareText}>{tr("formsAdmin.feature.details")}</SectionLabel>
        <Field label={tr("formsAdmin.feature.whatAndWhy")} htmlFor="feature-details" optional>
          <Textarea
            id="feature-details"
            value={data.details ?? ""}
            disabled={disabled}
            rows={3}
            placeholder={tr("formsAdmin.feature.detailsPlaceholder")}
            onChange={(e) => set({ details: e.target.value || undefined })}
            className="min-h-20 resize-y"
          />
        </Field>
      </section>
    </div>
  );
}
