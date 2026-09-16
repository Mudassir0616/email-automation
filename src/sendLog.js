/**
 * Persistent send log.
 *
 * The .xlsx stays the source of truth for *who* to contact; this JSON file is
 * the source of truth for *who has already been contacted*. Keeping them
 * separate means:
 *   - the tool never rewrites (or corrupts, or locks) your spreadsheet;
 *   - you can have the workbook open in Excel while a campaign runs;
 *   - daily/hourly caps survive a process restart or a cron schedule.
 *
 * Every send is appended and flushed to disk immediately, so a crash mid-batch
 * can never cause a double-send. Export it back to CSV for your sheet with:
 *   npm run export:status
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOG_PATH = path.resolve('data/send-log.json');

export class SendLog {
  /** @param {string} [file] */
  constructor(file = DEFAULT_LOG_PATH) {
    this.file = file;
    /** @type {Array<object>} */
    this.entries = [];
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      this.entries = [];
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (error) {
      // Never silently start from zero — that would mean re-emailing everyone.
      throw new Error(
        `Send log at ${this.file} is corrupt (${error.message}). ` +
          `Fix or move the file before running a campaign.`
      );
    }
  }

  /** Atomic write: tmp file + rename, so a crash can't truncate the log. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: this.entries }, null, 2)
    );
    fs.renameSync(tmp, this.file);
  }

  /**
   * Emails that must not be contacted again for this step.
   * Failures are NOT included — a soft bounce or a timeout should be retried.
   *
   * @param {string} [step] e.g. 'intro' (chunk 5 adds 'followup1', …)
   * @returns {Set<string>}
   */
  contactedEmails(step) {
    const emails = this.entries
      .filter((e) => e.status === 'sent' && (!step || e.step === step))
      .map((e) => e.email);
    return new Set(emails);
  }

  /** Every address that has ever replied or opted out — never contact again. */
  suppressedEmails() {
    const emails = this.entries
      .filter((e) => ['replied', 'unsubscribed', 'bounced'].includes(e.status))
      .map((e) => e.email);
    return new Set(emails);
  }

  /** Timestamps (ms) of successful sends — seeds the RateLimiter. */
  sentTimestamps() {
    return this.entries
      .filter((e) => e.status === 'sent')
      .map((e) => new Date(e.at).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
  }

  /**
   * Append one outcome and flush to disk.
   * @param {object} entry
   */
  record(entry) {
    this.entries.push({ at: new Date().toISOString(), ...entry });
    this.save();
  }

  /** Counts by status, for the run summary. */
  summary() {
    return this.entries.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {});
  }
}
