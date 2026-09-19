/**
 * Core sending engine: one configured Nodemailer transport + one reusable
 * send function.
 *
 * Design notes
 * ------------
 * - The transport is a lazily-created singleton with connection pooling, so a
 *   loop over 40 leads reuses a single SMTP session instead of reconnecting
 *   40 times (Titan is much happier that way, and it is far faster).
 * - `sendEmail()` never throws on a delivery failure. It returns a result
 *   object. That keeps a future batch loop simple: one bad address should not
 *   abort the whole run, and the result maps 1:1 onto a status column in your
 *   Google Sheet / Airtable.
 */

import nodemailer from 'nodemailer';
import { config, fromHeader } from './config.js';
import { log } from './logger.js';

/** @type {import('nodemailer').Transporter | null} */
let transporter = null;

/**
 * Shared transport options: one authenticated pooled connection, gentle
 * concurrency, and fail-fast timeouts so a batch run can't hang forever.
 * @param {{host: string, port: number, secure: boolean, auth: {user: string, pass: string}}} smtpConfig
 */
function transportOptions(smtpConfig) {
  return {
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure, // true => implicit TLS (465)
    auth: smtpConfig.auth,

    pool: true,
    maxConnections: 1, // stay gentle: a single stream of mail, like a human
    maxMessages: 50, // reconnect after 50 messages on the same session

    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,

    tls: {
      minVersion: 'TLSv1.2',
      servername: smtpConfig.host,
    },
  };
}

/**
 * Build a standalone SMTP transport for a given account — independent of the
 * shared singleton below. Used by flows that send from a different mailbox
 * than the main one configured in `config.smtp` (e.g. the job-application
 * campaign, which sends from a personal Gmail account instead of Titan).
 *
 * @param {{host: string, port: number, secure: boolean, auth: {user: string, pass: string}}} smtpConfig
 * @returns {import('nodemailer').Transporter}
 */
export function createTransport(smtpConfig) {
  const t = nodemailer.createTransport(transportOptions(smtpConfig));

  log.info('SMTP transport created', {
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    user: smtpConfig.auth.user,
  });

  return t;
}

/**
 * Build (once) and return the shared SMTP transport for `config.smtp`.
 * @returns {import('nodemailer').Transporter}
 */
export function getTransporter() {
  if (transporter) return transporter;
  transporter = createTransport(config.smtp);
  return transporter;
}

/**
 * Check credentials and connectivity without sending anything.
 * Run this once at the start of a batch — it turns a wrong password into one
 * clear error instead of N identical failures.
 *
 * @param {import('nodemailer').Transporter} [t] Defaults to the shared singleton.
 * @returns {Promise<boolean>} true if the server accepted our login
 */
export async function verifyConnection(t = getTransporter()) {
  if (config.dryRun) {
    log.warn('DRY_RUN is on — skipping SMTP verification');
    return true;
  }

  try {
    await t.verify();
    log.ok('SMTP connection verified — ready to send');
    return true;
  } catch (error) {
    log.error('SMTP verification failed', describeError(error));
    return false;
  }
}

/**
 * Send one email.
 *
 * @param {object} message
 * @param {string}   message.to        Recipient address (or "Name <addr>").
 * @param {string}   message.subject   Subject line.
 * @param {string}  [message.text]     Plain-text body. Strongly recommended.
 * @param {string}  [message.html]     Optional HTML body (sent as the richer
 *                                     half of a multipart/alternative message).
 * @param {string}  [message.replyTo]  Overrides REPLY_TO for this message.
 * @param {string}  [message.cc]
 * @param {string}  [message.bcc]
 * @param {object}  [message.headers]  Extra SMTP headers (e.g. List-Unsubscribe).
 * @param {Array}   [message.attachments] Nodemailer attachment descriptors.
 * @param {object}  [message.meta]     Arbitrary context (leadId, sheet row …)
 *                                     echoed back in the result and the logs.
 * @param {import('nodemailer').Transporter} [message.transporter] Send through
 *                                     this transport instead of the shared
 *                                     singleton (e.g. a second account).
 * @param {string}  [message.from]     Overrides the default From: header —
 *                                     required when using a custom transporter
 *                                     for a different mailbox.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   to: string,
 *   subject: string,
 *   messageId?: string,
 *   response?: string,
 *   accepted?: string[],
 *   rejected?: string[],
 *   error?: { code?: string, command?: string, message: string, retryable: boolean },
 *   durationMs: number,
 *   meta?: object,
 * }>}
 */
export async function sendEmail({
  to,
  subject,
  text,
  html,
  replyTo,
  cc,
  bcc,
  headers,
  attachments,
  meta,
  transporter: transporterOverride,
  from,
}) {
  const startedAt = Date.now();

  // --- Validate before we bother the SMTP server -------------------------
  const problem = validateMessage({ to, subject, text, html });
  if (problem) {
    log.error(`Refusing to send: ${problem}`, { to, ...(meta ?? {}) });
    return {
      success: false,
      to,
      subject,
      error: { message: problem, retryable: false },
      durationMs: Date.now() - startedAt,
      meta,
    };
  }

  const mail = {
    from: from ?? fromHeader,
    to,
    subject,
    // Always include a plain-text part: HTML-only mail scores worse with spam
    // filters and renders badly in text clients.
    text: text ?? htmlToText(html),
    ...(html ? { html } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(headers ? { headers } : {}),
    ...(attachments ? { attachments } : {}),
  };

  const effectiveReplyTo = replyTo ?? config.sender.replyTo;
  if (effectiveReplyTo) mail.replyTo = effectiveReplyTo;

  // --- Dry run: log and stop --------------------------------------------
  if (config.dryRun) {
    log.warn(`DRY RUN — not sent to ${to}`, { subject, ...(meta ?? {}) });
    console.log('----- begin dry-run body -----');
    console.log(mail.text);
    console.log('----- end dry-run body -------\n');
    return {
      success: true,
      to,
      subject,
      messageId: 'dry-run',
      durationMs: Date.now() - startedAt,
      meta,
    };
  }

  // --- Actually send -----------------------------------------------------
  try {
    const info = await (transporterOverride ?? getTransporter()).sendMail(mail);
    const durationMs = Date.now() - startedAt;

    log.ok(`Sent to ${to}`, {
      subject,
      messageId: info.messageId,
      ms: durationMs,
      ...(meta ?? {}),
    });

    return {
      success: true,
      to,
      subject,
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted?.map(String),
      rejected: info.rejected?.map(String),
      durationMs,
      meta,
    };
  } catch (error) {
    const details = describeError(error);
    log.error(`Failed to send to ${to}: ${details.message}`, {
      subject,
      code: details.code,
      command: details.command,
      retryable: details.retryable,
      ...(meta ?? {}),
    });

    return {
      success: false,
      to,
      subject,
      error: details,
      durationMs: Date.now() - startedAt,
      meta,
    };
  }
}

/** Close the pooled connection so the process can exit cleanly. */
export function closeTransport() {
  if (!transporter) return;
  transporter.close();
  transporter = null;
  log.info('SMTP transport closed');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Loose address check — catches typos, not every RFC edge case. */
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function validateMessage({ to, subject, text, html }) {
  if (!to || typeof to !== 'string') return 'missing "to" address';

  // Accept both `addr@x.com` and `Name <addr@x.com>`.
  const bare = to.includes('<') ? to.slice(to.indexOf('<') + 1, to.indexOf('>')) : to;
  if (!EMAIL_RE.test(bare.trim())) return `"${to}" is not a valid email address`;

  if (!subject || !subject.trim()) return 'missing subject';
  if (!text?.trim() && !html?.trim()) return 'message has no body (text or html)';

  // Unreplaced template placeholders are the classic cold-email embarrassment.
  const unfilled = [subject, text, html]
    .filter(Boolean)
    .join(' ')
    .match(/\{\{\s*[\w.]+\s*\}\}/g);
  if (unfilled) return `unfilled template placeholders: ${[...new Set(unfilled)].join(', ')}`;

  return null;
}

/** Crude HTML -> text fallback, used only when no `text` was supplied. */
function htmlToText(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turn a Nodemailer/SMTP error into something loggable, and decide whether a
 * retry could plausibly help (useful for the batch runner in chunk 5).
 */
function describeError(error) {
  const code = error?.code;
  const responseCode = error?.responseCode;

  // 4xx SMTP replies are temporary; 5xx are permanent (bad mailbox, blocked).
  const temporarySmtp = typeof responseCode === 'number' && responseCode >= 400 && responseCode < 500;
  const networkish = ['ETIMEDOUT', 'ECONNECTION', 'ECONNRESET', 'ESOCKET', 'EDNS'].includes(code);

  let message = error?.message ?? String(error);
  if (code === 'EAUTH') {
    message = `Authentication rejected. Check the SMTP username/password — the full mailbox ` +
      `address is expected as the username (for Gmail, a 16-character App Password, not the ` +
      `account password). (${message})`;
  } else if (code === 'ECONNECTION' || code === 'ETIMEDOUT') {
    message = `Could not reach the SMTP server. If your network blocks port 465, try 587 with ` +
      `SECURE=false. (${message})`;
  }

  return {
    code,
    command: error?.command,
    responseCode,
    message,
    retryable: Boolean(temporarySmtp || networkish),
  };
}
