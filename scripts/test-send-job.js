#!/usr/bin/env node
/**
 * Standalone smoke test for the job-application mailbox (Gmail).
 *
 *   npm run job:test                      -> sends to JOB_TEST_RECIPIENT from .env
 *   npm run job:test -- you@gmail.com     -> sends to that address instead
 *   npm run job:dry                       -> prints the mail, sends nothing
 *
 * It does three things, in order, and stops at the first failure:
 *   1. shows the resolved config (app password masked)
 *   2. verifies the Gmail SMTP login
 *   3. sends one real message, with the CV attached, through the same code
 *      path scripts/job-application-campaign.js uses
 */

import { config, jobFromHeader, cvAttachment, requireJobSmtpConfig } from '../src/config.js';
import { createTransport, verifyConnection, sendEmail } from '../src/mailer.js';
import { renderMessage, TEMPLATES } from '../src/templates.js';
import { log } from '../src/logger.js';

const recipient = process.argv[2] ?? config.job.test.recipient;

async function main() {
  console.log('\n=== Job application mailer — test send ===\n');

  requireJobSmtpConfig();

  log.info('Configuration', {
    host: config.job.smtp.host,
    port: config.job.smtp.port,
    secure: config.job.smtp.secure,
    user: config.job.smtp.auth.user,
    pass: mask(config.job.smtp.auth.pass),
    from: jobFromHeader,
    dryRun: config.dryRun,
  });

  if (!recipient) {
    log.error('No recipient. Set JOB_TEST_RECIPIENT in .env or pass one as an argument.');
    process.exitCode = 1;
    return;
  }

  const attachment = cvAttachment();
  log.info('Attachment', { file: attachment.filename });

  const transporter = createTransport(config.job.smtp);

  const ready = await verifyConnection(transporter);
  if (!ready) {
    log.error('Aborting: Gmail SMTP verification failed. Nothing was sent.');
    process.exitCode = 1;
    transporter.close();
    return;
  }

  const { subject, text } = renderMessage(TEMPLATES.jobApplication, {
    greetingLine: 'Hi there,',
    companyMention: 'at your company',
    senderFullName: config.job.sender.fullName,
    senderPhone: config.job.sender.phone,
    linkedinUrl: config.job.sender.linkedin,
  });

  const result = await sendEmail({
    to: recipient,
    subject: `[TEST] ${subject}`,
    text,
    html: toSimpleHtml(text),
    transporter,
    from: jobFromHeader,
    attachments: [attachment],
    meta: { source: 'test-send-job' },
  });

  console.log('\n--- result ---');
  console.log(JSON.stringify(result, null, 2));

  transporter.close();

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

function toSimpleHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222;white-space:pre-wrap">${escaped}</div>`;
}

main().catch((error) => {
  log.error(`Unexpected error: ${error.message}`);
  console.error(error);
  process.exitCode = 1;
});
