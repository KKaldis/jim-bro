import { create } from "zustand";
import type { OutgoingImage } from "./composerImages";
import type { ToolCategory } from "./toolCategory";

// The running tool surfaced to the dock — label plus its category, so the dock
// badge can colour itself exactly like the chat transcript's tool pills.
export type ActiveTool = { label: string; category: ToolCategory };

// Imperative bridge to the always-mounted <Chat> so App-level UI (the mobile
// chat dock and the thinking/reset drawer that float over the data screens) can
// drive the conversation without owning the ~2400-line streaming engine.
//
// Chat registers its `send` / `reset` on mount and mirrors its `busy` flag here;
// the dock and drawer call these. This holds function refs and transient session
// state, so it deliberately lives OUTSIDE the persisted uiStore.

type ChatApi = {
  // Send a message (text and/or images) through Chat's normal pipeline. The
  // mobile coach bar is a full composer now, so it can attach images too.
  send: (text: string, images?: OutgoingImage[]) => void;
  // Interrupt the in-flight stream (aborts the fetch; the server unwinds the
  // agent + releases any tool gate on client disconnect). No-op when idle.
  stop: () => void;
  // Wipe the conversation (Chat's existing /reset flow).
  reset: () => void | Promise<void>;
  // Reveal the full chat transcript (App closes the data drawer). Used by the
  // coach toasts' "Open chat" action and by tapping a confirmation-gate toast.
  openChat: () => void;
};

type ChatBridge = ChatApi & {
  // True while a turn is streaming, mirrored from Chat so the dock can disable
  // its send button.
  busy: boolean;
  // Whether the mobile coach bar's input is currently open. The dock sets it;
  // Chat reads it to pad the transcript + scroll to bottom so the last messages
  // separate from (and clear) the opened input overlay.
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  // The per-message reply locale (BCP47), shared so the desktop composer and the
  // mobile coach bar drive one value. Chat seeds it from the product language and
  // reads it when building the request; either language picker writes it.
  locale: string;
  setLocale: (locale: string) => void;
  // The tool the agent is currently running (label + category), or null between
  // tools / when idle. Chat sets it on tool_started and clears it on
  // tool_finished; the mobile dock surfaces it (coloured by category, like the
  // transcript's tool pills) so a data screen still sees what the coach is doing
  // without the (hidden) transcript. Cleared on turn end via setBusy(false).
  activeTool: ActiveTool | null;
  // Whether the coach is reachable from outside the chat screen yet — flips true
  // once Chat has mounted and registered. The dock renders disabled until then.
  ready: boolean;
  setBusy: (busy: boolean) => void;
  setActiveTool: (tool: ActiveTool | null) => void;
  register: (api: ChatApi) => void;
  clear: () => void;
};

const noop = () => {};

export const useChatBridge = create<ChatBridge>((set) => ({
  send: noop,
  stop: noop,
  reset: noop,
  openChat: noop,
  busy: false,
  dockOpen: false,
  setDockOpen: (dockOpen) => set({ dockOpen }),
  // Seeded by Chat from the product language on mount; corrected there before any
  // send, so this default is only a pre-mount placeholder.
  locale: "en-US",
  setLocale: (locale) => set({ locale }),
  activeTool: null,
  ready: false,
  // A turn ending (busy → false) always clears any lingering tool label so the
  // dock never shows a stale "…" after the coach is done.
  setBusy: (busy) => set(busy ? { busy } : { busy, activeTool: null }),
  setActiveTool: (activeTool) => set({ activeTool }),
  register: (api) => set({ ...api, ready: true }),
  clear: () =>
    set({ send: noop, stop: noop, reset: noop, openChat: noop, ready: false, activeTool: null }),
}));
