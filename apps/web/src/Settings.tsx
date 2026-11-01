import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, Languages, UserRound } from "lucide-react";
import { authClient, useSession } from "./auth.ts";
import { patchMeProfile, useGetMeProfile } from "./api/endpoints/default/default";
import { ProfileUpdateRequest } from "@fa/shared/schemas";
import { apiErr } from "./lib/apiErr";
import { useUiStore } from "./lib/uiStore";
import { LANGUAGES, type Language } from "./i18n";
import { CollapsibleSection, SectionLabel } from "./forms/formKit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Skeleton } from "./components/ui/skeleton";
import { useMinLoading } from "./lib/useMinLoading";
import { UpdateProfileForm } from "./forms/UpdateProfileForm";
import { invalidateFormContext } from "./forms/formContext";
import { ChangePassword } from "./ChangePassword";
import { ProgressReportOptions } from "./export/progressReport";

type Profile = {
  sex?: "male" | "female";
  birth_year?: number;
  height_cm?: number;
  activity_level?: "sedentary" | "light" | "moderate" | "very" | "extreme";
  goal?: "cut" | "maintain" | "recomp" | "lean_bulk";
  target_weight_kg?: number | null;
  restrictions?: string[];
  notes?: string;
  wrist_cm?: number | null;
  ankle_cm?: number | null;
  units?: "metric" | "imperial";
  water_goal_ml?: number | null;
  gym_machine_ids?: string[] | null;
};

// Seed the draft with the tool's flat update_profile input keys straight from
// the saved profile, so a single-field edit still shows everything else. Only
// set keys present on the profile — absent keys stay undefined (the form treats
// undefined as "unset", and the payload drops them).
function profileToDraft(p: Profile | null): Record<string, unknown> {
  if (!p) return {};
  const d: Record<string, unknown> = {};
  if (p.sex) d.sex = p.sex;
  if (p.birth_year != null) d.birth_year = p.birth_year;
  if (p.height_cm != null) d.height_cm = p.height_cm;
  if (p.activity_level) d.activity_level = p.activity_level;
  if (p.goal) d.goal = p.goal;
  if (p.target_weight_kg != null) d.target_weight_kg = p.target_weight_kg;
  if (p.restrictions?.length) d.restrictions = p.restrictions;
  if (p.notes) d.notes = p.notes;
  if (p.wrist_cm != null) d.wrist_cm = p.wrist_cm;
  if (p.ankle_cm != null) d.ankle_cm = p.ankle_cm;
  if (p.units) d.units = p.units;
  if (p.water_goal_ml != null) d.water_goal_ml = p.water_goal_ml;
  if (p.gym_machine_ids?.length) d.gym_machine_ids = p.gym_machine_ids;
  return d;
}

// The flat input keys ARE the PATCH /me/profile payload (the endpoint reuses
// update_profile's validation), so this is just drop-empties: strip undefined /
// "" while keeping an explicit null (clears target_weight_kg).
function draftToPayload(draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) {
    if (v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

export function Settings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  // Manual profile editing reuses the chat gate's UpdateProfileForm so both
  // surfaces look identical and share the sex/goal/activity selectors and
  // restrictions editor. The draft is the tool's flat input shape, which is
  // exactly the PATCH /me/profile payload.
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Language lives outside the draft/Save flow: it switches the UI immediately
  // (store + i18next) and persists fire-and-forget, so the profile stays the
  // source of truth for the agent and other devices without a round-trip.
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const handleLanguageChange = (next: Language) => {
    setLanguage(next);
    void patchMeProfile({ language: next });
  };

  // The display name lives on the Better Auth user, not the fitness profile, so
  // it saves through updateUser alongside the profile PATCH. Signup stores the
  // email as the name when none was given; show that as empty, not as a name.
  const { data: session } = useSession();
  const user = session?.user;
  const savedName = user && user.name !== user.email ? user.name : "";
  const [name, setName] = useState(savedName);
  useEffect(() => setName(savedName), [savedName]);

  const profileQ = useGetMeProfile();
  const showLoader = useMinLoading(profileQ.isPending);
  // Seed the editable draft once the profile loads (or when it changes).
  useEffect(() => {
    if (profileQ.data) {
      setDraft(profileToDraft((profileQ.data.profile as Profile | null) ?? null));
    }
  }, [profileQ.data]);
  const loadErr = profileQ.error ? apiErr(profileQ.error) : null;

  const onSubmit = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Validate against the same Zod schema the server enforces
      // (@fa/shared/schemas → ProfileUpdateRequest) before the PATCH.
      await patchMeProfile(ProfileUpdateRequest.parse(draftToPayload(draft)));
      const nextName = name.trim();
      if (user && nextName !== savedName) {
        // An empty name falls back to the email, as at signup.
        const { error } = await authClient.updateUser({ name: nextName || user.email });
        if (error) throw new Error(error.message ?? "name update failed");
      }
      // Profile drives form-context prefill (sex/height/goal); drop the cache so
      // any open gate cards see the new values.
      invalidateFormContext();
      onSaved();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="modal-cap overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("settings.title")}</DialogTitle>
            <DialogDescription>{t("settings.description")}</DialogDescription>
          </DialogHeader>
          {showLoader ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <section className="space-y-3">
                <SectionLabel Icon={UserRound} info={t("settings.nameHint")}>
                  {t("settings.nameLabel")}
                </SectionLabel>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("auth.yourName")}
                  autoComplete="name"
                  maxLength={60}
                  disabled={busy}
                  aria-label={t("settings.nameLabel")}
                />
              </section>
              <section className="space-y-3">
                <SectionLabel Icon={Languages} info={t("settings.languageHint")}>
                  {t("settings.languageLabel")}
                </SectionLabel>
                <Select
                  value={language}
                  disabled={busy}
                  onValueChange={(v) => handleLanguageChange(v as Language)}
                >
                  <SelectTrigger className="w-full" aria-label={t("settings.languageLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>
              <UpdateProfileForm
                schema={{ type: "object" }}
                value={draft}
                onChange={(next) => setDraft(next as Record<string, unknown>)}
                disabled={busy}
              />
              <ChangePassword disabled={busy} />
              {/* Progress-report PDF export, expanded in place like Change password. */}
              <CollapsibleSection
                Icon={FileDown}
                title={t("export.report.profileSection")}
                disabled={busy}
              >
                <p className="text-xs text-muted-foreground">{t("export.report.profileHint")}</p>
                <ProgressReportOptions />
              </CollapsibleSection>
              {(err ?? loadErr) && <p className="text-sm text-destructive">{err ?? loadErr}</p>}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                  {t("common.cancel")}
                </Button>
                <Button type="button" onClick={() => void onSubmit()} disabled={busy}>
                  {busy ? t("common.saving") : t("common.save")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
