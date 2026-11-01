import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Share, Smartphone, X } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { consumeJustLoggedIn, useInstallPrompt } from "./lib/pwa";
import { cn } from "./lib/utils";

// Name shown in the install nudge.
const INSTALL_NAME = "Jim-Bro";

export function InstallToast() {
  const { t } = useTranslation();
  const { canInstall, installed, install, ios, mobile } = useInstallPrompt();
  const [visible, setVisible] = useState(false);
  const [iosHelpOpen, setIosHelpOpen] = useState(false);

  // Fire only on the post-login transition — the Login submit handler sets a
  // sessionStorage marker that we consume here so reloads while signed in
  // don't keep retriggering the nudge.
  useEffect(() => {
    if (!consumeJustLoggedIn()) return;
    if (installed) return;
    if (!mobile) return;
    if (!ios && !canInstall) {
      // Android/Chrome without a deferred prompt yet: give the browser a
      // couple of seconds to fire `beforeinstallprompt`, then re-check.
      const t = window.setTimeout(() => {
        if (!installed && (ios || canInstall)) setVisible(true);
      }, 2500);
      return () => window.clearTimeout(t);
    }
    setVisible(true);
  }, [canInstall, installed, ios, mobile]);

  // Hide automatically once installed (covers the case where the user
  // accepts the prompt from the toast).
  useEffect(() => {
    if (installed) setVisible(false);
  }, [installed]);

  if (!visible) return null;

  const handleInstall = async () => {
    if (ios) {
      setIosHelpOpen(true);
      return;
    }
    const outcome = await install();
    if (outcome === "accepted" || outcome === "unavailable") {
      setVisible(false);
    }
  };

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className={cn(
          // Spaces around the calc `+` are written as underscores so the
          // operator stays whitespace-separated in the emitted CSS regardless
          // of Tailwind's math-normalization. An unspaced `env(...)+4.5rem`
          // is invalid CSS, which drops `bottom` and makes this fixed toast
          // fall to the top of the viewport on mobile.
          "fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-40",
          "md:hidden",
        )}
      >
        <div className="mx-auto flex max-w-sm items-center gap-3 rounded-xl border border-edge bg-background/95 px-3 py-2.5 shadow-overlay backdrop-blur-sm supports-backdrop-filter:bg-background/80">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Smartphone className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm/tight font-medium">
              {t("components.install.title", { name: INSTALL_NAME })}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {ios ? t("components.install.iosSubtitle") : t("components.install.androidSubtitle")}
            </p>
          </div>
          <Button size="sm" onClick={handleInstall} className="gap-1.5">
            {ios ? <Share className="size-4" /> : <Download className="size-4" />}
            {t("components.install.install")}
          </Button>
          <button
            type="button"
            onClick={() => setVisible(false)}
            aria-label={t("components.install.dismiss")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <IosInstallHelp open={iosHelpOpen} onOpenChange={setIosHelpOpen} />
    </>
  );
}

export function IosInstallHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("components.install.iosTitle")}</DialogTitle>
          <DialogDescription>{t("components.install.iosIntro")}</DialogDescription>
        </DialogHeader>
        <ol className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs">
              1
            </span>
            <span>
              {t("components.install.iosStep1Prefix")}{" "}
              <Share className="inline size-3.5 align-text-bottom" />{" "}
              <span className="font-medium">{t("components.install.iosStep1Share")}</span>{" "}
              {t("components.install.iosStep1Suffix")}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs">
              2
            </span>
            <span>
              {t("components.install.iosStep2Prefix")}{" "}
              <span className="font-medium">{t("components.install.iosStep2Action")}</span>.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs">
              3
            </span>
            <span>
              {t("components.install.iosStep3Prefix")}{" "}
              <span className="font-medium">{t("components.install.iosStep3Add")}</span>{" "}
              {t("components.install.iosStep3Suffix", { name: INSTALL_NAME })}
            </span>
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
