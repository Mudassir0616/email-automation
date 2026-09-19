/**
 * Template rendering.
 *
 * A template is plain text with `{{placeholder}}` slots. Lead data (from your
 * Google Sheet / Airtable in chunk 2) and the AI-generated opening line
 * (chunk 4) are both just keys in the same values object — so adding
 * personalisation later means passing one extra key, not rewriting anything.
 *
 *   render(TEMPLATES.introDay0, {
 *     firstName: 'Rahul',
 *     company: 'Acme Labs',
 *     aiOpener: 'Saw you just opened a second office in Andheri — congrats.',
 *     senderName: config.sender.signoff,
 *     senderFullName: config.sender.fullName,
 *     senderTitle: config.sender.title,
 *     senderPhone: config.sender.phone,
 *     fromEmail: config.sender.email,
 *     website: config.sender.website,
 *   })
 */

/**
 * Replace every `{{key}}` in `template` with `values[key]`.
 * Missing keys are left in place on purpose: `sendEmail()` refuses to send a
 * message containing unfilled placeholders, so a data gap fails loudly
 * instead of mailing "Hi {{firstName}}" to a real prospect.
 *
 * @param {string} template
 * @param {Record<string, string|number|undefined|null>} values
 * @returns {string}
 */
export function render(template, values = {}) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? match : String(value);
  });
}

/** Render subject + text + html in one call. */
export function renderMessage(template, values = {}) {
  return {
    subject: render(template.subject, values),
    text: render(template.text, values),
    ...(template.html ? { html: render(template.html, values) } : {}),
  };
}

/**
 * Campaign copy lives here so the sending code stays copy-agnostic.
 * `{{aiOpener}}` is the slot the Claude Haiku personalisation layer fills.
 *
 * Based on the founder's own draft, with the deliverability/structure fixes
 * agreed on: no attachment on a cold first-touch, filler opener cut, the
 * product list condensed, a specific low-friction CTA instead of a vague
 * "discuss further", and an opt-out line for goodwill + spam-complaint risk
 * at volume.
 */
export const TEMPLATES = {
  introDay0: {
    subject: 'IT Hardware Procurement for {{company}}',
    text: `Hi {{firstName}},

{{aiOpener}}

I'm {{senderName}}, {{senderTitle}} of Zelectronics. We help businesses with
reliable, cost-effective IT hardware procurement:

- Business laptops (new & refurbished)
- Custom desktop workstations
- Monitors & accessories
- RAM & SSD upgrades
- Bulk IT procurement

Whether you're onboarding new hires, upgrading existing systems, or planning
your next IT purchase, happy to help.

Want me to send pricing for a few laptop models, or would a quick call work
better?

Best regards,
{{senderFullName}}
{{senderTitle}} | Zelectronics
📞 {{senderPhone}}
✉️ {{fromEmail}}
🌐 {{website}}

---
Not the right person? Just reply "not me" and I'll close the loop.`,
  },

  /**
   * Job-application outreach (personal campaign, not Zelectronics). Sent from
   * a Gmail account with the CV attached — see scripts/job-application-campaign.js.
   * `{{greetingLine}}` and `{{companyMention}}` are computed per-recipient
   * (with/without a known contact name or company) rather than left as
   * plain fields, since an empty placeholder value is left unfilled by
   * render() and would fail the mailer's unfilled-placeholder check.
   */
  jobApplication: {
    subject: 'Application for Frontend / Full Stack Developer – {{senderFullName}}',
    text: `{{greetingLine}}

I'm writing to express my interest in a Software Developer opportunity {{companyMention}}. With 4 years of hands-on experience across e-commerce platforms, SaaS applications, and portfolio websites, I've focused heavily on building scalable and reusable frontend systems.

In my current role as a Senior Full Stack Developer (Frontend Lead) at WOLFx, I've worked on projects for clients like Mahindra, Indian Cyber Institute (ICI) and QuickSo India — delivering 15+ client projects end-to-end and improving Lighthouse performance scores by ~35% across production deployments.

I've attached my resume for your review. I'd appreciate the opportunity to discuss how my experience aligns with your team's goals.

Best regards,
{{senderFullName}}
{{senderPhone}}
{{linkedinUrl}}`,
  },
};
