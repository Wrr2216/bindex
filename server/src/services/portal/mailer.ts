import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { maskEmail } from "./policy";

/**
 * Outgoing email, optional. With SMTP_URL blank nothing here loads nodemailer,
 * `mailAvailable()` is false, the screens hide what needs email, and
 * `sendMail` resolves to false. It never throws: an email that cannot be sent
 * is logged and the caller carries on.
 */

export type MailMessage = { to: string; subject: string; text: string };

/** The one method used from a nodemailer transport, so tests can pass their own. */
export type MailTransport = { sendMail(message: MailMessage & { from: string }): Promise<unknown> };

let override: MailTransport | null = null;
let loading: Promise<MailTransport | null> | null = null;

/** For tests: a transport to use instead of SMTP_URL (null goes back to it). */
export function setMailTransport(transport: MailTransport | null): void {
  override = transport;
}

export const mailAvailable = (): boolean => override !== null || env.smtpConfigured;

function load(): Promise<MailTransport | null> {
  loading ??= import("nodemailer")
    .then((nodemailer) =>
      nodemailer.createTransport({
        url: env.SMTP_URL.trim(),
        // A mail server that hangs must not hold a request, or the notifier, for long.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      } as Parameters<typeof nodemailer.createTransport>[0]) as unknown as MailTransport,
    )
    .catch((err) => {
      logger.warn("portal.mail.unavailable", { err: describeError(err) });
      loading = null;
      return null;
    });
  return loading;
}

function fromAddress(appName: string): string {
  if (env.SMTP_FROM.trim()) return env.SMTP_FROM.trim();
  let host = "localhost";
  try {
    host = new URL(env.APP_BASE_URL).hostname || host;
  } catch {
    // keep localhost
  }
  const name = appName.replace(/["<>\r\n]/g, "").trim() || "Bindex";
  return `"${name}" <no-reply@${host}>`;
}

export async function sendMail(message: MailMessage, appName: string, event = "portal.mail"): Promise<boolean> {
  if (!mailAvailable()) return false;
  const transport = override ?? (await load());
  if (!transport) return false;
  try {
    await transport.sendMail({ ...message, from: fromAddress(appName) });
    logger.info(`${event}.sent`, { to: maskEmail(message.to) });
    return true;
  } catch (err) {
    logger.warn(`${event}.failed`, { to: maskEmail(message.to), err: describeError(err) });
    return false;
  }
}
