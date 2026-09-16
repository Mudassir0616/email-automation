#!/usr/bin/env node
/**
 * Export the send log to CSV so you can paste the results back into the
 * spreadsheet (or just keep it as the record of what went out).
 *   npm run export:status            -> data/send-status.csv
 *   npm run export:status -- out.csv
 */

import fs from 'node:fs';
import path from 'node:path';
import { SendLog } from '../src/sendLog.js';
import { log } from '../src/logger.js';

const outFile = path.resolve(process.argv[2] ?? 'data/send-status.csv');
const sendLog = new SendLog();

const COLUMNS = ['at', 'lead_id', 'row', 'email', 'company', 'contact_name', 'step', 'status', 'subject', 'message_id', 'error'];

const rows = sendLog.entries.map((e) => [
  e.at, e.leadId, e.row, e.email, e.company, e.contactName,
  e.step, e.status, e.subject, e.messageId, e.error,
]);

const csv = [COLUMNS, ...rows]
  .map((row) => row.map(csvCell).join(','))
  .join('\n');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${csv}\n`);

log.ok(`Wrote ${rows.length} row(s) to ${outFile}`);

/** Quote anything containing a comma, quote or newline; escape inner quotes. */
function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
