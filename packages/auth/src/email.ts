/**
 * Email sender. Uses Resend in production; falls back to console.log in dev
 * when RESEND_API_KEY is unset (so password-reset/verify links are still
 * recoverable without external creds).
 */
import { Resend } from "resend";

let _resend: Resend | null = null;
function resend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const from = process.env.EMAIL_FROM ?? "noreply@example.com";
  const r = resend();
  if (!r) {
    console.log("\n[email] (dev mode — no RESEND_API_KEY)");
    console.log(`  from: ${from}`);
    console.log(`  to:   ${input.to}`);
    console.log(`  subj: ${input.subject}`);
    console.log(
      `  body:\n${input.text
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")}\n`,
    );
    return;
  }
  const result = await r.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  });
  if (result.error) {
    throw new Error(`resend send failed: ${result.error.message}`);
  }
}
