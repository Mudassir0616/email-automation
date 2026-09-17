# Zelectronics — cold-email engine (chunk 3)

Node.js + Nodemailer sending engine for outreach from `@zelectronics.co`,
using Titan Mail's SMTP.

## Setup

```bash
npm install
cp .env.example .env    # then fill in SMTP_USER / SMTP_PASS / TEST_RECIPIENT
```

Titan SMTP settings (domain bought through GoDaddy, mail hosted by Titan):

| Setting | Value |
| --- | --- |
| Host | `smtp.titan.email` |
| Port | `465` (SSL/TLS) — or `587` with `SMTP_SECURE=false` if 465 is blocked |
| Username | your full mailbox address, e.g. `sales@zelectronics.co` |
| Password | the mailbox password |

`.env` is gitignored. Credentials never appear in code.

Signature block (used in the email body, separate from the SMTP login):

| Variable | Meaning |
| --- | --- |
| `SIGNOFF_NAME` | First name, used in the greeting line (e.g. `Zaid`) — a person, not the brand |
| `SIGNOFF_FULL_NAME` | Full name for "Best regards," (e.g. `Zaid Shaikh`) — falls back to `SIGNOFF_NAME` |
| `SIGNOFF_TITLE` | e.g. `Founder` |
| `SIGNOFF_PHONE` | Shown in the signature |
| `WEBSITE_URL` | Shown in the signature |

## Test it

```bash
npm run dry                          # renders + prints the mail, sends nothing
npm run test:send                    # sends to TEST_RECIPIENT
npm run test:send -- you@gmail.com   # sends to a specific address
```

The test script verifies the SMTP login *before* attempting a send, so a wrong
password fails with one clear message instead of a stack trace.

## Layout

```
src/config.js       env loading + validation (the only file reading process.env)
src/leads.js        reads + normalises + filters the .xlsx
src/sendLog.js      persistent "already contacted" record (data/send-log.json)
src/mailer.js       pooled transport, verifyConnection(), sendEmail()
src/templates.js    {{placeholder}} rendering + campaign copy
src/rateLimiter.js  daily / hourly caps + jittered pacing
src/logger.js       timestamped console logging
src/index.js        barrel export — import from here
scripts/test-send.js     one-off smoke test
scripts/campaign.js      the batch runner
scripts/leads-stats.js   read-only view of the lead file
scripts/export-status.js send log -> CSV
```

## Using it

```js
import { sendEmail, renderMessage, TEMPLATES, verifyConnection, closeTransport } from './src/index.js';

await verifyConnection();

const { subject, text } = renderMessage(TEMPLATES.introDay0, {
  firstName: 'Rahul',
  company: 'Acme Labs',
  senderName: 'Vrijesh',
  aiOpener: 'Saw Acme just took a second floor in Andheri — congrats.',
});

const result = await sendEmail({ to: 'rahul@acme.com', subject, text, meta: { sheetRow: 12 } });
// result.success -> write back to the "status" column in your sheet

closeTransport();
```

`sendEmail()` **never throws** on a delivery failure — it returns
`{ success, messageId, error: { code, message, retryable }, ... }`. One bad
address therefore can't abort a whole batch, and the result maps straight onto
a status column.

It refuses to send when: the address is malformed, the subject is empty, there
is no body, or the copy still contains an unfilled `{{placeholder}}`.

## Sending from the lead file (chunk 2)

Nothing gets uploaded anywhere. `data/zelectronics-leads-cleaned.xlsx` is read
from disk on every run. Edit it in Excel / LibreOffice / Google Sheets (export
back to .xlsx) and the next run picks up the changes.

```bash
npm run leads                                   # what's in the file (read-only)
npm run campaign -- --dry --limit 5 --tier 1    # preview 5 mails, sends nothing
npm run campaign -- --limit 5 --tier 1          # actually send 5
npm run export:status                           # send log -> data/send-status.csv
```

| Flag | Meaning |
| --- | --- |
| `--dry` | Render and print, never touch SMTP |
| `--limit N` | Cap this run at N messages |
| `--tier 1,2` | Only these priority tiers (1 = best fit) |
| `--to EMAIL` | Just that one lead from the sheet |
| `--file` / `--sheet` | A different workbook or tab |
| `--yes` | Skip the 5-second countdown before a live run |

### Who gets picked

Leads are sorted best-fit first: tier 1 → 4 → unclassified, and within a tier
the rows that have a real contact name come first (they personalise better).

Three filters decide eligibility: the sheet's `status` must be `Not Contacted`,
the email must be valid and unique, and the address must not already appear in
`data/send-log.json`.

### The send log

`data/send-log.json` records every send the moment it happens, before the next
one starts. It — not the spreadsheet — is what stops anyone being emailed
twice, which means:

- the tool never rewrites or locks your .xlsx (keep it open in Excel if you like);
- a crash or a Ctrl+C mid-batch is safe — rerun the same command and it picks up
  where it stopped;
- daily and hourly caps hold **across runs**, so a cron job can't blow past them;
- failures are logged but *not* suppressed — a timeout or soft bounce is retried
  on the next run, while a successful send never is.

Dry runs are never written to it.

## Company profile attachment

Every mail attaches `assets/Zelectronics-Company-Introduction.pdf` (54 KB) by
default:

| Variable | Meaning |
| --- | --- |
| `ATTACH_COMPANY_PROFILE` | `true`/`false` — on by default |
| `COMPANY_PROFILE_PATH` | Path to the PDF, if you move or replace it |

Both `npm run test:send` and `npm run campaign` resolve it the same way, once
per run, via `companyProfileAttachment()` in `src/config.js`. If
`ATTACH_COMPANY_PROFILE=true` but the file doesn't exist at that path, the run
fails immediately with a clear error rather than quietly sending without it.

Worth knowing: an unsolicited attachment on a cold first-touch is a heavier
spam-filter signal than a link, especially before `zelectronics.co` has built
up sending reputation. If bounce or spam-complaint rates look bad, set
`ATTACH_COMPANY_PROFILE=false` in `.env` — no code change needed.

## Hooks for the next chunks

- **Chunk 4 (AI personalisation):** `buildMessage()` in `scripts/campaign.js`
  has the hook — swap `defaultOpener(lead)` for `await generateOpener(lead)`.
  Nothing else changes.
- **Chunk 5 (follow-ups):** the send log already stores a `step` field
  (currently always `'intro'`). Add `followup1` to `TEMPLATES`, then select
  leads whose newest `intro` entry is 3+ days old and has no `replied` entry.
- **Chunk 6 (replies):** record `{ email, status: 'replied' }` in the send log
  from an IMAP poll — `suppressedEmails()` already excludes those addresses
  from every future run.

## Deliverability notes

- Keep `DAILY_SEND_LIMIT` low (20–40) for the first few weeks on a new sending
  domain, and raise it slowly.
- Every message goes out as multipart with a real plain-text part; HTML-only
  mail scores worse with filters.
- Confirm SPF, DKIM and DMARC are live for `zelectronics.co` (chunk 1) before
  any volume — this engine can't compensate for unauthenticated mail.
