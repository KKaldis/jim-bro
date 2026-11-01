import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { signIn, signUp } from "./auth.ts";
import { markJustLoggedIn } from "./lib/pwa";
import { toastError } from "./lib/toast";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { PasswordInput } from "./components/ui/password-input";
import { Label } from "./components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { BrandMark } from "./BrandMark.tsx";

type Mode = "login" | "signup" | "forgot";

// Google sign-in leaves the page; on failure Better Auth sends the user back to
// errorCallbackURL with `&error=<code>` appended.
const SSO_FAILED_PARAM = "sso";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.57.38-2.29v-3.1H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4.01-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77z"
      />
    </svg>
  );
}

export function Login() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get(SSO_FAILED_PARAM) === "failed") {
      // account_not_linked: an email+password account with this email exists
      // but its email isn't verified, so Better Auth won't attach Google to it
      // (that would let whoever set the password into the Google user's account).
      toastError(
        params.get("error") === "account_not_linked"
          ? t("auth.googleAccountExists")
          : t("auth.googleFailed"),
      );
    }
    if (params.has(SSO_FAILED_PARAM)) window.history.replaceState(null, "", "/");
    fetch("/api/auth-providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { google?: boolean } | null) => setGoogleEnabled(Boolean(p?.google)))
      .catch(() => {});
  }, [t]);

  const signInWithGoogle = async () => {
    setBusy(true);
    setMsg(null);
    // Survives the redirect: sessionStorage is per-tab, and we come back to
    // the same origin.
    markJustLoggedIn();
    const { error } = await signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: `/?${SSO_FAILED_PARAM}=failed`,
    });
    // On success the browser is already navigating to Google.
    if (error) {
      toastError(error.message ?? t("auth.googleFailed"));
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "signup") {
        const { error } = await signUp.email({
          email,
          password,
          name: name || email,
        });
        if (error) throw new Error(error.message ?? "signup failed");
        markJustLoggedIn();
      } else if (mode === "login") {
        const { error } = await signIn.email({ email, password });
        if (error) throw new Error(error.message ?? "sign-in failed");
        markJustLoggedIn();
      } else {
        const res = await fetch("/api/auth/request-password-reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            email,
            redirectTo: window.location.origin + "/?reset-password=true",
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }
        setMsg({
          text: t("auth.resetLinkSent"),
          ok: true,
        });
      }
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
            <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="login">{t("auth.signIn")}</TabsTrigger>
                <TabsTrigger value="signup">{t("auth.signUp")}</TabsTrigger>
                <TabsTrigger value="forgot">{t("auth.forgot")}</TabsTrigger>
              </TabsList>
            </Tabs>

            <form onSubmit={submit} autoComplete="on" className="space-y-3">
              {mode === "signup" && (
                <div className="space-y-1.5">
                  <Label htmlFor="login-name">{t("auth.name")}</Label>
                  <Input
                    id="login-name"
                    type="text"
                    placeholder={t("auth.yourName")}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="login-email">{t("auth.email")}</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder={t("auth.emailPlaceholder")}
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {mode !== "forgot" && (
                <div className="space-y-1.5">
                  <Label htmlFor="login-password">{t("auth.password")}</Label>
                  <PasswordInput
                    id="login-password"
                    placeholder={t("auth.passwordPlaceholder")}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    minLength={8}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              )}
              <Button type="submit" disabled={busy} className="w-full">
                {busy
                  ? "…"
                  : mode === "login"
                    ? t("auth.signIn")
                    : mode === "signup"
                      ? t("auth.signUp")
                      : t("auth.sendResetEmail")}
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

            {/* Secondary option, below the email form. */}
            {googleEnabled && mode !== "forgot" && (
              <>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {t("auth.or")}
                  <span className="h-px flex-1 bg-border" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  className="w-full"
                  onClick={signInWithGoogle}
                >
                  <GoogleIcon />
                  {t("auth.continueWithGoogle")}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
