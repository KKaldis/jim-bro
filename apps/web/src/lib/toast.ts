// Central CRUD toast helpers. Every create/update/delete in the app — whether
// the user triggers it from a data screen or the agent performs it mid-chat —
// funnels a success/error message through here so notifications look and read
// consistently. The <Toaster/> host (components/ui/sonner.tsx) is mounted once
// at the App root and positioned top-center.
//
// There are two write surfaces, so there are two message derivations:
//   - Agent tools reused as the UI's mutation API (POST /tools/run) and the
//     agent's own tool calls in chat → keyed by tool name (toolCrudMessage).
//   - The generated REST client (orval → customFetch) → keyed by HTTP
//     method + URL (httpCrudMessage).
// Both collapse into a friendly "{Noun} {verb}" line.
import { toast } from "sonner";

import i18n from "../i18n";

// Verb tokens (tool-name prefix) we have a localized past-tense form for.
// Falls back to the "save" verb.
const VERB_TOKENS = new Set([
  "log",
  "add",
  "save",
  "import",
  "update",
  "replace",
  "set",
  "activate",
  "delete",
  "remove",
  "submit",
]);

// (submit_feature_request → "Feature request submitted" via the auto-derived
// noun; the "submit" verb reads better than the "save" fallback.)

// Tool names whose noun doesn't read well when auto-derived — resolved through
// lib.toast.noun.<name>. Any name not listed falls back to a capitalized,
// space-joined derivation of the tool-name remainder.
const NOUN_KEYS = new Set([
  "update_profile",
  "update_pantry",
  "import_pantry",
  "log_body_comp",
  "delete_body_comp_entry",
  "update_body_comp_entry",
  "log_planned_meal",
  "log_recipe",
  "update_recipe_portion",
  "set_recipe_favorite",
  "log_workout_session",
  "delete_workout_session",
  "delete_cardio_entry",
  "update_cardio_entry",
  "log_measurements",
  "add_exercise_to_plan_day",
  "remove_exercise_from_plan_day",
  "update_plan_exercise",
  "replace_plan_exercise",
  "update_workout_plan_day",
]);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Assemble a localized "<Noun> <verb>" line. Kept as a single message template
// (lib.toast.message) so translations can reorder noun/verb per language.
function crudLine(noun: string, verb: string): string {
  return i18n.t("lib.toast.message", { noun, verb });
}

// "log_meal" → "Meal logged", "update_pantry" → "Pantry updated",
// "delete_recipe" → "Recipe removed" (localized).
export function toolCrudMessage(name: string): string {
  const [verbToken, ...rest] = name.split("_");
  const verb = i18n.t(
    VERB_TOKENS.has(verbToken) ? `lib.toast.verb.${verbToken}` : "lib.toast.verb.save",
  );
  const noun = NOUN_KEYS.has(name)
    ? i18n.t(`lib.toast.noun.${name}`)
    : rest.length
      ? capitalize(rest.join(" "))
      : i18n.t("lib.toast.noun.item");
  return crudLine(noun, verb);
}

// Resource noun (i18n key under lib.toast.httpNoun) + whether POSTs to it read
// as "logged" (day-entry logs) rather than "saved" (records the user creates).
// Ordered longest-prefix-first so e.g. /workout/sessions matches before a bare
// /workout would.
const HTTP_RESOURCES: Array<{ prefix: string; nounKey: string; logish?: boolean }> = [
  { prefix: "/diet/log-planned", nounKey: "meal", logish: true },
  { prefix: "/diet/plans", nounKey: "diet_plan" },
  { prefix: "/diet/days", nounKey: "diet_plan" },
  { prefix: "/diet/meals", nounKey: "diet_plan" },
  { prefix: "/diet/portions", nounKey: "diet_plan" },
  { prefix: "/workout/sessions", nounKey: "workout_session" },
  { prefix: "/workout/plans", nounKey: "workout_plan" },
  { prefix: "/body", nounKey: "body_entry", logish: true },
  { prefix: "/cardio", nounKey: "cardio", logish: true },
  { prefix: "/measurements", nounKey: "measurements", logish: true },
  { prefix: "/steps", nounKey: "steps", logish: true },
  { prefix: "/water", nounKey: "water", logish: true },
  { prefix: "/me", nounKey: "profile" },
];

// Non-GET endpoints that aren't user-facing CRUD (chat, scans, auth). Matching
// one of these — or no known resource — yields null, i.e. no toast.
function resolveHttpResource(pathname: string) {
  return HTTP_RESOURCES.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
}

// Derive a CRUD message from an HTTP method + URL. Returns null for endpoints
// outside the CRUD allowlist so we stay silent on chat/scan/auth calls.
export function httpCrudMessage(method: string, url: string): string | null {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  // url may be relative ("/body/2026-07-01") or absolute; take just the path.
  const pathname = url.replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0];
  const res = resolveHttpResource(pathname);
  if (!res) return null;
  const noun = i18n.t(`lib.toast.httpNoun.${res.nounKey}`);
  // A trailing /activate on a plan reads best as "activated".
  if (pathname.endsWith("/activate")) return crudLine(noun, i18n.t("lib.toast.verb.activate"));
  const verbToken =
    m === "DELETE"
      ? "delete"
      : m === "PUT" || m === "PATCH"
        ? "update"
        : res.logish
          ? "log"
          : "save";
  return crudLine(noun, i18n.t(`lib.toast.verb.${verbToken}`));
}

// Reusing the message text as the toast id collapses a burst of identical
// saves (e.g. StepCounter's periodic autosave) into one updating toast instead
// of a stack.
export function toastSuccess(message: string): void {
  toast.success(message, { id: `ok:${message}` });
}

export function toastError(message: string): void {
  toast.error(message, { id: `err:${message}` });
}
