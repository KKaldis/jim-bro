/**
 * Chat runs — one agent turn, decoupled from whatever connection started it.
 *
 * A run belongs to the USER, not to a socket. It executes the agent loop to
 * completion (persisting the turn) regardless of who is listening, buffers
 * every event with a sequence number, and broadcasts each one to all of the
 * user's live listeners (WebSocket tabs, or a legacy SSE response). A client
 * whose connection drops — iOS Safari kills sockets the moment the screen
 * locks or the app is backgrounded — reconnects and replays everything after
 * the last seq it saw, so no reply is lost or duplicated.
 *
 * Invariants:
 *   - At most one ACTIVE run per user, so two turns can't interleave their
 *     history writes. A finished run is retained for RUN_RETAIN_MS purely so a
 *     reconnecting client can replay its tail (including the `end`).
 *   - Listener registration + replay happen in one synchronous block, so a
 *     listener can never miss or double-receive an event.
 *   - Only an explicit stop cuts a run short. A mutating-tool gate is released
 *     (aborted) only once the user has had NO listener for GATE_ORPHAN_MS —
 *     long enough to survive a phone lock, short enough not to park the agent
 *     for the full 10-minute gate timeout. The abandoned gate's card is
 *     persisted and stays savable via /chat/tool/:id/resolve.
 *
 * Single-process, in-memory — same caveat as the gate registry in index.ts.
 */

import { chatStream, type ConfirmToolFn, type StreamEvent, type UserMessage } from "@fa/agent";
import type { Logger } from "@fa/logger";

type ChatOptions = NonNullable<Parameters<typeof chatStream>[2]>;

export type RunEndReason = "completed" | "error" | "stopped";

export type RunInfo = { run_id: string; user_text: string; running: boolean };

// Server → client wire messages. Shared by the WebSocket and (filtered to one
// run) the SSE fallback.
export type RunMessage =
  // First message a subscriber gets: the run it is now caught up on, if any.
  // A client that asked to resume a different run knows that one is gone.
  | { type: "ready"; run: RunInfo | null }
  | ({ type: "run" } & RunInfo)
  | { type: "event"; run_id: string; seq: number; event: StreamEvent }
  | { type: "end"; run_id: string; reason: RunEndReason };

export type RunListener = (msg: RunMessage) => void;

const RUN_RETAIN_MS = 5 * 60_000;
const GATE_ORPHAN_MS = 2 * 60_000;

class ChatRun {
  readonly events: Array<{ seq: number; event: StreamEvent }> = [];
  ended: RunEndReason | null = null;
  // `ended` flips the moment the client-visible run is over (incl. an
  // immediate stop); `settled` only once the agent loop has actually exited.
  // The one-run-per-user lock keys on `settled` so a stopped loop can't still
  // be persisting while the next turn starts.
  settled = false;
  readonly stop = new AbortController();
  readonly gateAbort = new AbortController();

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly userText: string,
  ) {}

  info(): RunInfo {
    return { run_id: this.id, user_text: this.userText, running: this.ended == null };
  }
}

const RUNS = new Map<string, ChatRun>(); // userId → latest run (active or retained)
const LISTENERS = new Map<string, Set<RunListener>>(); // userId → listeners
const ORPHAN_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();

function broadcast(userId: string, msg: RunMessage): void {
  const set = LISTENERS.get(userId);
  if (!set) return;
  for (const l of set) {
    try {
      l(msg);
    } catch {
      // A dead listener must not break the run or the other listeners; its
      // own close path unsubscribes it.
    }
  }
}

function emit(run: ChatRun, event: StreamEvent): void {
  if (run.ended) return;
  const seq = run.events.length + 1;
  run.events.push({ seq, event });
  broadcast(run.userId, { type: "event", run_id: run.id, seq, event });
}

function endRun(run: ChatRun, reason: RunEndReason): void {
  if (run.ended) return;
  run.ended = reason;
  broadcast(run.userId, { type: "end", run_id: run.id, reason });
}

function armOrphanTimer(userId: string): void {
  const run = RUNS.get(userId);
  if (!run || run.ended || ORPHAN_TIMERS.has(userId)) return;
  ORPHAN_TIMERS.set(
    userId,
    setTimeout(() => {
      ORPHAN_TIMERS.delete(userId);
      // Nobody came back to click Save — release any gate the agent is parked
      // on (and any it opens later) so the loop finishes and persists.
      if (RUNS.get(userId) === run) run.gateAbort.abort();
    }, GATE_ORPHAN_MS),
  );
}

function clearOrphanTimer(userId: string): void {
  const t = ORPHAN_TIMERS.get(userId);
  if (t) clearTimeout(t);
  ORPHAN_TIMERS.delete(userId);
}

function listenerCount(userId: string): number {
  return LISTENERS.get(userId)?.size ?? 0;
}

export function activeRun(userId: string): ChatRun | null {
  const run = RUNS.get(userId);
  return run && !run.settled ? run : null;
}

// Whether `runId` is the user's current (active or retained) run — a client
// re-sending an unconfirmed start after a reconnect must not run it twice.
export function isKnownRun(userId: string, runId: string): boolean {
  return RUNS.get(userId)?.id === runId;
}

export type StartRunArgs = {
  userId: string;
  runId: string;
  userText: string;
  userMessage: UserMessage;
  options: ChatOptions;
  makeConfirmTool: (signal: AbortSignal) => ConfirmToolFn;
  log: Logger;
};

export function startRun(
  args: StartRunArgs,
): { ok: true; run: ChatRun } | { ok: false; status: number; error: string } {
  const { userId } = args;
  if (activeRun(userId)) {
    return {
      ok: false,
      status: 409,
      error: "previous reply is still finishing — try again in a moment",
    };
  }
  const run = new ChatRun(args.runId, userId, args.userText);
  RUNS.set(userId, run);
  run.stop.signal.addEventListener("abort", () => run.gateAbort.abort(), { once: true });
  clearOrphanTimer(userId);
  if (listenerCount(userId) === 0) armOrphanTimer(userId);
  broadcast(userId, { type: "run", ...run.info() });
  void execute(run, args);
  return { ok: true, run };
}

async function execute(run: ChatRun, args: StartRunArgs): Promise<void> {
  const { log } = args;
  const start = Date.now();
  let reason: RunEndReason = "completed";
  try {
    for await (const ev of chatStream(
      run.userId,
      args.userMessage,
      args.options,
      args.makeConfirmTool(run.gateAbort.signal),
    )) {
      if (run.stop.signal.aborted) {
        reason = "stopped";
        log.info("chat run stopped by user", { run_id: run.id, ms: Date.now() - start });
        break;
      }
      emit(run, ev);
      if (ev.type === "done") {
        log.info("chat run done", {
          run_id: run.id,
          ms: Date.now() - start,
          listeners: listenerCount(run.userId),
          iterations: ev.iterations,
          stop_reason: ev.stop_reason,
          in_tokens: ev.usage.input_tokens,
          out_tokens: ev.usage.output_tokens,
          cache_read: ev.usage.cache_read_input_tokens,
        });
        break;
      }
      if (ev.type === "error") {
        reason = "error";
        log.error("chat run errored", new Error(ev.message), {
          run_id: run.id,
          ms: Date.now() - start,
        });
        break;
      }
    }
  } catch (err) {
    reason = "error";
    log.error("chat run threw", err instanceof Error ? err : new Error(String(err)), {
      run_id: run.id,
      ms: Date.now() - start,
    });
    emit(run, { type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    endRun(run, run.stop.signal.aborted ? "stopped" : reason);
    run.settled = true;
    clearOrphanTimer(run.userId);
    setTimeout(() => {
      if (RUNS.get(run.userId) === run) RUNS.delete(run.userId);
    }, RUN_RETAIN_MS);
  }
}

// Stop the user's active run. The client sees `end: stopped` immediately; the
// agent loop exits on its next event (gates are released right away).
// `runId`, when given, must match — a late stop can't kill a newer turn.
export function stopRun(userId: string, log: Logger, runId?: string): boolean {
  const run = activeRun(userId);
  if (!run || (runId != null && run.id !== runId)) return false;
  log.info("chat stop requested", { run_id: run.id });
  run.stop.abort();
  endRun(run, "stopped");
  return true;
}

// Register a listener for all of the user's runs, first replaying what it
// missed:
//   - `resume` names a run the client was following → replay its events after
//     `after_seq` (plus `end` if it has finished meanwhile).
//   - otherwise, if a run is still active → announce it and replay from the
//     start, so a freshly opened/reloaded tab picks up an in-flight reply.
// The listener first gets `ready` naming the run (if any) it is caught up on.
// Returns an unsubscribe function. Replay + registration are synchronous: no gaps.
export function subscribe(
  userId: string,
  listener: RunListener,
  resume: { run_id: string; after_seq: number } | null,
): () => void {
  const run = RUNS.get(userId) ?? null;
  const replay = run && (resume?.run_id === run.id || !run.ended) ? run : null;
  const caughtUp = replay?.info() ?? null;
  listener({ type: "ready", run: caughtUp });
  if (replay && caughtUp) {
    const after = resume?.run_id === replay.id ? resume.after_seq : 0;
    listener({ type: "run", ...caughtUp });
    for (const e of replay.events) {
      if (e.seq > after) listener({ type: "event", run_id: replay.id, seq: e.seq, event: e.event });
    }
    if (replay.ended) listener({ type: "end", run_id: replay.id, reason: replay.ended });
  }

  let set = LISTENERS.get(userId);
  if (!set) LISTENERS.set(userId, (set = new Set()));
  set.add(listener);
  clearOrphanTimer(userId);

  return () => {
    const s = LISTENERS.get(userId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) {
      LISTENERS.delete(userId);
      armOrphanTimer(userId);
    }
  };
}
