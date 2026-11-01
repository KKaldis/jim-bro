/**
 * Single app-wide Axios instance + the Orval mutator.
 *
 * Every generated React Query hook routes its HTTP call through `customFetch`
 * below, so the Better Auth session cookie (withCredentials) and any
 * interceptors are applied uniformly — no more `credentials: "include"`
 * copy-pasted across call sites.
 *
 * Same-origin in prod (the server serves the SPA); the Vite dev proxy
 * (vite.config.ts) forwards the API routes to :3001 in dev. No baseURL needed.
 */
import Axios, { type AxiosRequestConfig } from "axios";
import { apiErr } from "../lib/apiErr";
import { httpCrudMessage, toastError, toastSuccess } from "../lib/toast";

export const api = Axios.create({
  withCredentials: true, // send the Better Auth session cookie on every request
});

// Centralized response handling. Kept passive for now (auth gating still lives
// in App.tsx via the Better Auth session); the 401 hook is the place to add a
// login bounce or an auth-store signal later.
api.interceptors.response.use(
  (r) => r,
  (error) => Promise.reject(error),
);

// Orval calls this mutator for every generated hook. It unwraps `data` so the
// hooks resolve to the response body directly. The second arg carries
// per-call overrides Orval may pass (e.g. signal, params).
//
// Every write goes through here, so it's also the one place we raise CRUD
// toasts for the REST client (Body, Diet, Workout, Hydration, Steps, Profile).
// httpCrudMessage returns null for non-CRUD endpoints (chat/scan/auth) so those
// stay silent. Read (GET) calls never toast. Aborted requests (canceled
// in-flight, e.g. a superseded query) are swallowed without an error toast.
export const customFetch = <T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> => {
  const merged = { ...config, ...options };
  const crud = httpCrudMessage(merged.method ?? "GET", merged.url ?? "");
  return api(merged).then(
    ({ data }) => {
      if (crud) toastSuccess(crud);
      return data as T;
    },
    (error) => {
      if (crud && !Axios.isCancel(error)) toastError(apiErr(error));
      throw error;
    },
  );
};

export default customFetch;
