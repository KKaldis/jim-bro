import { useEffect } from "react";
import { useGetMeProfile } from "../api/endpoints/default/default";
import { normalizeLanguage } from "../i18n";
import { useUiStore } from "./uiStore";

// The user profile is the source of truth for the product language. This hook
// adopts profile.language into the UI store (which flips i18next) whenever the
// SERVER value changes — on first load (so a returning user sees their saved
// language even on a fresh device) and if it's ever updated remotely.
//
// The effect deliberately depends ONLY on the profile value and reads/writes the
// store imperatively via getState(). If it also reacted to the store's own
// `language`, a local switch (which updates the store instantly but leaves the
// profile query cache momentarily stale) would fire this effect and revert the
// UI back to the stale server value. Keying on the profile value alone means a
// user-initiated change never triggers a revert; the switcher persists the new
// value to the profile, and the next refetch converges to a no-op.
export function useLanguageSync() {
  const profileQ = useGetMeProfile();
  const profileLanguage = profileQ.data?.profile?.language;

  useEffect(() => {
    if (!profileLanguage) return;
    const next = normalizeLanguage(profileLanguage);
    const { language, setLanguage } = useUiStore.getState();
    if (next !== language) setLanguage(next);
  }, [profileLanguage]);
}

// Mount-only wrapper so the sync can live inside the authenticated tree (where
// the profile query is meaningful) without adding a hook to a large component.
export function LanguageSync() {
  useLanguageSync();
  return null;
}
