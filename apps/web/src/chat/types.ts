// Chat transcript types and helpers shared by the Chat panel, transcript rendering and history parsing.
import { MUTATING_TOOL_NAMES } from "@fa/shared";

import type { JsonSchema } from "../forms/ToolForm";
import type { ToolCardStatus } from "../forms/ToolFormCard";
import type { ToolCategory } from "../lib/toolCategory";

export type User = { id: string; email: string; name?: string | null };

// A web-search source the model cited (from the `citations` stream event or a
// text block's `citations` on history reload). Rendered as a "Sources" footer.
export type Citation = { url?: string; title?: string; citedText?: string };

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  // De-duped sources footer for an assistant turn. Accumulated from `citations`
  // events live, or gathered from text blocks' citations on history reload.
  | { kind: "sources"; items: Citation[] }
  | { kind: "image"; src: string }
  // Restored-history stand-in for a stripped image we no longer have the bytes
  // for: rendered as an attachment note ("Image no longer available") with the
  // persisted vision caption as a second line when one exists.
  | { kind: "image_note"; description?: string }
  | {
      kind: "tool";
      id: string;
      label: string;
      category: ToolCategory;
      ms?: number;
      ok?: boolean;
    }
  // Pre-execution gate form. Replaces the `tool` pill for mutating tools
  // once the server emits `tool_proposed`. status drives the card chrome
  // (pending/submitting/saved/canceled/error).
  | {
      kind: "tool_form";
      id: string;
      toolName: string;
      label: string;
      category: ToolCategory;
      schema: JsonSchema | null;
      proposedInput: Record<string, unknown>;
      // Identity folded back after a create-or-replace tool's first save (see
      // getSavedIdentity) so a later resubmit updates that entry, not a dupe.
      identityPatch?: Record<string, unknown>;
      status: ToolCardStatus;
      errorMessage?: string;
    }
  // Rich result card for read/compute tools (e.g. the calorie ring for
  // get_todays_macros, a metric gauge for compute_bmi). Appended when such a
  // tool finishes successfully (live) or rebuilt from the persisted tool_result
  // on history reload. `data` is the tool's raw structured result; the card
  // component (cards/resultCards.tsx) reads it defensively and renders null when
  // it isn't card-able, so the agent's text remains the fallback.
  | {
      kind: "tool_result_card";
      id: string;
      toolName: string;
      category: ToolCategory;
      data: unknown;
    };

// `interrupted` marks an assistant turn the user stopped mid-reply — TurnView
// renders a small "Stopped" footer so a truncated answer doesn't read as a bug.
export type Turn = { id: string; who: "you" | "assistant"; blocks: Block[]; interrupted?: boolean };

export type StreamState = {
  turnId: string;
  kind: "text" | "thinking";
  text: string;
};
export type StreamListener = (s: StreamState | null) => void;

// The gated, confirmation-required tools — sourced from the shared
// MUTATING_TOOL_NAMES so this set can't drift from the agent's gate (the agent
// builds its own MUTATING_TOOLS from the same list). Every gated data-write
// rehydrates as a form card on history reload. `ask_user` is intentionally not
// in the shared list: the server gates it for its button-picker UI, but it
// writes nothing, so it shouldn't rehydrate as a saved card (it's added to
// GATE_FORM_TOOLS below instead).
//
// NOTE: this set is no longer used to decide when to refresh the data screens.
// That now happens after ANY successful tool (see the tool_finished handler),
// because several non-gated tools also write (activate_diet_plan,
// compute_targets + save_as_default) and keeping a refresh allowlist in sync
// proved fragile.
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(MUTATING_TOOL_NAMES);
