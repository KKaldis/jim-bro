import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { DirectionProvider } from "@radix-ui/react-direction";
import { useTranslation } from "react-i18next";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { ThemeProvider } from "./lib/theme.tsx";
import { queryClient } from "./lib/queryClient.ts";
import { MODEL_CACHE_PREFIX } from "./physique/modelCache";
import "./i18n";
import "./styles.css";

if (import.meta.env.DEV) {
  // A prior `npm run web:build` may have left a SW registered at this origin
  // that serves a cached prod index.html referencing hashed bundles Vite
  // doesn't have. Unregister anything stale so dev always loads from Vite.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
    if (window.caches) {
      // The body-scan models are app-managed, not SW precache, and ~36 MB to
      // refetch — keep them so testing the scanner in dev isn't a download
      // on every reload.
      caches
        .keys()
        .then((keys) =>
          keys.filter((k) => !k.startsWith(MODEL_CACHE_PREFIX)).forEach((k) => caches.delete(k)),
        );
    }
  }
} else {
  registerSW({ immediate: true });
}

// Radix primitives (menus, selects, tabs) don't read <html dir>; hand them the
// active language's direction so they open and key-navigate the right way in RTL.
function DirectionRoot({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();
  return <DirectionProvider dir={i18n.dir()}>{children}</DirectionProvider>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DirectionRoot>
          <App />
          <Toaster />
        </DirectionRoot>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
