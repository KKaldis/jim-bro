/**
 * Better Auth configuration.
 *
 * - Email + password auth, plus Google sign-in when GOOGLE_CLIENT_ID /
 *   GOOGLE_CLIENT_SECRET are set. A Google sign-in with the same (verified)
 *   email as an existing password account links to that account.
 * - Email verification is optional: signup succeeds without verifying, but
 *   we send a verification email so the user can confirm whenever.
 * - Password reset is wired through ./email.ts.
 *
 * The handler is mounted at /api/auth/* by the server.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db, schema } from "@fa/db_postgres";
import { sendEmail } from "./email.ts";

export type UserCreatedEvent = {
  userId: string;
  /** Read a cookie off the signup request (null when absent or not an HTTP signup). */
  getCookie: (name: string) => string | null;
};
type UserCreatedListener = (event: UserCreatedEvent) => void | Promise<void>;
const userCreatedListeners: UserCreatedListener[] = [];

/** Run after every signup. Listener errors are logged, never fail the signup. */
export function onUserCreated(listener: UserCreatedListener): void {
  userCreatedListeners.push(listener);
}

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

const frontendOrigins = (process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// One deployment serves several brand domains (config/deploy.yml). Resolve the
// base URL per request so the OAuth callback — and so the session cookie — lands
// on the domain the user signed in from, not always on BETTER_AUTH_URL. The
// protocol is pinned to BETTER_AUTH_URL's: behind the Kamal proxy the server
// only ever sees plain http. Requests from any other host fall back to
// BETTER_AUTH_URL, as before.
const allowedHosts = [...new Set([baseUrl, ...frontendOrigins].map((o) => new URL(o).host))];

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

/** Social providers configured on this server; the login page asks for these. */
export const enabledSocialProviders = {
  google: Boolean(googleClientId && googleClientSecret),
};

if (!process.env.BETTER_AUTH_SECRET) {
  // Allow startup in dev (Better Auth would also fail loudly); make it visible.
  console.warn(
    "[auth] BETTER_AUTH_SECRET not set — sessions will be insecure. " +
      "Generate one: openssl rand -hex 32",
  );
}

export const auth = betterAuth({
  database: drizzleAdapter(db(), {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
  baseURL: {
    allowedHosts,
    fallback: baseUrl,
    protocol: new URL(baseUrl).protocol === "https:" ? "https" : "http",
  },
  trustedOrigins: frontendOrigins,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    autoSignIn: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        text:
          `We received a request to reset your password.\n\n` +
          `Reset link (expires in 1 hour):\n${url}\n\n` +
          `If you didn't request this, you can ignore this email.`,
      });
    },
  },
  socialProviders: enabledSocialProviders.google
    ? {
        google: {
          clientId: googleClientId!,
          clientSecret: googleClientSecret!,
          // Always show the account chooser, so a shared device doesn't
          // silently sign into whichever Google account is active.
          prompt: "select_account",
        },
      }
    : {},
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your email",
        text:
          `Welcome to jim-bro.ai.\n\n` +
          `Confirm your email:\n${url}\n\n` +
          `(Verification is optional — you can use the app without it.)`,
      });
    },
  },
  // The user table has no `image` column, but Better Auth's core user model
  // does: signup writes `image: null` and updateUser forwards any `image` in
  // the body. The Drizzle adapter throws on fields missing from the schema, so
  // drop it here (undefined = the adapter skips the field).
  //
  // create.after hands the new user to every onUserCreated listener (server
  // extensions hook in there).
  databaseHooks: {
    user: {
      create: {
        before: async () => ({ data: { image: undefined } }),
        after: async (user, ctx) => {
          for (const listener of userCreatedListeners) {
            try {
              await listener({
                userId: user.id,
                getCookie: (name) => ctx?.getCookie(name) ?? null,
              });
            } catch (err) {
              console.warn("[auth] onUserCreated listener failed", { userId: user.id, err });
            }
          }
        },
      },
      update: { before: async () => ({ data: { image: undefined } }) },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once per day of activity
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },
});

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
