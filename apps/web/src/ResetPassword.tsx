import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { PasswordInput } from "./components/ui/password-input";
import { Label } from "./components/ui/label";
import { BrandMark } from "./BrandMark.tsx";

export function ResetPassword() {
  const { t } = useTranslation();
  const { token, urlError } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      token: params.get("token"),
      urlError: params.get("error"),
    };
  }, []);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [done, setDone] = useState(false);

  const goLogin = () => {
    window.history.replaceState(null, "", "/");
    window.location.reload();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (password.length < 8) {
      setMsg({ text: t("auth.passwordTooShort"), ok: false });
      return;
    }
    if (password !== confirm) {
      setMsg({ text: t("auth.passwordsDontMatch"), ok: false });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      setDone(true);
      // Strip the token from the URL so a refresh doesn't try to reuse it.
      // Keep `?reset-password=true` so the success card stays put until the
      // user clicks through to sign in.
      window.history.replaceState(null, "", "/?reset-password=true");
    } catch (err) {
      setMsg({
        text: err instanceof Error ? err.message : String(err),
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center text-center">
          <BrandMark variant="auth" />
        </div>

        <Card>
          <CardContent className="space-y-4 pt-6">
            {urlError || !token ? (
              <div className="space-y-3 text-center">
                <h2 className="text-lg font-semibold">{t("auth.resetLinkInvalidTitle")}</h2>
                <p className="text-sm text-muted-foreground">{t("auth.resetLinkInvalidBody")}</p>
                <Button onClick={goLogin} className="w-full">
                  {t("auth.backToSignIn")}
                </Button>
              </div>
            ) : done ? (
              <div className="space-y-3 text-center">
                <h2 className="text-lg font-semibold">{t("auth.passwordUpdated")}</h2>
                <p className="text-sm text-muted-foreground">{t("auth.canNowSignIn")}</p>
                <Button onClick={goLogin} className="w-full">
                  {t("auth.continueToSignIn")}
                </Button>
              </div>
            ) : (
              <form onSubmit={submit} autoComplete="on" className="space-y-3">
                <div className="text-center">
                  <h2 className="text-lg font-semibold">{t("auth.setNewPassword")}</h2>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-password">{t("auth.newPassword")}</Label>
                  <PasswordInput
                    id="reset-password"
                    placeholder={t("auth.passwordPlaceholder")}
                    autoComplete="new-password"
                    minLength={8}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-confirm">{t("auth.confirmPassword")}</Label>
                  <PasswordInput
                    id="reset-confirm"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "…" : t("auth.updatePassword")}
                </Button>
                {msg && (
                  <p
                    className={
                      "text-center text-xs " + (msg.ok ? "text-success" : "text-destructive")
                    }
                  >
                    {msg.text}
                  </p>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
