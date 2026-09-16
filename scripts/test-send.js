#!/usr/bin/env node
/**
 * Standalone smoke test for the sending engine.
 *
 *   npm run test:send                      -> sends to TEST_RECIPIENT from .env
 *   npm run test:send -- you@gmail.com     -> sends to that address instead
 *   DRY_RUN=true npm run test:send         -> prints the mail, sends nothing
 *
 * It does three things, in order, and stops at the first failure:
 *   1. shows the resolved config (password masked)
 *   2. verifies the SMTP login
 *   3. sends one real message through the same code path a campaign uses
 */

import { config, fromHeader } from '../src/config.js';
import { verifyConnection, sendEmail, closeTransport } from '../src/mailer.js';
import { renderMessage, TEMPLATES } from '../src/templates.js';
import { log } from '../src/logger.js';

const recipient = process.argv[2] ?? config.test.recipient;

async function main() {
  console.log('\n=== Zelectronics mailer — test send ===\n');

  // --- 1. Config sanity --------------------------------------------------
  log.info('Configuration', {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.auth.user,
    pass: mask(config.smtp.auth.pass),
    from: fromHeader,
    replyTo: config.sender.replyTo || '(none)',
    dryRun: config.dryRun,
  });

  if (!recipient) {
    log.error('No recipient. Set TEST_RECIPIENT in .env or pass one as an argument.');
    process.exitCode = 1;
    return;
  }

  // --- 2. Verify the SMTP login -----------------------------------------
  const ready = await verifyConnection();
  if (!ready) {
    log.error('Aborting: SMTP verification failed. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  // --- 3. Send one message ----------------------------------------------
  // Rendered through the real template layer, with a stand-in for the
  // AI-generated opener that chunk 4 will produce.
  const { subject, text } = renderMessage(TEMPLATES.introDay0, {
    firstName: 'there',
    company: 'your team',
    senderName: config.sender.signoff,
    senderTitle: config.sender.title,
    senderPhone: config.sender.phone,
    fromEmail: config.sender.email,
    website: config.sender.website,
    aiOpener:
      '[test send] This is the placeholder where the AI-personalised opening line goes.',
  });

  const result = await sendEmail({
    to: recipient,
    subject: `[TEST] ${subject}`,
    text,
    html: toSimpleHtml(text),
    meta: { source: 'test-send' },
  });

  console.log('\n--- result ---');
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    log.ok(`Test complete. Check the inbox for ${recipient} (and the spam folder).`);
  } else {
    log.error('Test send failed — see the error above.');
    process.exitCode = 1;
  }
}

/** Show the first and last character of a secret, nothing else. */
function mask(secret = '') {
  if (secret.length <= 2) return '**';
  return `${secret[0]}${'*'.repeat(Math.max(4, secret.length - 2))}${secret.at(-1)}`;
}

/** Wrap the plain-text body in minimal, mail-client-safe HTML. */
function toSimpleHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222;white-space:pre-wrap">${escaped}</div>`;
}

main()
  .catch((error) => {
    log.error(`Unexpected error: ${error.message}`);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeTransport);
