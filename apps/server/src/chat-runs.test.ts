import { beforeEach, describe, expect, mock, test } from "bun:test";

// A scripted stand-in for the agent loop: yields text deltas on demand so a
// test controls exactly when each event happens.
type Ev = { type: string; [k: string]: unknown };
let script: { next: (ev: Ev | null) => void; aborted: AbortSignal | null };

// bun's module mocks are process-wide, so keep the real exports for the other
// test files and replace only chatStream.
const realAgent = await import("@fa/agent");
mock.module("@fa/agent", () => ({
  ...realAgent,
  chatStream: async function* (
    _u: string,
    _m: unknown,
    _o: unknown,
    confirm: ((a: unknown) => Promise<unknown>) & { signal?: AbortSignal },
  ) {
    script.aborted = confirm.signal ?? null;
    while (true) {
      const ev = await new Promise<Ev | null>((r) => (script.next = r));
      if (!ev) return;
      yield ev;
      if (ev.type === "done" || ev.type === "error") return;
    }
  },
}));

const { startRun, stopRun, subscribe, activeRun, isKnownRun } = await import("./chat-runs.ts");

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return log;
  },
} as never;

const DONE = {
  type: "done",
  iterations: 1,
  stop_reason: "end_turn",
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
};
const tick = () => new Promise((r) => setTimeout(r, 0));
let userN = 0;
let user = "";

function start(runId: string) {
  return startRun({
    userId: user,
    runId,
    userText: "hi",
    userMessage: "hi",
    options: {},
    makeConfirmTool: (signal) =>
      Object.assign(async () => ({ canceled: true as const }), { signal }),
    log,
  });
}

async function emit(ev: Ev | null) {
  await tick();
  script.next(ev);
  await tick();
}

beforeEach(() => {
  user = `u${++userN}`;
  script = { next: () => {}, aborted: null };
});

describe("chat runs", () => {
  test("a run finishes with no listener, and a resume replays only what was missed", async () => {
    const seen: unknown[] = [];
    const unsub = subscribe(user, (m) => seen.push(m), null);
    expect(start("run-aaaaaaaa").ok).toBe(true);
    await emit({ type: "text_delta", delta: "a" });
    unsub(); // phone locked
    await emit({ type: "text_delta", delta: "b" });
    await emit(DONE);
    expect(activeRun(user)).toBeNull();

    const replay: Array<{ type: string; seq?: number }> = [];
    subscribe(user, (m) => replay.push(m), { run_id: "run-aaaaaaaa", after_seq: 1 });
    expect(replay.map((m) => m.type)).toEqual(["ready", "run", "event", "event", "end"]);
    expect(replay.filter((m) => m.type === "event").map((m) => m.seq)).toEqual([2, 3]);
  });

  test("a fresh subscriber attaches to an active run from the start", async () => {
    start("run-bbbbbbbb");
    await emit({ type: "text_delta", delta: "a" });
    const got: Array<{ type: string; running?: boolean }> = [];
    subscribe(user, (m) => got.push(m), null);
    expect(got.map((m) => m.type)).toEqual(["ready", "run", "event"]);
    expect(got[1].running).toBe(true);
    await emit(DONE);
  });

  test("a finished run is not replayed to a subscriber that wasn't following it", async () => {
    start("run-cccccccc");
    await emit(DONE);
    const got: Array<{ type: string }> = [];
    subscribe(user, (m) => got.push(m), null);
    expect(got).toEqual([{ type: "ready", run: null }] as never);
  });

  test("one active run per user; the run id is remembered for dedupe", async () => {
    start("run-dddddddd");
    const second = start("run-eeeeeeee");
    expect(second.ok).toBe(false);
    expect(isKnownRun(user, "run-dddddddd")).toBe(true);
    await emit(DONE);
  });

  test("stop ends the run at once, only for the matching id", async () => {
    const got: Array<{ type: string; reason?: string; run_id?: string }> = [];
    subscribe(user, (m) => got.push(m), null);
    start("run-ffffffff");
    await emit({ type: "text_delta", delta: "a" });
    expect(stopRun(user, log, "run-other")).toBe(false);
    expect(stopRun(user, log, "run-ffffffff")).toBe(true);
    expect(got.at(-1)).toEqual({ type: "end", run_id: "run-ffffffff", reason: "stopped" });
    expect(script.aborted?.aborted).toBe(true); // gates released
    await emit({ type: "text_delta", delta: "late" });
    expect(got.filter((m) => m.type === "event")).toHaveLength(1);
    expect(activeRun(user)).toBeNull();
  });
});
