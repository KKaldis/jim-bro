// Run an agent tool directly via POST /tools/run, outside the chat loop — the
// same surface the Nutrition pantry edits use. Restricted server-side to
// mutating tools. `runTool` returns null on success or an error string to show
// inline; `runToolJson` returns the tool's full parsed result (e.g. to read the
// saved row's id back).
//
// Both paths raise a CRUD toast (success or error) from the tool name, so every
// data-screen edit that reuses an agent tool notifies consistently. The inline
// error string is still returned for callers that render it in-place too.
import { toastError, toastSuccess, toolCrudMessage } from "./toast";

async function postToolRun(name: string, input: Record<string, unknown>): Promise<Response> {
  return fetch("/tools/run", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input }),
  });
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await postToolRun(name, input);
    if (!res.ok) {
      const msg = (await res.text()) || `HTTP ${res.status}`;
      toastError(msg);
      return msg;
    }
    const json = (await res.json()) as { error?: string };
    if (json.error) {
      toastError(json.error);
      return json.error;
    }
    toastSuccess(toolCrudMessage(name));
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toastError(msg);
    return msg;
  }
}

export type ToolRunResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function runToolJson<T = Record<string, unknown>>(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolRunResult<T>> {
  try {
    const res = await postToolRun(name, input);
    if (!res.ok) {
      const error = (await res.text()) || `HTTP ${res.status}`;
      toastError(error);
      return { ok: false, error };
    }
    const json = (await res.json()) as T & { error?: string };
    if (json.error) {
      toastError(json.error);
      return { ok: false, error: json.error };
    }
    toastSuccess(toolCrudMessage(name));
    return { ok: true, data: json };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    toastError(error);
    return { ok: false, error };
  }
}
