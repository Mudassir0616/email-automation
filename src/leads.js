/**
 * Lead loading (chunk 2).
 *
 * Reads the leads straight out of the local .xlsx — nothing gets uploaded
 * anywhere. Keep editing the file in Excel / LibreOffice / Google Sheets
 * (export back to .xlsx); the next run picks up whatever is in it.
 *
 * Responsibilities: read -> normalise column names -> validate -> dedupe ->
 * filter. Whatever comes out of `loadLeads()` is safe to hand to sendEmail().
 */

import path from 'node:path';
import fs from 'node:fs';
import XLSX from 'xlsx';
import { log } from './logger.js';

// SheetJS's ESM build has no filesystem access wired up by default.
XLSX.set_fs(fs);

export const DEFAULT_WORKBOOK = path.resolve('data/zelectronics-leads-cleaned.xlsx');
export const DEFAULT_SHEET = 'Leads (ready to import)';

/** Same loose check the mailer uses, applied early so bad rows never queue. */
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Column aliases -> canonical field name. Lets the loader survive a renamed
 * or re-cased header without a code change.
 */
const COLUMN_ALIASES = {
  lead_id: 'leadId',
  id: 'leadId',
  company: 'company',
  company_name: 'company',
  contact_name: 'contactName',
  name: 'contactName',
  designation: 'designation',
  title: 'designation',
  email: 'email',
  'email address': 'email',
  phone: 'phone',
  address: 'address',
  area: 'area',
  priority_tier: 'tier',
  tier: 'tier',
  status: 'status',
  source: 'source',
  linkedin: 'linkedin',
  industry: 'industry',
  company_size: 'companySize',
};

function canonicalKey(header) {
  const key = String(header).trim().toLowerCase().replace(/\s+/g, '_');
  return COLUMN_ALIASES[key] ?? COLUMN_ALIASES[key.replace(/_/g, ' ')] ?? key;
}

/**
 * Pull the first name out of a contact name, stripping honorifics.
 * "Mr.Nitin S Sawarkar" -> "Nitin".  Empty input -> ''.
 */
export function firstNameOf(contactName = '') {
  const cleaned = String(contactName)
    .replace(/^\s*(mr|mrs|ms|miss|dr|prof|shri|smt)\.?\s*/i, '')
    .trim();
  if (!cleaned) return '';

  const first = cleaned.split(/[\s.]+/)[0];
  // Reject initials ("S", "K.") and ALL-CAPS noise that isn't a name.
  if (first.length < 2) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Read + normalise leads from the workbook.
 *
 * @param {object} [options]
 * @param {string} [options.file]   Path to the .xlsx (default: data/…cleaned.xlsx)
 * @param {string} [options.sheet]  Sheet name (default: "Leads (ready to import)")
 * @returns {{ leads: object[], skipped: object[] }}
 */
export function readWorkbook({ file = DEFAULT_WORKBOOK, sheet = DEFAULT_SHEET } = {}) {
  if (!fs.existsSync(file)) {
    throw new Error(`Lead file not found: ${file}`);
  }

  const workbook = XLSX.readFile(file);
  const sheetName = workbook.SheetNames.includes(sheet) ? sheet : workbook.SheetNames[0];
  if (sheetName !== sheet) {
    log.warn(`Sheet "${sheet}" not found — using "${sheetName}"`, {
      available: workbook.SheetNames,
    });
  }

  const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

  const leads = [];
  const skipped = [];
  const seenEmails = new Set();

  raw.forEach((row, index) => {
    /** @type {Record<string, any>} */
    const lead = {};
    for (const [header, value] of Object.entries(row)) {
      lead[canonicalKey(header)] = typeof value === 'string' ? value.trim() : value;
    }

    // Row number as it appears in Excel (header is row 1).
    lead.rowNumber = index + 2;
    lead.email = String(lead.email ?? '').trim().toLowerCase();
    lead.company = String(lead.company ?? '').trim();
    lead.contactName = String(lead.contactName ?? '').trim();
    lead.firstName = firstNameOf(lead.contactName);
    lead.status = String(lead.status ?? '').trim() || 'Not Contacted';
    lead.tier = String(lead.tier ?? '').trim();
    // "1 - High fit (…)" -> 1;  unclassified -> 9 so it sorts last.
    lead.tierRank = Number.parseInt(lead.tier, 10) || 9;

    if (!lead.email) {
      skipped.push({ ...lead, skipReason: 'no email' });
      return;
    }
    if (!EMAIL_RE.test(lead.email)) {
      skipped.push({ ...lead, skipReason: `invalid email "${lead.email}"` });
      return;
    }
    if (seenEmails.has(lead.email)) {
      skipped.push({ ...lead, skipReason: 'duplicate email in sheet' });
      return;
    }

    seenEmails.add(lead.email);
    leads.push(lead);
  });

  return { leads, skipped };
}

/**
 * Load leads ready to be emailed.
 *
 * @param {object} [options]
 * @param {string}   [options.file]
 * @param {string}   [options.sheet]
 * @param {number[]} [options.tiers]     Only these priority tiers, e.g. [1, 2].
 * @param {string[]} [options.statuses]  Only these sheet statuses.
 *                                       Default: only "Not Contacted".
 * @param {number}   [options.limit]     Take at most N (after sorting).
 * @param {Set<string>|string[]} [options.exclude] Emails already contacted.
 * @returns {{ leads: object[], skipped: object[], stats: object }}
 */
export function loadLeads({
  file,
  sheet,
  tiers,
  statuses = ['not contacted'],
  limit,
  exclude,
} = {}) {
  const { leads: all, skipped } = readWorkbook({ file, sheet });
  const excludeSet = exclude instanceof Set ? exclude : new Set(exclude ?? []);

  let eligible = all;

  if (statuses?.length) {
    const wanted = statuses.map((s) => s.toLowerCase());
    eligible = eligible.filter((lead) => wanted.includes(lead.status.toLowerCase()));
  }

  if (tiers?.length) {
    eligible = eligible.filter((lead) => tiers.includes(lead.tierRank));
  }

  const alreadyContacted = eligible.filter((lead) => excludeSet.has(lead.email)).length;
  eligible = eligible.filter((lead) => !excludeSet.has(lead.email));

  // Best-fit contacts first; within a tier, named contacts before nameless
  // ones (a real first name personalises much better).
  eligible.sort(
    (a, b) => a.tierRank - b.tierRank || (b.firstName ? 1 : 0) - (a.firstName ? 1 : 0)
  );

  const selected = typeof limit === 'number' ? eligible.slice(0, limit) : eligible;

  return {
    leads: selected,
    skipped,
    stats: {
      totalRows: all.length + skipped.length,
      valid: all.length,
      skipped: skipped.length,
      eligible: eligible.length,
      alreadyContacted,
      selected: selected.length,
    },
  };
}

/** Count leads by a given field — used by the stats script. */
export function countBy(leads, field) {
  return leads.reduce((acc, lead) => {
    const key = String(lead[field] ?? '').trim() || '(blank)';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}
