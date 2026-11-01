import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { z } from "zod";
import { authClient, useSession } from "./auth.ts";
import { toastSuccess } from "./lib/toast";
import { CollapsibleSection } from "./forms/formKit";
import { Button } from "./components/ui/button";
import { PasswordInput } from "./components/ui/password-input";

// Messages are i18n keys, translated on display.
const ChangePasswordInput = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, "auth.passwordTooShort"),
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ["newPassword"],
    message: "settings.passwordUnchanged",
  });

/**
 * Change-password section of the profile dialog. Only users with an
 * email + password ("credential") account have a password to change; Google-only
 * users get nothing. A user who signed up with a password and later linked
 * Google still has one, so they see it too.
 *
 * Saves on its own, separate from the dialog's profile Save: the password goes
 * to Better Auth, not the profile PATCH. Collapsed until the user opens it.
 */
export function ChangePassword({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const email = useSession().data?.user.email ?? "";
  const [hasPassword, setHasPassword] = useState(false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void authClient.listAccounts().then(({ data }) => {
      setHasPassword(Boolean(data?.some((a) => a.providerId === "credential")));
    });
  }, []);

  if (!hasPassword) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ChangePasswordInput.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) return setErr(t(parsed.error.issues[0].message));
    setBusy(true);
    setErr(null);
    try {
      const { error } = await authClient.changePassword({
        ...parsed.data,
        // Sign out other devices: a password change is often a reaction to
        // someone else having it.
        revokeOtherSessions: true,
      });
      if (error) {
        throw new Error(
          error.code === "INVALID_PASSWORD"
            ? t("settings.currentPasswordWrong")
            : (error.message ?? "password change failed"),
        );
      }
      toastSuccess(t("settings.passwordChanged"));
      setCurrent("");
      setNext("");
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollapsibleSection
      Icon={KeyRound}
      title={t("settings.changePassword")}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <form onSubmit={submit} className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("settings.passwordHint")}</p>
        {/* Lets password managers attach the new password to this account. */}
        <input type="text" autoComplete="username" value={email} hidden readOnly />
        <PasswordInput
          placeholder={t("settings.currentPassword")}
          aria-label={t("settings.currentPassword")}
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          disabled={busy || disabled}
        />
        <PasswordInput
          placeholder={t("auth.newPassword")}
          aria-label={t("auth.newPassword")}
          autoComplete="new-password"
          minLength={8}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={busy || disabled}
        />
        {err && <p className="text-sm text-destructive">{err}</p>}
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={busy || disabled}>
            {busy ? t("common.saving") : t("auth.updatePassword")}
          </Button>
        </div>
      </form>
    </CollapsibleSection>
  );
}
