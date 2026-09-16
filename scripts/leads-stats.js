#!/usr/bin/env node
/**
 * Read-only look at the lead file. Touches no SMTP, sends nothing.
 *   npm run leads
 */

import { readWorkbook, countBy, DEFAULT_WORKBOOK } from '../src/leads.js';
import { SendLog } from '../src/sendLog.js';

const { leads, skipped } = readWorkbook({ file: process.argv[2] });
const sendLog = new SendLog();
const contacted = sendLog.contactedEmails();

console.log(`\n=== Lead file: ${process.argv[2] ?? DEFAULT_WORKBOOK} ===\n`);
console.log(`Usable leads : ${leads.length}`);
console.log(`Skipped rows : ${skipped.length}`);
console.log(`Already sent : ${contacted.size}`);
console.log(`Remaining    : ${leads.filter((l) => !contacted.has(l.email)).length}\n`);

console.log('By priority tier:');
for (const [tier, count] of Object.entries(countBy(leads, 'tier')).sort()) {
  console.log(`  ${String(count).padStart(5)}  ${tier}`);
}

console.log('\nBy status in the sheet:');
for (const [status, count] of Object.entries(countBy(leads, 'status'))) {
  console.log(`  ${String(count).padStart(5)}  ${status}`);
}

const named = leads.filter((l) => l.firstName).length;
console.log(`\nWith a usable first name: ${named} / ${leads.length}`);

if (skipped.length) {
  console.log('\nSkip reasons:');
  for (const [reason, count] of Object.entries(countBy(skipped, 'skipReason'))) {
    console.log(`  ${String(count).padStart(5)}  ${reason}`);
  }
}

const logSummary = sendLog.summary();
if (Object.keys(logSummary).length) {
  console.log('\nSend log:');
  for (const [status, count] of Object.entries(logSummary)) {
    console.log(`  ${String(count).padStart(5)}  ${status}`);
  }
}
console.log('');
