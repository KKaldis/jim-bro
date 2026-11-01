/**
 * Extract a human message from an error thrown by the generated API client.
 *
 * The Axios mutator rejects with an AxiosError whose `response.data` is the
 * server's `{ error }` JSON body. This pulls that message out, falling back to
 * the Axios message ("Request failed with status code 400") and finally to a
 * stringified value — so call sites that used to read `await res.text()` keep
 * surfacing the same server-side error text.
 */
import i18n from "../i18n";

export function apiErr(e: unknown): string {
  // Client-side validation against the shared Zod request schemas
  // (@fa/shared/schemas) throws a ZodError before the request is sent. Surface
  // its first issue instead of the raw JSON dump. Duck-typed on `.issues`
  // rather than `instanceof ZodError` because the web app and @fa/shared bundle
  // separate zod copies, so a cross-copy instanceof check would miss.
  const issues = (e as { issues?: Array<{ path?: Array<string | number>; message?: string }> })
    ?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0];
    const where = first.path && first.path.length ? `${first.path.join(".")}: ` : "";
    return `${where}${first.message ?? i18n.t("lib.error.invalidInput")}`;
  }

  const ax = e as
    { response?: { data?: { error?: unknown } }; message?: string } | null | undefined;
  const serverError = ax?.response?.data?.error;
  if (typeof serverError === "string" && serverError) return serverError;
  if (ax?.message) return ax.message;
  return String(e);
}
