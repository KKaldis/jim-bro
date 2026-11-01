import React from "react";

interface UseSpeechRecognitionOptions {
  lang?: string;
  onSessionTranscript?: (transcript: string) => void;
  onError?: (error: string) => void;
}

interface SpeechRecognitionHook {
  isSupported: boolean;
  isListening: boolean;
  // prefix: text already in the textarea before dictation starts.
  // The hook prepends it to every emitted transcript so the caller
  // can do a simple setValue(transcript) with no extra ref logic.
  start: (prefix?: string) => void;
  stop: () => void;
  error: string | null;
}

// Minimal shape of the Web Speech API — typed locally so we avoid `any` without
// pulling in the full lib.dom SpeechRecognition typings (not in all TS targets).
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike {
  error?: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const getSpeechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
};

export const useSpeechRecognition = ({
  lang = "en-US",
  onSessionTranscript,
  onError,
}: UseSpeechRecognitionOptions = {}): SpeechRecognitionHook => {
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  // Text in the textarea at the moment dictation started.
  const prefixRef = React.useRef("");
  // Finals accumulated across phrase restarts (continuous=false, one phrase per session).
  const sessionBaseRef = React.useRef("");
  const finalTranscriptRef = React.useRef("");
  const isListeningRef = React.useRef(false);
  const langRef = React.useRef(lang);
  const onSessionTranscriptRef = React.useRef(onSessionTranscript);
  const onErrorRef = React.useRef(onError);
  const [isListening, setIsListening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    langRef.current = lang;
    onSessionTranscriptRef.current = onSessionTranscript;
    onErrorRef.current = onError;
  }, [lang, onSessionTranscript, onError]);

  const isSupported = React.useMemo(() => getSpeechRecognitionCtor() !== null, []);

  const buildTranscript = (final: string, interim: string): string => {
    const prefix = prefixRef.current.trim();
    const base = sessionBaseRef.current.trim();
    const current = (final + interim).trim();
    const dictated = base && current ? `${base} ${current}` : base || current;
    if (!prefix) return dictated;
    if (!dictated) return prefix;
    return `${prefix} ${dictated}`;
  };

  const launchSession = React.useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      isListeningRef.current = false;
      setIsListening(false);
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = langRef.current;
    recognitionRef.current = recognition;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      if (recognitionRef.current !== recognition) return;
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += chunk;
        else interim += chunk;
      }
      finalTranscriptRef.current = final;
      onSessionTranscriptRef.current?.(buildTranscript(final, interim));
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      if (recognitionRef.current !== recognition) return;
      const msg = event?.error ?? "speech-error";
      if (msg === "no-speech" || msg === "aborted") return;
      setError(msg);
      isListeningRef.current = false;
      setIsListening(false);
      onErrorRef.current?.(msg);
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      if (isListeningRef.current) {
        // Session ended after one phrase (continuous=false). Save the finals
        // and restart a fresh instance so the next phrase starts clean with
        // no accumulated event.results that could cause duplication.
        const base = sessionBaseRef.current.trim();
        const ending = finalTranscriptRef.current.trim();
        sessionBaseRef.current = base && ending ? `${base} ${ending}` : base || ending;
        finalTranscriptRef.current = "";
        launchSession();
      } else {
        recognitionRef.current = null;
        setIsListening(false);
      }
    };

    try {
      recognition.start();
      setIsListening(true);
    } catch {
      isListeningRef.current = false;
      setIsListening(false);
    }
  }, []);

  const start = React.useCallback(
    (prefix = "") => {
      if (recognitionRef.current) {
        const old = recognitionRef.current;
        recognitionRef.current = null;
        try {
          old.abort();
        } catch {
          /* ignore */
        }
      }

      setError(null);
      prefixRef.current = prefix;
      sessionBaseRef.current = "";
      finalTranscriptRef.current = "";
      isListeningRef.current = true;

      launchSession();
    },
    [launchSession],
  );

  const stop = React.useCallback(() => {
    isListeningRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    }
    setIsListening(false);
  }, []);

  React.useEffect(
    () => () => {
      isListeningRef.current = false;
      const recognition = recognitionRef.current;
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  return { isSupported, isListening, start, stop, error };
};
