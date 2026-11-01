import { useCallback, useEffect, useState } from "react";

// Chrome / Edge / Samsung Internet fire `beforeinstallprompt` once the page
// passes installability criteria. We capture it at module scope because the
// event arrives before React mounts on cold loads, and stash it for later
// `.prompt()` calls. iOS Safari does not fire this event — install there is
// manual via the share sheet.
type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((cb) => cb());
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    listeners.forEach((cb) => cb());
  });
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as MacIntel; touch points disambiguate.
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  return navigator.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

export function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export const JUST_LOGGED_IN_KEY = "fa.pwa.justLoggedIn";

export function markJustLoggedIn(): void {
  try {
    sessionStorage.setItem(JUST_LOGGED_IN_KEY, "1");
  } catch {
    // sessionStorage can throw in some privacy modes — install nudge is
    // non-critical so swallow.
  }
}

export function consumeJustLoggedIn(): boolean {
  try {
    if (sessionStorage.getItem(JUST_LOGGED_IN_KEY) === "1") {
      sessionStorage.removeItem(JUST_LOGGED_IN_KEY);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(() => deferredPrompt !== null);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const update = () => {
      setCanInstall(deferredPrompt !== null);
      setInstalled(isStandalone());
    };
    listeners.add(update);
    // Standalone state can flip if the user installs and immediately switches
    // back to the browser tab; cheap to keep an eye on.
    const mql = window.matchMedia?.("(display-mode: standalone)");
    const onChange = () => setInstalled(isStandalone());
    mql?.addEventListener?.("change", onChange);
    return () => {
      listeners.delete(update);
      mql?.removeEventListener?.("change", onChange);
    };
  }, []);

  const install = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    if (!deferredPrompt) return "unavailable";
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    listeners.forEach((cb) => cb());
    return choice.outcome;
  }, []);

  return {
    canInstall,
    installed,
    install,
    ios: isIOS(),
    mobile: isMobile(),
  };
}
