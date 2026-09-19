#!/usr/bin/env node
/**
 * Job-application campaign — sends the application email + CV from a
 * personal Gmail account to a list of companies/recruiters.
 *
 * Independent of the Zelectronics business-outreach campaign: separate SMTP
 * account (config.job.smtp), separate recipient file, separate send log
 * (data/job-application-send-log.json) and separate rate limits. Running one
 * campaign never affects the other's dedupe/pacing state.
 *
 * Usage:
 *   npm run job:campaign -- --dry --limit 5          # preview 5, send nothing
 *   npm run job:campaign -- --limit 10               # really send to 10
 *   npm run job:campaign -- --to someone@company.com # single recipient from the sheet
 *
 * Flags:
 *   --dry            render + log only, no SMTP (same as DRY_RUN=true)
 *   --limit N        max messages this run (on top of the env caps)
 *   --to EMAIL       just this one recipient, looked up in the sheet
 *   --file PATH      a different workbook (default: data/job-application-recipients.xlsx)
 *   --sheet NAME     a different sheet (default: "Recipients")
 *   --yes            skip the 5-second confirmation countdown
 *
 * Safety: every send is written to data/job-application-send-log.json before
 * the next one starts, so nobody is ever emailed twice — even if the run
 * crashes. The CV is required (cvAttachment() throws if it's missing).
 */

import process from 'node:process';
import path from 'node:path';
import { config, enableDryRun, jobFromHeader, cvAttachment, requireJobSmtpConfig } from '../src/config.js';
import { createTransport, verifyConnection, sendEmail } from '../src/mailer.js';
import { loadLeads } from '../src/leads.js';
import { SendLog } from '../src/sendLog.js';
import { RateLimiter } from '../src/rateLimiter.js';
import { renderMessage, TEMPLATES } from '../src/templates.js';
import { log } from '../src/logger.js';

const STEP = 'application';
const DEFAULT_WORKBOOK = path.resolve('data/job-application-recipients.xlsx');
const DEFAULT_SHEET = 'Recipients';
const SEND_LOG_PATH = path.resolve('data/job-application-send-log.json');

const args = parseArgs(process.argv.slice(2));
if (args.dry) enableDryRun();
const dryRun = config.dryRun;

async function main() {
  console.log('\n=== Job application campaign ===\n');

  requireJobSmtpConfig();
  // Resolved once and reused for every send — throws immediately if the CV
  // is missing, rather than after mails have already gone out without it.
  const attachment = cvAttachment();

  // --- 1. Who has already been emailed? -----------------------------------
  const sendLog = new SendLog(SEND_LOG_PATH);
  const exclude = new Set([
    ...sendLog.contactedEmails(STEP),
    ...sendLog.suppressedEmails(),
  ]);

  // --- 2. Load and filter recipients from the spreadsheet -----------------
  const { leads, skipped, stats } = loadLeads({
    file: args.file ?? DEFAULT_WORKBOOK,
    sheet: args.sheet ?? DEFAULT_SHEET,
    limit: args.to ? undefined : args.limit,
    exclude,
  });

  let queue = leads;
  if (args.to) {
    const target = args.to.toLowerCase();
    queue = leads.filter((lead) => lead.email === target);
    if (!queue.length) {
      log.error(`"${args.to}" is not an eligible recipient in the sheet.`);
      log.info('It may already be in the send log.');
      process.exitCode = 1;
      return;
    }
  }

  log.info('Recipient pool', stats);
  if (skipped.length) {
    log.warn(`${skipped.length} row(s) skipped`, {
      reasons: [...new Set(skipped.map((s) => s.skipReason))],
    });
  }

  if (!queue.length) {
    log.warn('Nothing to send — no eligible recipients matched.');
    return;
  }

  // --- 3. Pacing caps, seeded from this campaign's own send log -----------
  const limiter = new RateLimiter({
    perDay: config.job.limits.perDay,
    perHour: config.job.limits.perHour,
    minIntervalMs: config.job.limits.minIntervalMs,
    history: sendLog.sentTimestamps(),
  });
  log.info('Send caps', {
    perDay: limiter.perDay,
    sentToday: limiter.countToday(),
    perHour: limiter.perHour,
    sentLastHour: limiter.countLastHour(),
    gapSeconds: Math.round(limiter.minIntervalMs / 1000),
  });

  console.log('');
  log.info(dryRun ? `DRY RUN — previewing ${queue.length} message(s)` : 'LIVE SEND', {
    queued: queue.length,
    from: jobFromHeader,
    attachment: attachment.filename,
    firstFew: queue.slice(0, 3).map((l) => l.email),
  });

  if (!dryRun && !args.yes) {
    await countdown(5);
  }

  const transporter = createTransport(config.job.smtp);
  if (!(await verifyConnection(transporter))) {
    log.error('Aborting: Gmail SMTP verification failed. Nothing was sent.');
    process.exitCode = 1;
    transporter.close();
    return;
  }

  // --- 4. The send loop -----------------------------------------------------
  let sent = 0;
  let failed = 0;

  for (const [index, lead] of queue.entries()) {
    const allowance = limiter.check();
    if (!allowance.allowed) {
      log.warn(`Stopping: ${allowance.reason}`, {
        resumeIn: humanDuration(allowance.retryAfterMs),
        remaining: queue.length - index,
      });
      break;
    }

    if (args.limit && sent >= args.limit) {
      log.info(`Reached --limit ${args.limit}`);
      break;
    }

    await limiter.waitForSlot();

    const message = buildMessage(lead);

    log.info(`[${index + 1}/${queue.length}] -> ${lead.email}`, { company: lead.company });

    const result = await sendEmail({
      ...message,
      to: lead.email,
      transporter,
      from: jobFromHeader,
      replyTo: config.job.sender.replyTo || config.job.sender.email,
      attachments: [attachment],
      meta: { leadId: lead.leadId, row: lead.rowNumber, company: lead.company, step: STEP },
    });

    if (result.success) {
      sent += 1;
      if (dryRun) continue; // a preview is not a send — don't touch the log
      limiter.record();
      sendLog.record({
        email: lead.email,
        leadId: lead.leadId,
        row: lead.rowNumber,
        company: lead.company,
        contactName: lead.contactName,
        step: STEP,
        status: 'sent',
        subject: result.subject,
        messageId: result.messageId,
      });
    } else {
      failed += 1;
      if (!dryRun) sendLog.record({
        email: lead.email,
        leadId: lead.leadId,
        row: lead.rowNumber,
        company: lead.company,
        step: STEP,
        status: 'failed',
        error: result.error?.message,
        errorCode: result.error?.code,
        retryable: result.error?.retryable,
      });

      // A hard auth/connection failure will hit every remaining recipient
      // identically — stop instead of burning through the queue.
      if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT'].includes(result.error?.code)) {
        log.error('Fatal SMTP problem — stopping the run.');
        break;
      }
    }
  }

  // --- 5. Summary ----------------------------------------------------------
  console.log('');
  log.ok('Run complete', {
    sent,
    failed,
    dryRun,
    sentTodayTotal: limiter.countToday(),
    logFile: sendLog.file,
  });
  log.info('All-time log', sendLog.summary());

  transporter.close();
}

/** Build the message for one recipient. */
function buildMessage(lead) {
  const greetingLine = lead.firstName ? `Hi ${lead.firstName},` : 'Hello,';
  const companyMention = lead.company ? `at ${lead.company}` : 'at your company';

  const { subject, text } = renderMessage(TEMPLATES.jobApplication, {
    greetingLine,
    companyMention,
    senderFullName: config.job.sender.fullName,
    senderPhone: config.job.sender.phone,
    linkedinUrl: config.job.sender.linkedin,
  });

  return { subject, text, html: toSimpleHtml(text) };
}

function toSimpleHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222;white-space:pre-wrap">${escaped}</div>`;
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dry: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];

    if (arg === '--dry') out.dry = true;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--limit') out.limit = Number.parseInt(next(), 10);
    else if (arg === '--to') out.to = next().trim();
    else if (arg === '--file') out.file = next();
    else if (arg === '--sheet') out.sheet = next();
    else log.warn(`Ignoring unknown argument: ${arg}`);
  }
  return out;
}

/** Visible pause before a live run, so a mistyped command is recoverable. */
async function countdown(seconds) {
  for (let n = seconds; n > 0; n -= 1) {
    process.stdout.write(`\r  Sending for real in ${n}s…  (Ctrl+C to abort) `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
}

function humanDuration(ms = 0) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

main().catch((error) => {
  log.error(`Unexpected error: ${error.message}`);
  console.error(error);
  process.exitCode = 1;
});
