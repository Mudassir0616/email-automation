/**
 * Central configuration.
 *
 * Every secret and tunable lives in the environment (see .env.example).
 * Nothing in this repo should read `process.env` directly except this file —
 * that way validation happens in exactly one place and the rest of the code
 * can trust the values it gets.
 */

import path from 'node:path';
import fs from 'node:fs';
import 'dotenv/config';

/** Read a required string. Throws early (at import time) if it is missing. */
function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Copy .env.example to .env and fill it in.`
    );
  }
  return value.trim();
}

/** Read an optional string, falling back to `fallback`. */
function optional(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/** Read a boolean-ish env var ("true"/"1"/"yes" => true). */
function bool(name, fallback = false) {
  const value = optional(name);
  if (value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

/** Read a positive integer, falling back if unset/invalid. */
function int(name, fallback) {
  const value = Number.parseInt(optional(name), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const port = int('SMTP_PORT', 465);

export const config = {
  smtp: {
    host: required('SMTP_HOST'),
    port,
    // Port 465 is implicit TLS; 587 upgrades via STARTTLS. Default follows the
    // port unless SMTP_SECURE is set explicitly.
    secure: bool('SMTP_SECURE', port === 465),
    auth: {
      user: required('SMTP_USER'),
      pass: required('SMTP_PASS'),
    },
  },

  sender: {
    name: optional('FROM_NAME', 'Zaid'),
    email: optional('FROM_EMAIL', process.env.SMTP_USER?.trim() ?? ''),
    replyTo: optional('REPLY_TO'),
    // First name used in the greeting ("I'm Zaid, Founder of..."). Kept
    // deliberately independent of FROM_NAME — that's often the business
    // brand (e.g. "Zelectronics"), and falling back to it here used to
    // produce "I'm Zelectronics, Founder of Zelectronics".
    signoff: optional('SIGNOFF_NAME', 'Zaid'),
    // Full name for the sign-off line ("Best regards, Zaid Shaikh").
    // Falls back to the first name above if not set separately.
    fullName: optional('SIGNOFF_FULL_NAME', optional('SIGNOFF_NAME', 'Zaid')),
    // Rest of the signature block.
    title: optional('SIGNOFF_TITLE', 'Founder'),
    // Falls back to a real number rather than '' — an empty value would leave
    // {{senderPhone}} unfilled in the template, which sendEmail() refuses to
    // send (see the unfilled-placeholder check in mailer.js).
    phone: optional('SIGNOFF_PHONE', '+91 84518 64754'),
    website: optional('WEBSITE_URL', 'www.zelectronics.co'),
  },

  attachment: {
    // On by default because it was asked for explicitly. See the note in
    // scripts/campaign.js about the deliverability trade-off — this is the
    // one switch to flip off (no code change) if bounce/spam rates climb.
    enabled: bool('ATTACH_COMPANY_PROFILE', true),
    path: optional(
      'COMPANY_PROFILE_PATH',
      path.resolve('assets/Zelectronics-Company-Introduction.pdf')
    ),
  },

  limits: {
    perDay: int('DAILY_SEND_LIMIT', 40),
    perHour: int('HOURLY_SEND_LIMIT', 15),
    minIntervalMs: int('MIN_SEND_INTERVAL_MS', 45_000),
  },

  // When true, sendEmail() logs the message and returns without connecting.
  dryRun: bool('DRY_RUN', false),

  test: {
    recipient: optional('TEST_RECIPIENT'),
  },
};

/**
 * Turn dry-run mode on at runtime (used by the `--dry` CLI flag) so a single
 * switch reaches every module. Can only be turned ON, never off: an operator
 * asking for a dry run must never be overridden into sending real mail.
 */
export function enableDryRun() {
  config.dryRun = true;
}

/** `"Zelectronics" <sales@zelectronics.co>` — the RFC-5322 From header. */
export const fromHeader = `"${config.sender.name}" <${config.sender.email}>`;

/**
 * The company-profile PDF as a Nodemailer attachment descriptor, or `null`
 * if attachments are turned off. Fails loudly (not silently) if the file is
 * missing while enabled — better a clear startup error than 2000 mails that
 * quietly went out without the PDF everyone expects.
 *
 * @returns {{ filename: string, path: string, contentType: string } | null}
 */
export function companyProfileAttachment() {
  if (!config.attachment.enabled) return null;

  if (!fs.existsSync(config.attachment.path)) {
    throw new Error(
      `ATTACH_COMPANY_PROFILE is on but no file exists at ${config.attachment.path}. ` +
        `Set COMPANY_PROFILE_PATH, or set ATTACH_COMPANY_PROFILE=false to send without it.`
    );
  }

  return {
    filename: 'Zelectronics-Company-Introduction.pdf',
    path: config.attachment.path,
    contentType: 'application/pdf',
  };
}
