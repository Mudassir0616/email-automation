/**
 * Public surface of the sending engine.
 * Later chunks (sheet reader, AI personaliser, sequencer) should import from
 * here rather than reaching into individual files.
 */

export {
  config,
  fromHeader,
  jobFromHeader,
  enableDryRun,
  companyProfileAttachment,
  cvAttachment,
  requireJobSmtpConfig,
} from './config.js';
export { loadLeads, readWorkbook, countBy, firstNameOf } from './leads.js';
export { SendLog } from './sendLog.js';
export { getTransporter, createTransport, verifyConnection, sendEmail, closeTransport } from './mailer.js';
export { render, renderMessage, TEMPLATES } from './templates.js';
export { RateLimiter } from './rateLimiter.js';
export { log } from './logger.js';
