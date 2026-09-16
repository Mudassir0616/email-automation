#!/usr/bin/env node
/**
 * Campaign runner — reads leads from the local .xlsx and sends the intro mail.
 *
 * Usage:
 *   npm run campaign -- --dry --limit 5          # preview 5, send nothing
 *   npm run campaign -- --limit 10 --tier 1      # really send to 10 tier-1 leads
 *   npm run campaign -- --limit 20 --tier 1,2,3
 *   npm run campaign -- --to someone@x.com       # single lead from the sheet
 *
 * Flags:
 *   --dry            render + log only, no SMTP (same as DRY_RUN=true)
 *   --limit N        max messages this run (on top of the env caps)
 *   --tier 1,2       only these priority tiers (default: all)
 *   --to EMAIL       just this one lead, looked up in the sheet
 *   --file PATH      a different workbook
 *   --sheet NAME     a different sheet
 *   --yes            skip the 5-second confirmation countdown
 *
 * Safety: every send is written to data/send-log.json before the next one
 * starts, so nobody is ever emailed twice — even if the run crashes.
 */

import process from 'node:process';
import { config, fromHeader, enableDryRun } from '../src/config.js';
import { verifyConnection, sendEmail, closeTransport } from '../src/mailer.js';
import { loadLeads } from '../src/leads.js';
import { SendLog } from '../src/sendLog.js';
import { RateLimiter } from '../src/rateLimiter.js';
import { renderMessage, TEMPLATES } from '../src/templates.js';
import { log } from '../src/logger.js';

const STEP = 'intro'; // chunk 5 adds 'followup1', 'followup2'

const args = parseArgs(process.argv.slice(2));
// Apply --dry before anything touches the transport, so the flag reaches
// verifyConnection() and sendEmail() too.
if (args.dry) enableDryRun();
const dryRun = config.dryRun;

async function main() {
  console.log('\n=== Zelectronics campaign runner ===\n');

  // --- 1. Who has already been contacted? --------------------------------
  const sendLog = new SendLog();
  const exclude = new Set([
    ...sendLog.contactedEmails(STEP),
    ...sendLog.suppressedEmails(),
  ]);

  // --- 2. Load and filter leads from the spreadsheet ---------------------
  const { leads, skipped, stats } = loadLeads({
    file: args.file,
    sheet: args.sheet,
    tiers: args.tier,
    limit: args.to ? undefined : args.limit,
    exclude,
  });

  let queue = leads;
  if (args.to) {
    const target = args.to.toLowerCase();
    queue = leads.filter((lead) => lead.email === target);
    if (!queue.length) {
      log.error(`"${args.to}" is not an eligible lead in the sheet.`);
      log.info('It may already be in the send log, or filtered out by --tier.');
      process.exitCode = 1;
      return;
    }
  }

  log.info('Lead pool', stats);
  if (skipped.length) {
    log.warn(`${skipped.length} row(s) skipped`, {
      reasons: [...new Set(skipped.map((s) => s.skipReason))],
    });
  }

  if (!queue.length) {
    log.warn('Nothing to send — no eligible leads matched.');
    return;
  }

  // --- 3. Pacing caps, seeded from the send log so cron runs stay honest --
  const limiter = new RateLimiter({ history: sendLog.sentTimestamps() });
  log.info('Send caps', {
    perDay: limiter.perDay,
    sentToday: limiter.countToday(),
    perHour: limiter.perHour,
    sentLastHour: limiter.countLastHour(),
    gapSeconds: Math.round(limiter.minIntervalMs / 1000),
  });

  // --- 4. Confirm, then verify SMTP --------------------------------------
  console.log('');
  log.info(dryRun ? `DRY RUN — previewing ${queue.length} message(s)` : 'LIVE SEND', {
    queued: queue.length,
    from: fromHeader,
    firstFew: queue.slice(0, 3).map((l) => l.email),
  });

  if (!dryRun && !args.yes) {
    await countdown(5);
  }

  if (!(await verifyConnection())) {
    log.error('Aborting: SMTP verification failed. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  // --- 5. The send loop --------------------------------------------------
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

    log.info(`[${index + 1}/${queue.length}] -> ${lead.email}`, {
      company: lead.company,
      tier: lead.tierRank,
    });

    const result = await sendEmail({
      ...message,
      to: lead.email,
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

      // A hard auth/connection failure will hit every remaining lead
      // identically — stop instead of burning through the queue.
      if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT'].includes(result.error?.code)) {
        log.error('Fatal SMTP problem — stopping the run.');
        break;
      }
    }
  }

  // --- 6. Summary --------------------------------------------------------
  console.log('');
  log.ok('Run complete', {
    sent,
    failed,
    dryRun,
    sentTodayTotal: limiter.countToday(),
    logFile: sendLog.file,
  });
  log.info('All-time log', sendLog.summary());
}

/**
 * Build the message for one lead.
 *
 * CHUNK 4 HOOK: replace the `aiOpener` line below with a call to the Claude
 * Haiku personaliser, e.g.
 *   const aiOpener = await generateOpener(lead);
 * Nothing else in this file has to change.
 */
function buildMessage(lead) {
  // 1351 rows have no contact name — greet the person, or fall back cleanly.
  const greetingName = lead.firstName || 'there';
  const companyLabel = lead.company || 'your team';

  const aiOpener = defaultOpener(lead);

  const { subject, text } = renderMessage(TEMPLATES.introDay0, {
    firstName: greetingName,
    company: companyLabel,
    senderName: config.sender.signoff,
    senderTitle: config.sender.title,
    senderPhone: config.sender.phone,
    fromEmail: config.sender.email,
    website: config.sender.website,
    aiOpener,
  });

  return { subject, text, html: toSimpleHtml(text) };
}

/** Placeholder opener until the AI layer lands — no fake specifics. */
function defaultOpener(lead) {
  const where = lead.area ? ` over in ${lead.area}` : ' in Mumbai';
  return (
    `I came across ${lead.company || 'your company'}${where} and thought this ` +
    `might be useful to whoever handles IT purchasing there.`
  );
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
    else if (arg === '--tier') out.tier = next().split(',').map((t) => Number.parseInt(t, 10));
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

main()
  .catch((error) => {
    log.error(`Unexpected error: ${error.message}`);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeTransport);
