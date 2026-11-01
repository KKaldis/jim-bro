/**
 * Chat: the HTTP + WebSocket chat transports, the pre-execution tool gate,
 * direct tool runs, conversation history and link previews.
 */
import {
  chat,
  type ConfirmToolFn,
  executeTool,
  type FaImageBlock,
  type FaTextBlock,
  getConversation,
  getConversationPage,
  isMutatingTool,
  resetConversation,
  type ToolConfirmation,
  toolSchemas,
  type UserMessage,
} from "@fa/agent";
import { db, schema } from "@fa/db_postgres";
import { logger, type Logger } from "@fa/logger";
import { ChatRequest, type ImageInput } from "@fa/shared/schemas";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { eq } from "drizzle-orm";

import {
  activeRun,
  isKnownRun,
  type RunMessage,
  startRun,
  stopRun,
  subscribe,
} from "../chat-runs.ts";
import { todayIso } from "../dates.ts";
import { aiPreflight } from "../extensions.ts";
import { ALLOWED_ORIGINS, authed, type AuthedCtx, jsonError, requireSession } from "../http.ts";
import { fetchLinkPreview, type LinkPreview } from "../link-preview.ts";
import { consumeToken } from "../rate-limit.ts";
import { type Route, route } from "../router.ts";

// ---------- chat request → canonical content blocks ----------

// The `[Viewing: ...]` tag must name screens/tabs exactly as the user sees them
// on the nav buttons, not by our internal store keys — otherwise the agent says
// "your nutrition screen" when the button reads "Food", confusing the user. The
// client sends the already-localized label (context_view_label) built from the
// SAME i18n strings the buttons use, so the match holds in every language (the
// Greek labels intentionally diverge from a literal translation — "Diets" → the
// button reads "Πλάνα"). These English maps are only the fallback for when the
// client omits the label; keep them in sync with apps/web's default (English)
// nav.food / nutrition.tabs.* / workout.sections.* if a button is renamed.
const SCREEN_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  nutrition: "Food",
  workout: "Workout",
  body: "Body",
};
const SECTION_LABELS: Record<string, string> = {
  summary: "Nutrition",
  pantry: "Pantry",
  recipes: "Recipes",
  diet: "Diets",
  training: "Training",
  progress: "Progress",
  plans: "Plans",
};

function buildUserMessage(
  message: string,
  images: ImageInput[] | undefined,
  contextDate: string | undefined,
  locale: string | undefined,
  contextScreen: string | undefined,
  contextSection: string | undefined,
  contextViewLabel: string | undefined,
  userName: string | undefined,
): UserMessage {
  // Per-turn tags injected at the start of the user message. Each one is
  // explained in the system prompt and the agent reads them as ambient
  // context (today's date, currently-viewed day, browser locale). Stays in
  // persisted history as plain text once the turn is over.
  //
  // - `[Today: X]`: always present. The agent's authoritative current date.
  //   The model has no clock of its own — without this tag it would guess
  //   from training-cutoff intuition. Always-on so the system prompt can
  //   safely reference it as the source of truth.
  // - `[Selected date: X]`: only when X !== today, so today-view chats stay
  //   compact. When present, the agent treats it as the default `date` for
  //   status queries and resolves relative-day references against it.
  // - `[Locale: X]`: only when X is non-English, so default English chats
  //   stay tag-free (Claude defaults to English).
  // - `[Viewing: X]`: the data screen currently on the user's screen (plus its
  //   active sub-tab as `screen/section` when it has one). Lets the agent
  //   resolve deictic references ("add this here", "log it") against what the
  //   user is actually looking at. Absent when the user is on the bare chat
  //   (mobile, data drawer closed), so those turns stay tag-free.
  // - `[User name: X]`: the name the user set (at signup or in User Profile),
  //   so the coach can address them by it. Absent when they never gave one.
  const today = todayIso();
  const tags: string[] = [`[Today: ${today}]`];
  if (userName) tags.push(`[User name: ${userName}]`);
  if (contextDate && contextDate !== today) {
    tags.push(`[Selected date: ${contextDate}]`);
  }
  if (locale && !/^en\b/i.test(locale)) {
    tags.push(`[Locale: ${locale}]`);
  }
  if (contextScreen) {
    // Prefer the client's localized label (matches the user's buttons exactly).
    // Fall back to the English key→label maps, then to the raw key, so the tag
    // is never silently dropped.
    const fallback = `${SCREEN_LABELS[contextScreen] ?? contextScreen}${
      contextSection ? `/${SECTION_LABELS[contextSection] ?? contextSection}` : ""
    }`;
    tags.push(`[Viewing: ${contextViewLabel || fallback}]`);
  }
  const prefix = tags.join("\n") + "\n\n";

  if (!images?.length) return prefix + message;
  const blocks: Array<FaTextBlock | FaImageBlock> = [];
  blocks.push({ kind: "text", text: prefix.trimEnd() });
  for (const img of images) {
    if ("url" in img) {
      blocks.push({ kind: "image", source: { kind: "url", url: img.url } });
    } else {
      blocks.push({
        kind: "image",
        source: {
          kind: "base64",
          mediaType: img.media_type,
          data: img.data,
        },
      });
    }
  }
  if (message.trim()) blocks.push({ kind: "text", text: message });
  return blocks;
}

type ChatRequestData = {
  message: string;
  images?: ImageInput[];
  context_date?: string;
  context_screen?: "dashboard" | "nutrition" | "workout" | "body";
  context_section?: "summary" | "pantry" | "diet" | "recipes" | "training" | "progress" | "plans";
  context_view_label?: string;
  thinking?: boolean;
  locale?: string;
};

function validateChatBody(
  raw: unknown,
): { ok: true; data: ChatRequestData } | { ok: false; error: string } {
  const parsed = ChatRequest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "(root)";
    return { ok: false, error: `${path}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, data: parsed.data };
}

async function parseChatBody(
  req: Request,
): Promise<{ ok: true; data: ChatRequestData } | { ok: false; error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, error: jsonError(400, "body must be JSON") };
  }
  const v = validateChatBody(raw);
  return v.ok ? v : { ok: false, error: jsonError(400, v.error) };
}

// The user's display name for the `[User name: X]` chat tag, or undefined when
// they haven't set one — signup stores the email as the name when none is given.
// Brackets and newlines are flattened so a name can't forge another tag.
async function userDisplayName(userId: string): Promise<string | undefined> {
  const [u] = await db()
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  if (!u?.name || u.name === u.email) return undefined;
  const name = u.name.replace(/[[\]\r\n]+/g, " ").trim();
  return name || undefined;
}

// ---------- pre-execution tool gate ----------
//
// In-memory registry of pending tool confirmations. Keyed by tool_use_id
// (Anthropic-generated, globally unique). The agent loop calls makeConfirmTool
// to obtain a callback that, when invoked, stores a pending entry and awaits
// a resolution that arrives from POST /chat/tool/:id/confirm.
//
// Single-process only — fine for our deployment shape. If we ever scale
// horizontally, this needs to move to Redis (and the SSE stream needs to be
// pinned to the same instance, or we use server-side state to resume from
// either node). For now, dev-machine assumptions are explicit here.

type PendingEntry = {
  userId: string;
  resolve: (v: ToolConfirmation) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PENDING_TOOL_CONFIRMS = new Map<string, PendingEntry>();
const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// `signal` fires when the SSE stream is torn down (client disconnect/refresh).
// Rejecting the promise on abort releases the paused agent loop immediately
// instead of stranding it here for the full PENDING_TIMEOUT_MS — and, crucially,
// leaves the persisted tool_call dangling (no synthetic result) so the pending
// card stays savable on return via the /resolve dead-gate path. See GateAbandoned.
function makeConfirmTool(userId: string, ulog: Logger, signal: AbortSignal): ConfirmToolFn {
  return ({ name, tool_use_id }) =>
    new Promise<ToolConfirmation>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("stream closed before confirmation"));
        return;
      }
      // Resolve the user's confirmation and tear down both the timeout and the
      // abort listener so a later disconnect can't double-settle this promise.
      const settle = (result: ToolConfirmation) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        clearTimeout(timer);
        if (PENDING_TOOL_CONFIRMS.get(tool_use_id)?.resolve === settle) {
          PENDING_TOOL_CONFIRMS.delete(tool_use_id);
        }
        ulog.info("gate abandoned — stream closed", { tool: name, tool_use_id });
        reject(new Error("stream closed before confirmation"));
      };
      const timer = setTimeout(() => {
        if (PENDING_TOOL_CONFIRMS.get(tool_use_id)?.resolve === settle) {
          PENDING_TOOL_CONFIRMS.delete(tool_use_id);
          signal.removeEventListener("abort", onAbort);
          ulog.warn("tool confirmation timed out", {
            tool: name,
            tool_use_id,
          });
          resolve({
            canceled: true,
            reason: "timed out waiting for confirmation",
          });
        }
      }, PENDING_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      PENDING_TOOL_CONFIRMS.set(tool_use_id, { userId, resolve: settle, timer });
      ulog.debug("tool awaiting confirmation", {
        tool: name,
        tool_use_id,
      });
    });
}

async function handleToolConfirm(
  { req, log, userId }: AuthedCtx,
  toolUseId: string,
): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  const entry = PENDING_TOOL_CONFIRMS.get(toolUseId);
  if (!entry) {
    return jsonError(404, "no pending confirmation for that tool_use_id");
  }
  if (entry.userId !== userId) {
    // Don't leak existence — same status as not-found.
    return jsonError(404, "no pending confirmation for that tool_use_id");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return jsonError(400, "body must be {input} or {canceled: true}");
  }
  const b = body as { input?: unknown; canceled?: unknown; reason?: unknown };

  PENDING_TOOL_CONFIRMS.delete(toolUseId);
  clearTimeout(entry.timer);

  if (b.canceled === true) {
    const reason = typeof b.reason === "string" ? b.reason : undefined;
    ulog.info("tool canceled by user", { tool_use_id: toolUseId });
    entry.resolve({ canceled: true, reason });
    return Response.json({ ok: true, canceled: true });
  }

  if (typeof b.input !== "object" || b.input === null) {
    PENDING_TOOL_CONFIRMS.set(toolUseId, entry); // restore so client can retry
    return jsonError(400, "input must be an object");
  }
  ulog.info("tool confirmed", { tool_use_id: toolUseId });
  entry.resolve({
    canceled: false,
    input: b.input as Record<string, unknown>,
  });
  return Response.json({ ok: true });
}

// Direct tool execution, outside the agent loop. Used by:
//   - The chat ToolFormCard's "resubmit-after-save" flow (edit a card, hit
//     update — the original gate is long closed).
//   - The Nutrition page's edit/add affordances (phase 3).
// Restricted to mutating tools by name. Validated server-side so a malicious
// client can't run arbitrary internal logic via this surface.
async function handleToolRun({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return jsonError(400, "body must be {name, input}");
  }
  const { name, input } = body as { name?: unknown; input?: unknown };
  if (typeof name !== "string" || !name) {
    return jsonError(400, "name is required");
  }
  if (!isMutatingTool(name)) {
    return jsonError(403, `tool '${name}' is not callable via /tools/run`);
  }
  if (typeof input !== "object" || input === null) {
    return jsonError(400, "input must be an object");
  }
  const start = Date.now();
  try {
    const out = await executeTool(name, input as Record<string, unknown>, storage);
    ulog.info("direct tool run", { tool: name, ms: Date.now() - start });
    return new Response(out, {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    ulog.error("direct tool run failed", err instanceof Error ? err : new Error(String(err)), {
      tool: name,
      ms: Date.now() - start,
    });
    return jsonError(500, err instanceof Error ? err.message : String(err));
  }
}

// Resolve a gate whose live confirmation no longer exists — the agent turn
// ended (timed out, server restarted, or the chat was reopened from history)
// while an entry-tool card sat pending. Runs the tool directly AND records a
// tool_result against the dangling tool_use, so the card resolves to "saved" on
// reload and can't be saved twice. The client falls back to this when
// /chat/tool/:id/confirm returns 404 (see onConfirmTool).
async function handleToolResolve(
  { req, log, userId, storage }: AuthedCtx,
  toolUseId: string,
): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return jsonError(400, "body must be {name, input}");
  }
  const { name, input } = body as { name?: unknown; input?: unknown };
  if (typeof name !== "string" || !name) {
    return jsonError(400, "name is required");
  }
  if (!isMutatingTool(name)) {
    return jsonError(403, `tool '${name}' is not callable via resolve`);
  }
  if (typeof input !== "object" || input === null) {
    return jsonError(400, "input must be an object");
  }
  // Guard against double-save: only proceed if the tool_use is still pending.
  if (!(await storage.isDanglingToolUse(toolUseId))) {
    return jsonError(409, "this entry was already saved or canceled — refresh to see its status");
  }
  const start = Date.now();
  let out: string;
  try {
    out = await executeTool(name, input as Record<string, unknown>, storage);
  } catch (err) {
    ulog.error("dead-gate resolve failed", err instanceof Error ? err : new Error(String(err)), {
      tool: name,
      tool_use_id: toolUseId,
      ms: Date.now() - start,
    });
    return jsonError(500, err instanceof Error ? err.message : String(err));
  }
  await storage.appendToolResult(toolUseId, out);
  ulog.info("dead-gate tool resolved", {
    tool: name,
    tool_use_id: toolUseId,
    ms: Date.now() - start,
  });
  return new Response(out, {
    headers: { "content-type": "application/json" },
  });
}

// ---------- chat runs (HTTP stop) ----------
//
// Turns execute in chat-runs.ts, independent of any connection. POST
// /chat/stop is the HTTP twin of the WebSocket `stop` message, for clients on
// the SSE transport.

async function handleChatStop({ log, userId }: AuthedCtx): Promise<Response> {
  const stopped = stopRun(userId, log.child({ user_id: userId }));
  return Response.json({ ok: true, stopped });
}

// ---------- chat WebSocket ----------
//
// The web app's chat transport: one socket per tab at /ws, authenticated by
// the session cookie at upgrade time. Runs live in chat-runs.ts, not on the
// socket — a socket only subscribes to the user's runs, so a dropped
// connection (iOS kills them on screen lock / app switch) loses nothing: the
// client reconnects and resumes from the last seq it saw.
//
// Client → server:
//   { type: "hello", resume?: { run_id, after_seq } }  first message per socket
//   { type: "start", run_id, request: ChatRequest }    start a turn (client-made id;
//                                                       a repeat of a known id is ignored)
//   { type: "stop", run_id }                            stop that turn if still active
//   { type: "ping" }                                    app-level heartbeat
// Server → client: RunMessage (ready / run / event / end), plus
//   { type: "rejected", run_id, status, error }         start refused (409/429/400)
//   { type: "pong" }
//
// Tool-gate confirmations stay on POST /chat/tool/:id/confirm (keyed by
// tool_use_id, so any tab or connection can resolve them).

export type ChatSocketData = {
  userId: string;
  log: Logger;
  unsubscribe: (() => void) | null;
};

type ChatSocketOut =
  | RunMessage
  | { type: "rejected"; run_id: string; status: number; error: string }
  | { type: "pong" };

const RUN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

// WebSockets bypass CORS, so a cookie-authenticated socket must check Origin
// itself or any site could open one as the user (cross-site WS hijacking).
function wsOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

export async function handleWsUpgrade(
  req: Request,
  srv: Server<ChatSocketData>,
): Promise<Response | undefined> {
  if (!wsOriginAllowed(req)) return new Response("forbidden origin", { status: 403 });
  const session = await requireSession(req);
  if ("error" in session) return session.error;
  const data: ChatSocketData = {
    userId: session.userId,
    log: logger.child({ user_id: session.userId, conn_id: crypto.randomUUID().slice(0, 8) }),
    unsubscribe: null,
  };
  if (srv.upgrade(req, { data })) return undefined;
  return new Response("websocket upgrade required", { status: 426 });
}

function wsSend(ws: ServerWebSocket<ChatSocketData>, msg: ChatSocketOut): void {
  ws.send(JSON.stringify(msg));
}

export const chatWebSocket: WebSocketHandler<ChatSocketData> = {
  // Image turns can carry up to 6 × ~10 MB base64 (see MAX_IMAGE_B64_LEN).
  maxPayloadLength: 64 * 1024 * 1024,
  // Protocol pings keep proxies from reaping a quiet socket; the client runs
  // its own app-level ping to detect a dead one (browsers can't see these).
  sendPings: true,
  idleTimeout: 120,

  open(ws) {
    ws.data.log.debug("ws open");
  },

  message(ws, raw) {
    let msg: { type?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const { userId, log } = ws.data;
    switch (msg.type) {
      case "ping":
        wsSend(ws, { type: "pong" });
        return;
      case "hello": {
        const r = msg.resume as { run_id?: unknown; after_seq?: unknown } | undefined;
        const resume =
          r && typeof r.run_id === "string" && typeof r.after_seq === "number"
            ? { run_id: r.run_id, after_seq: r.after_seq }
            : null;
        ws.data.unsubscribe?.();
        ws.data.unsubscribe = subscribe(userId, (m) => wsSend(ws, m), resume);
        return;
      }
      case "start": {
        const runId = typeof msg.run_id === "string" ? msg.run_id : "";
        if (!RUN_ID_RE.test(runId)) return;
        const reject = (status: number, error: string) =>
          wsSend(ws, { type: "rejected", run_id: runId, status, error });
        if (!ws.data.unsubscribe) return reject(400, "send hello before start");
        // Re-sent after a reconnect, but the first copy did arrive: the hello
        // replay already caught this socket up on it.
        if (isKnownRun(userId, runId)) return;
        const v = validateChatBody(msg.request);
        if (!v.ok) return reject(400, v.error);
        void startChatRun(userId, runId, v.data, log).then((started) => {
          if (!started.ok) reject(started.status, started.error);
        });
        return;
      }
      case "stop":
        if (typeof msg.run_id === "string") stopRun(userId, log, msg.run_id);
        return;
    }
  },

  close(ws, code) {
    ws.data.log.debug("ws close", { code });
    ws.data.unsubscribe?.();
    ws.data.unsubscribe = null;
  },
};

async function handleChat({ req, log, userId }: AuthedCtx): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  if (!consumeToken(userId)) {
    ulog.warn("chat rate limited");
    return jsonError(429, "rate limit exceeded — try again shortly");
  }
  const [blocked, userName] = await Promise.all([
    aiPreflight(userId, "ai_chat", ulog),
    userDisplayName(userId),
  ]);
  if (blocked) return jsonError(blocked.status, blocked.error);
  const parsed = await parseChatBody(req);
  if (!parsed.ok) return parsed.error;
  ulog.info("chat request", {
    msg_len: parsed.data.message.length,
    images: parsed.data.images?.length ?? 0,
  });
  const start = Date.now();
  try {
    const userMsg = buildUserMessage(
      parsed.data.message,
      parsed.data.images,
      parsed.data.context_date,
      parsed.data.locale,
      parsed.data.context_screen,
      parsed.data.context_section,
      parsed.data.context_view_label,
      userName,
    );
    const result = await chat(userId, userMsg, {
      thinking: parsed.data.thinking,
      contextDate: parsed.data.context_date,
    });
    ulog.info("chat done", {
      ms: Date.now() - start,
      iterations: result.iterations,
      stop_reason: result.stop_reason,
      in_tokens: result.usage.input_tokens,
      out_tokens: result.usage.output_tokens,
      cache_read: result.usage.cache_read_input_tokens,
    });
    return Response.json(result);
  } catch (err) {
    ulog.error("chat failed", err instanceof Error ? err : new Error(String(err)), {
      ms: Date.now() - start,
    });
    return jsonError(500, err instanceof Error ? err.message : String(err));
  }
}

// Validate a chat body and start a run for it. Shared by POST /chat/stream and
// the WebSocket `start` message.
async function startChatRun(
  userId: string,
  runId: string,
  data: ChatRequestData,
  ulog: Logger,
): Promise<ReturnType<typeof startRun>> {
  if (activeRun(userId)) {
    ulog.warn("chat start rejected — previous run still in flight");
    return {
      ok: false,
      status: 409,
      error: "previous reply is still finishing — try again in a moment",
    };
  }
  if (!consumeToken(userId)) {
    ulog.warn("chat rate limited");
    return { ok: false, status: 429, error: "rate limit exceeded — try again shortly" };
  }
  const [blocked, userName] = await Promise.all([
    aiPreflight(userId, "ai_chat", ulog),
    userDisplayName(userId),
  ]);
  if (blocked) return { ok: false, ...blocked };
  // Re-check after the await: a concurrent start may have won the race.
  if (activeRun(userId)) {
    return {
      ok: false,
      status: 409,
      error: "previous reply is still finishing — try again in a moment",
    };
  }
  const userMessage = buildUserMessage(
    data.message,
    data.images,
    data.context_date,
    data.locale,
    data.context_screen,
    data.context_section,
    data.context_view_label,
    userName,
  );
  ulog.info("chat run request", {
    run_id: runId,
    msg_len: data.message.length,
    images: data.images?.length ?? 0,
  });
  return startRun({
    userId,
    runId,
    userText: data.message,
    userMessage,
    options: { thinking: data.thinking, contextDate: data.context_date },
    makeConfirmTool: (signal) => makeConfirmTool(userId, ulog, signal),
    log: ulog,
  });
}

// Legacy SSE transport (the web app uses /ws). The run outlives this response:
// a disconnect just unsubscribes, and the turn still finishes and persists.
async function handleChatStream({ req, log, userId }: AuthedCtx): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  const parsed = await parseChatBody(req);
  if (!parsed.ok) return parsed.error;
  const started = await startChatRun(userId, crypto.randomUUID(), parsed.data, ulog);
  if (!started.ok) return jsonError(started.status, started.error);
  const runId = started.run.id;

  // A 15s comment heartbeat keeps Bun's idleTimeout and any proxy from killing
  // the stream while the agent sits at a tool gate.
  const KEEPALIVE_MS = 15_000;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  const teardown = () => {
    closed = true;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      keepalive = setInterval(
        () =>
          write(`: keepalive

`),
        KEEPALIVE_MS,
      );
      unsubscribe = subscribe(
        userId,
        (msg) => {
          if (msg.type === "event" && msg.run_id === runId) {
            write(`event: ${msg.event.type}
data: ${JSON.stringify(msg.event)}

`);
          } else if (msg.type === "end" && msg.run_id === runId && !closed) {
            teardown();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
        { run_id: runId, after_seq: 0 },
      );
    },
    cancel() {
      if (!closed) ulog.info("chat stream client disconnected — run continues", { run_id: runId });
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// Conversation history. Paginated for scroll-up: `?limit=N` returns the most
// recent N messages, and `?before=<id>&limit=N` returns the N messages just
// older than that cursor (oldest-first within the page). `nextCursor` is the id
// to pass as the next `before`, or null at the start of the conversation.
// Without `limit` we fall back to returning the entire history (legacy shape,
// `nextCursor: null`) so older callers keep working.
const HISTORY_DEFAULT_PAGE = 20;

async function handleHistory({ url, log, userId }: AuthedCtx): Promise<Response> {
  const limitParam = url.searchParams.get("limit");
  const beforeParam = url.searchParams.get("before");

  // No params at all → legacy "everything" response.
  if (limitParam == null && beforeParam == null) {
    const messages = await getConversation(userId);
    log.debug("history loaded", {
      user_id: userId,
      count: messages.length,
    });
    return Response.json({ userId: userId, messages, nextCursor: null });
  }

  const limit = limitParam ? Number(limitParam) : HISTORY_DEFAULT_PAGE;
  const before = beforeParam ? Number(beforeParam) : undefined;
  if (!Number.isFinite(limit) || limit <= 0 || (beforeParam != null && !Number.isFinite(before))) {
    return Response.json({ error: "invalid pagination params" }, { status: 400 });
  }
  const { messages, nextCursor } = await getConversationPage(userId, {
    limit,
    ...(before != null ? { before } : {}),
  });
  log.debug("history page loaded", {
    user_id: userId,
    before: before ?? null,
    count: messages.length,
    next_cursor: nextCursor,
  });
  return Response.json({ userId: userId, messages, nextCursor });
}

// Open-Graph link preview for a URL the user pasted into chat. The browser
// can't scrape a third-party page's <meta> tags (CORS), so it asks us: we fetch
// the page server-side, extract the social-card metadata, and return a small
// summary the chat renders as a thumbnail card. SSRF-guarded (see
// link-preview.ts) and cached in-memory so re-renders / history reloads of the
// same link don't refetch. A miss (unreachable, non-HTML, blocked host) returns
// 204 so the client silently degrades to a plain link.
const LINK_PREVIEW_CACHE = new Map<string, { at: number; value: LinkPreview | null }>();
const LINK_PREVIEW_TTL_MS = 60 * 60 * 1000; // 1h — og:tags rarely change
const LINK_PREVIEW_CACHE_MAX = 500;

async function handleLinkPreview({ url, log, userId }: AuthedCtx): Promise<Response> {
  const target = url.searchParams.get("url")?.trim();
  if (!target) return jsonError(400, "pass url");

  const cached = LINK_PREVIEW_CACHE.get(target);
  const now = Date.now();
  let value: LinkPreview | null;
  if (cached && now - cached.at < LINK_PREVIEW_TTL_MS) {
    value = cached.value;
  } else {
    value = await fetchLinkPreview(target);
    // Bound the cache: drop the oldest entry once it's full (simple FIFO — Map
    // preserves insertion order). Negative results are cached too so a broken
    // link isn't refetched on every re-render.
    if (LINK_PREVIEW_CACHE.size >= LINK_PREVIEW_CACHE_MAX) {
      const oldest = LINK_PREVIEW_CACHE.keys().next().value;
      if (oldest !== undefined) LINK_PREVIEW_CACHE.delete(oldest);
    }
    LINK_PREVIEW_CACHE.set(target, { at: now, value });
    log.debug("link preview", { user_id: userId, ok: value != null });
  }

  if (!value) return new Response(null, { status: 204 });
  return Response.json(value);
}

async function handleReset({ log, userId }: AuthedCtx): Promise<Response> {
  await resetConversation(userId);
  log.info("conversation reset", { user_id: userId });
  return Response.json({ userId: userId, reset: true });
}

// ---------- routes ----------

export const chatRoutes: Route[] = [
  route("POST", "/chat", authed(handleChat)),
  route("POST", "/chat/stream", authed(handleChatStream)),
  route("POST", "/chat/stop", authed(handleChatStop)),
  route(
    "POST",
    "/chat/tool/:id/confirm",
    authed((c) => handleToolConfirm(c, c.params.id)),
  ),
  route(
    "POST",
    "/chat/tool/:id/resolve",
    authed((c) => handleToolResolve(c, c.params.id)),
  ),
  route("POST", "/tools/run", authed(handleToolRun)),
  route("GET", "/tools/schemas", () => Response.json(toolSchemas())),
  route("GET", "/link-preview", authed(handleLinkPreview)),
  route("GET", "/history", authed(handleHistory)),
  route("POST", "/reset", authed(handleReset)),
];
