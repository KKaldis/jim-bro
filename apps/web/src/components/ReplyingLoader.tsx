import { useTranslation } from "react-i18next";
import { useTypewriter, useLoaderPhrases, LOADER_NAME } from "../lib/useTypewriter";
import { cn } from "../lib/utils";
import { FlexLoader } from "./FlexLoader";

// Animated "<agent> is …" status: flexing arm + a cycling gym-bro phrase typed
// out char-by-char + a blinking caret (dim italic). Shown while we wait on the
// coach's first token. Shared by the in-chat bubble loader (Chat.tsx) and the
// collapsed chat-dock title (ChatDock.tsx) so both stay visually identical.
export function ReplyingLoader({ className }: { className?: string }) {
  const { t } = useTranslation();
  const phrases = useLoaderPhrases();
  const text = useTypewriter(phrases);
  return (
    <span
      className={cn("thinking-dim min-w-0 items-center gap-1", className)}
      role="status"
      aria-live="polite"
      aria-label={t("chat.loaderReplying", { name: LOADER_NAME })}
    >
      <FlexLoader className="size-[1.6em] text-current [--flex-stroke:36px]" />
      <span className="min-w-0 truncate">
        <span className="not-italic">{t("chat.loaderIs", { name: LOADER_NAME })} </span>
        {text}
      </span>
      <span className="tw-cursor" aria-hidden>
        ▍
      </span>
    </span>
  );
}
