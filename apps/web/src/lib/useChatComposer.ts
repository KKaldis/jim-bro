import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as RKeyboardEvent, ChangeEvent as RChangeEvent } from "react";
import { useFeature } from "./features";
import { useChatBridge } from "./chatBridge";
import { useSpeechRecognition } from "./useSpeechRecognition";
import { usePendingImages, type OutgoingImage } from "./composerImages";

export type ComposerSubmit = { text: string; images: OutgoingImage[] };

// Owns all chat-input state (text, staged images, dictation) and the submit
// pipeline, so the desktop <ChatComposer> panel and the mobile coach bar share
// one implementation. The consumer supplies `onSend` (which routes to Chat's
// sendMessage, directly on desktop or through the bridge on mobile); this hook
// gathers the payload, hands it over, and clears the draft. Reply locale + busy
// come from the shared chatBridge so both inputs stay consistent.
export function useChatComposer({ onSend }: { onSend: (payload: ComposerSubmit) => void }) {
  const busy = useChatBridge((s) => s.busy);
  const locale = useChatBridge((s) => s.locale);
  const canChat = useFeature("ai_chat");
  const images = usePendingImages();
  const [hasText, setHasText] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Dictation — the hook prepends the pre-dictation text, so we just write the
  // full transcript back into the (uncontrolled) textarea. Language follows the
  // shared reply locale.
  const handleTranscript = useCallback((transcript: string) => {
    if (textareaRef.current) textareaRef.current.value = transcript;
    setHasText(transcript.length > 0);
  }, []);
  const {
    isListening: listening,
    start: startMic,
    stop: stopMic,
    error: micError,
  } = useSpeechRecognition({ lang: locale, onSessionTranscript: handleTranscript });
  const toggleMic = () => {
    if (listening) stopMic();
    else startMic(textareaRef.current?.value ?? "");
  };

  const submit = () => {
    if (busy || !canChat) return;
    // Stop any in-flight dictation before reading the textarea so a trailing
    // result can't repopulate it post-send.
    if (listening) stopMic();
    const text = textareaRef.current?.value.trim() ?? "";
    const outgoing = images.outgoing;
    if (!text && outgoing.length === 0) return;
    onSend({ text, images: outgoing });
    if (textareaRef.current) textareaRef.current.value = "";
    setHasText(false);
    images.clear();
  };

  const onKeyDown = (e: RKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+Enter inserts a newline at the caret instead of sending.
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const v = ta.value;
      ta.value = v.slice(0, start) + "\n" + v.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 1;
      const next = ta.value.length > 0;
      if (next !== hasText) setHasText(next);
      return;
    }
    if (e.shiftKey) return;
    e.preventDefault();
    submit();
  };

  const onTextareaChange = (e: RChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value.length > 0;
    if (next !== hasText) setHasText(next);
  };

  const canSend = !busy && (hasText || images.pending.length > 0);

  return {
    textareaRef,
    hasText,
    onKeyDown,
    onTextareaChange,
    listening,
    toggleMic,
    micError,
    canSend,
    canChat,
    busy,
    submit,
    // Interrupt the in-flight reply. Routes through the always-mounted Chat via
    // the bridge, so both the desktop composer and the mobile dock can stop it.
    stop: () => useChatBridge.getState().stop(),
    pending: images.pending,
    attachErr: images.attachErr,
    ingestFiles: images.ingestFiles,
    removePending: images.removePending,
    canImage: images.canImage,
  };
}

export type ChatComposerApi = ReturnType<typeof useChatComposer>;
