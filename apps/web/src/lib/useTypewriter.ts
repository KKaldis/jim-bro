import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

// Gym-bro flavored status lines cycled by the "<agent> is …" loader while we
// wait on the model's first token. Module-level so the typewriter effect's deps
// stay stable across renders. Shared by the in-chat loader (Chat.tsx) and the
// collapsed chat-dock title (ChatDock.tsx).
export const LOADER_PHRASES: readonly string[] = [
  "thinking",
  "cooking",
  "pushing",
  "crunching",
  "percolating",
  "flexing",
  "noodling",
  "bulking",
  "spotting you",
  "vibing",
  "ruminating",
  "warming up",
  "repping out",
  "loading plates",
  "counting macros",
  "cutting weight",
  "stretching",
  "chalking up",
  "racking weights",
  "progressive overloading",
  "supersetting",
  "deloading",
  "hitting PRs",
  "planning your split",
  "dialing in form",
  "logging sets",
  "building your plan",
  "tracking progress",
  "leg day-ing",
];

// The agent name shown in the loader: "Jim", the casual short form of Jim Rat.
export const LOADER_NAME = "Jim";

// Localized loader phrases, memoized per language. t(..., { returnObjects: true })
// returns a NEW array every render, so callers must memoize it — otherwise
// useTypewriter's [phrases] effect re-runs each render and resets the animation.
export function useLoaderPhrases(): string[] {
  const { t, i18n } = useTranslation();
  return useMemo(() => {
    const p = t("chat.loaderPhrases", { returnObjects: true });
    return Array.isArray(p) && p.length ? (p as string[]) : [...LOADER_PHRASES];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);
}

// Types out the current phrase one char at a time, holds, then backspaces it
// away before advancing to the next phrase (looping). Returns the partial
// string to render.
export function useTypewriter(
  phrases: readonly string[],
  {
    typeMs = 45,
    eraseMs = 25,
    holdMs = 1200,
  }: { typeMs?: number; eraseMs?: number; holdMs?: number } = {},
) {
  const [display, setDisplay] = useState("");
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * phrases.length));

  useEffect(() => {
    const phrase = phrases[phraseIdx % phrases.length];
    let charIdx = 0;
    let timer: ReturnType<typeof setTimeout>;

    const erase = () => {
      charIdx -= 1;
      setDisplay(phrase.slice(0, charIdx));
      if (charIdx > 0) {
        timer = setTimeout(erase, eraseMs);
      } else {
        setPhraseIdx((p) => p + 1);
      }
    };

    const type = () => {
      charIdx += 1;
      setDisplay(phrase.slice(0, charIdx));
      if (charIdx < phrase.length) {
        timer = setTimeout(type, typeMs);
      } else {
        timer = setTimeout(erase, holdMs);
      }
    };

    setDisplay("");
    timer = setTimeout(type, typeMs);
    return () => clearTimeout(timer);
  }, [phrases, phraseIdx, typeMs, eraseMs, holdMs]);

  return display;
}
