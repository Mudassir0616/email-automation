/**
 * Send-rate guardrails.
 *
 * Cold outreach dies on volume spikes: a fresh domain that sends 200 mails in
 * an hour lands in spam permanently. This module enforces three limits that
 * the batch runner (chunk 5) wraps around every send:
 *
 *   - a hard daily cap          (DAILY_SEND_LIMIT)
 *   - a rolling-hour cap        (HOURLY_SEND_LIMIT)
 *   - a minimum gap between two sends, jittered (MIN_SEND_INTERVAL_MS)
 *
 * State is seeded from the SendLog, so the caps hold across restarts and
 * across separate cron runs on the same day.
 */

import { config } from './config.js';
import { log } from './logger.js';

const HOUR_MS = 60 * 60 * 1000;

export class RateLimiter {
  /**
   * @param {object} [limits]
   * @param {number} [limits.perDay]
   * @param {number} [limits.perHour]
   * @param {number} [limits.minIntervalMs]
   * @param {number[]} [limits.history] Timestamps (ms) of earlier sends —
   *        pass `sendLog.sentTimestamps()` so caps survive a restart or cron.
   */
  constructor(limits = {}) {
    this.perDay = limits.perDay ?? config.limits.perDay;
    this.perHour = limits.perHour ?? config.limits.perHour;
    this.minIntervalMs = limits.minIntervalMs ?? config.limits.minIntervalMs;

    /** @type {number[]} ascending timestamps (ms) of sends */
    this.history = [...(limits.history ?? [])].sort((a, b) => a - b);
    // Seeded history counts toward the caps, but must not make the first send
    // of a fresh run wait out a gap that already elapsed hours ago.
    this.lastSentAt = 0;
  }

  /** Sends recorded in the current local calendar day. */
  countToday() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.history.filter((t) => t >= startOfDay.getTime()).length;
  }

  /** Sends recorded in the last rolling 60 minutes. */
  countLastHour() {
    const cutoff = Date.now() - HOUR_MS;
    return this.history.filter((t) => t >= cutoff).length;
  }

  /**
   * @returns {{ allowed: boolean, reason?: string, retryAfterMs?: number }}
   */
  check() {
    if (this.countToday() >= this.perDay) {
      return {
        allowed: false,
        reason: `daily limit reached (${this.perDay})`,
        retryAfterMs: msUntilTomorrow(),
      };
    }

    if (this.countLastHour() >= this.perHour) {
      // The window frees up when the oldest send inside it ages out.
      const cutoff = Date.now() - HOUR_MS;
      const oldestInWindow = this.history.find((t) => t >= cutoff) ?? Date.now();
      return {
        allowed: false,
        reason: `hourly limit reached (${this.perHour})`,
        retryAfterMs: Math.max(0, oldestInWindow + HOUR_MS - Date.now()),
      };
    }

    return { allowed: true };
  }

  /** Record that a message just went out. Call this after a successful send. */
  record(at = Date.now()) {
    this.history.push(at);
    this.lastSentAt = at;
  }

  /**
   * Wait out the minimum inter-send gap, with +/-30% jitter so the cadence
   * does not look machine-generated. No-op on the first send.
   */
  async waitForSlot() {
    if (!this.lastSentAt || this.minIntervalMs <= 0) return;

    const jitter = this.minIntervalMs * (Math.random() * 0.6 - 0.3);
    const target = this.lastSentAt + this.minIntervalMs + jitter;
    const waitMs = Math.round(target - Date.now());

    if (waitMs > 0) {
      log.info(`Pacing: waiting ${(waitMs / 1000).toFixed(1)}s before next send`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function msUntilTomorrow() {
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow.getTime() - Date.now();
}
