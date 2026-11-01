import i18n, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";

// Translations are split into per-feature namespace files under
// locales/<lang>/*.json (e.g. core.json, dashboard.json, forms.json) and merged
// here. Each file holds disjoint TOP-LEVEL namespaces (nav, dashboard, …) so a
// shallow merge is lossless — and new feature files are picked up automatically
// with no edit to this module. Keys are grouped by feature: t("nav.dashboard").
type LocaleModule = { default: Record<string, unknown> };

function mergeLocale(modules: LocaleModule[]): Record<string, unknown> {
  return Object.assign({}, ...modules.map((m) => m.default));
}

// English is the fallback language, so it ships in the main bundle. Every other
// language is lazy: bundling all of them eagerly pushed the entry chunk past
// Workbox's 2 MiB precache limit and failed the build. vite.config.ts groups
// each language's files into a single `locale-<lang>` chunk (still precached,
// so switching language works offline).
const en = mergeLocale(
  Object.values(import.meta.glob<LocaleModule>("./locales/en/*.json", { eager: true })),
);
const lazyLocales = import.meta.glob<LocaleModule>(["./locales/*/*.json", "!./locales/en/*.json"]);

function loadLocale(lng: string): Promise<Record<string, unknown>> {
  const prefix = `./locales/${lng}/`;
  const loaders = Object.entries(lazyLocales)
    .filter(([path]) => path.startsWith(prefix))
    .map(([, load]) => load());
  return Promise.all(loaders).then(mergeLocale);
}

const lazyLocaleBackend: BackendModule = {
  type: "backend",
  init() {},
  read(lng, _ns, callback) {
    loadLocale(lng).then(
      (data) => callback(null, data),
      (err: Error) => callback(err, false),
    );
  },
};

// Product i18n. Single default namespace ("translation") with feature-grouped
// nested keys (e.g. t("nav.dashboard"), t("common.save")). The user's profile
// language is the source of truth (see useLanguageSync); this module just holds
// the i18next instance + the helpers that keep the very-first render, the UI
// store, and the chat/Intl locale coherent.

export type Language = "en" | "el" | "ar" | "sq" | "fa" | "ur" | "nl" | "it";

// Supported product languages, in menu order. `label` is shown in the user's
// own script (autonym) so it's recognizable regardless of the current UI lang.
export const LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = [
  { code: "en", label: "English" },
  { code: "el", label: "Ελληνικά" },
  { code: "ar", label: "العربية" },
  { code: "sq", label: "Shqip" },
  { code: "fa", label: "فارسی" },
  { code: "ur", label: "اردو" },
  { code: "nl", label: "Nederlands" },
  { code: "it", label: "Italiano" },
];

const SUPPORTED: readonly string[] = LANGUAGES.map((l) => l.code);

// Coerce any locale-ish string (BCP-47, region-tagged, mixed case) down to a
// supported base language, defaulting to English. `"el-GR"` → `"el"`, `"EN"` →
// `"en"`, `"fr-FR"` → `"en"`.
export function normalizeLanguage(v: string | null | undefined): Language {
  if (!v) return "en";
  const base = v.toLowerCase().split("-")[0];
  return SUPPORTED.includes(base) ? (base as Language) : "en";
}

const BCP47: Record<Language, string> = {
  en: "en-US",
  el: "el-GR",
  ar: "ar-SA",
  sq: "sq-AL",
  fa: "fa-IR",
  ur: "ur-PK",
  nl: "nl-NL",
  it: "it-IT",
};

// Map a product language to the BCP-47 reply locale the chat sends the agent.
export function toBcp47(lang: Language): string {
  return BCP47[lang];
}

// Locale for Intl date/number formatting in the current UI language. Arabic
// and Persian keep Latin digits: most numbers in the app are rendered raw, so
// Intl's native digits would mix two digit sets on one screen. Persian also
// pins the Gregorian calendar (its Intl default is the Solar Hijri one), since
// every date in the app is a Gregorian ISO day.
const INTL_LOCALE: Partial<Record<Language, string>> = {
  ar: "ar-u-nu-latn",
  fa: "fa-u-nu-latn-ca-gregory",
};
export function intlLocale(lang: Language = normalizeLanguage(i18n.language)): string {
  return INTL_LOCALE[lang] ?? toBcp47(lang);
}

const RTL: ReadonlySet<Language> = new Set(["ar", "fa", "ur"]);

export function textDir(lang: Language): "ltr" | "rtl" {
  return RTL.has(lang) ? "rtl" : "ltr";
}

// Keep <html lang/dir> on the active language so CSS logical properties,
// Tailwind's rtl: variant and native controls all flip with it.
function applyDocumentLanguage(lng: string) {
  const lang = normalizeLanguage(lng);
  document.documentElement.lang = lang;
  document.documentElement.dir = textDir(lang);
}

// The user's language before the profile query has resolved: the persisted
// UI-store choice, else English. The browser language is deliberately ignored —
// English is the default until the user picks something else. Read straight
// from localStorage because i18n initializes at import time, before the Zustand
// store hydrates.
export function getInitialLanguage(): Language {
  try {
    const raw = localStorage.getItem("fa.ui");
    if (raw) {
      const stored = JSON.parse(raw)?.state?.language;
      if (stored) return normalizeLanguage(stored);
    }
  } catch {
    /* ignore malformed/unavailable storage */
  }
  return "en";
}

// Always boot in the bundled English so the first paint never waits on a
// network fetch; a saved non-English choice is loaded right after and swapped
// in (changeLanguage() only flips the active language once it has loaded).
void i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    // Bundled English + backend-loaded everything else.
    partialBundledLanguages: true,
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false }, // React already escapes.
    returnNull: false,
    // Surface missing keys loudly in dev so gaps in the extraction are obvious.
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: import.meta.env.DEV
      ? (_lngs, _ns, key) => console.warn(`[i18n] missing translation key: ${key}`)
      : undefined,
  });

applyDocumentLanguage(i18n.language);
i18n.on("languageChanged", applyDocumentLanguage);

const initialLanguage = getInitialLanguage();
if (initialLanguage !== "en") void i18n.changeLanguage(initialLanguage);

export default i18n;
