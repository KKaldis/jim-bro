/**
 * Better Auth client. Same-origin in dev (Vite proxy) and in prod (served
 * from the Bun server). Cookies are first-party; no CORS gymnastics.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
});

export const { useSession, signIn, signUp, signOut } = authClient;
