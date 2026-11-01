/**
 * The chat WebSocket (/ws) — one connection per tab, kept alive across the
 * mobile lifecycle.
 *
 * iOS Safari freezes a backgrounded page and silently kills its sockets; the
 * browser often doesn't fire `close` until much later, if ever. So liveness is
 * ours to detect:
 *   - an app-level ping every PING_EVERY_MS; no inbound frame for DEAD_AFTER_MS
 *     means the socket is dead → reconnect;
 *   - a long gap between heartbeat ticks means JS was frozen → probe with a
 *     ping and reconnect unless something arrives within PROBE_TIMEOUT_MS;
 *   - the same probe on visibilitychange/pageshow/online, so a returning user
 *     is reconnected within a few seconds instead of after a timeout.
 *
 * Runs live on the server, not on the socket. On every (re)connect we send
 * `hello` with the run we were following and the last seq we saw, and the
 * server replays whatever we missed — the consumer (Chat) supplies that via
 * `setResumeProvider` and sees one gap-free, de-duplicated event sequence.
 */
import type { ChatRequest as ChatRequestModel, StreamEvent } from "../api/model";

export type ChatStreamEvent = StreamEvent;
export type ChatRequest = ChatRequestModel;

export type RunInfo = { run_id: string; user_text: string; running: boolean };

export type ChatServerMessage =
  | { type: "ready"; run: RunInfo | null }
  | ({ type: "run" } & RunInfo)
  | { type: "event"; run_id: string; seq: number; event: ChatStreamEvent }
  | { type: "end"; run_id: string; reason: "completed" | "error" | "stopped" }
  | { type: "rejected"; run_id: string; status: number; error: string }
  | { type: "pong" };

type ClientMessage =
  | { type: "hello"; resume?: { run_id: string; after_seq: number } }
  | { type: "start"; run_id: string; request: ChatRequest }
  | { type: "stop"; run_id: string }
  | { type: "ping" };

export type ResumePoint = { run_id: string; after_seq: number } | null;

const PING_EVERY_MS = 15_000;
const DEAD_AFTER_MS = 40_000;
const PROBE_TIMEOUT_MS = 4_000;
// A handshake can hang forever after an iOS wake or a Wi-Fi ↔ cellular
// switch (the SYN goes nowhere and no error ever fires) — give up and redial.
const CONNECT_TIMEOUT_MS = 10_000;
const TICK_MS = 2_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

class ChatSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: ChatServerMessage) => void>();
  private resumeProvider: () => ResumePoint = () => null;
  private users = 0; // ref-count of mounted consumers
  private owner: string | null = null;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private lastPingAt = 0;
  private lastTickAt = 0;
  private probeDeadline: number | null = null;
  private connectStartedAt = 0;

  // Start (ref-counted) and return a release function. `owner` is the
  // signed-in user id: the socket authenticated at upgrade time, so a
  // different owner always gets a fresh connection.
  //
  // The final release is deferred a tick so an immediate re-acquire — React
  // StrictMode's dev mount→unmount→mount — reuses the socket instead of
  // closing it mid-handshake ("closed before the connection is established").
  acquire(owner: string): () => void {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    if (this.owner !== owner) {
      this.owner = owner;
      this.teardown();
    }
    this.users++;
    if (!this.tickTimer) {
      document.addEventListener("visibilitychange", this.onWake);
      window.addEventListener("pageshow", this.onWake);
      window.addEventListener("online", this.onWake);
      this.lastTickAt = Date.now();
      this.tickTimer = setInterval(this.tick, TICK_MS);
    }
    this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users--;
      if (this.users > 0) return;
      this.shutdownTimer = setTimeout(() => {
        this.shutdownTimer = null;
        if (this.users === 0) this.shutdown();
      }, 0);
    };
  }

  private shutdown(): void {
    document.removeEventListener("visibilitychange", this.onWake);
    window.removeEventListener("pageshow", this.onWake);
    window.removeEventListener("online", this.onWake);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
  }

  subscribe(cb: (m: ChatServerMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setResumeProvider(fn: () => ResumePoint): void {
    this.resumeProvider = fn;
  }

  // Send if connected; otherwise dial and report false. Nothing is queued:
  // the consumer re-sends what still matters when the next `ready` arrives
  // (an unacked start, a pending stop), which also covers a message written
  // into a socket that turned out to be dead.
  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    if (!this.ws) this.connectNow();
    return false;
  }

  private connect(): void {
    if (this.users === 0 || this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectStartedAt = Date.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastInboundAt = Date.now();
      this.probeDeadline = null;
      const resume = this.resumeProvider();
      ws.send(
        JSON.stringify({ type: "hello", ...(resume ? { resume } : {}) } satisfies ClientMessage),
      );
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      this.probeDeadline = null;
      let msg: ChatServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ChatServerMessage;
      } catch {
        return;
      }
      if (msg.type === "pong") return;
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };
    // onerror is always followed by onclose.
  }

  private teardown(): void {
    const ws = this.ws;
    this.ws = null;
    this.probeDeadline = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.users === 0 || this.reconnectTimer) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect();
      },
      base / 2 + Math.random() * (base / 2),
    );
  }

  // Drop whatever we have and dial immediately (user is looking at the page).
  private connectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.teardown();
    this.connect();
  }

  private ping(): void {
    this.lastPingAt = Date.now();
    try {
      this.ws?.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
    } catch {
      /* close handler will reconnect */
    }
  }

  // Ask "are you there?" and give the socket PROBE_TIMEOUT_MS to answer.
  private probe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) this.connectNow();
      return;
    }
    this.probeDeadline = Date.now() + PROBE_TIMEOUT_MS;
    this.ping();
  }

  private onWake = () => {
    if (document.visibilityState === "visible") this.probe();
  };

  private tick = () => {
    const now = Date.now();
    const frozen = now - this.lastTickAt > TICK_MS * 3;
    this.lastTickAt = now;
    if (this.users === 0) return;
    if (frozen && !document.hidden) {
      this.probe();
      return;
    }
    const ws = this.ws;
    if (
      ws?.readyState === WebSocket.CONNECTING &&
      !document.hidden &&
      now - this.connectStartedAt > CONNECT_TIMEOUT_MS
    ) {
      // Backed-off redial (not connectNow) so a dead network doesn't spin.
      this.teardown();
      this.scheduleReconnect();
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Hidden tabs get throttled timers (≈1/min on desktop), so silence there
    // proves nothing — just keep pinging; onWake probes when we're back.
    if (document.hidden) {
      if (now - this.lastPingAt >= PING_EVERY_MS) this.ping();
      return;
    }
    if (this.probeDeadline != null && now > this.probeDeadline) {
      this.connectNow();
      return;
    }
    if (now - this.lastInboundAt > DEAD_AFTER_MS) {
      this.connectNow();
      return;
    }
    if (now - this.lastPingAt >= PING_EVERY_MS) this.ping();
  };
}

export const chatSocket = new ChatSocket();
