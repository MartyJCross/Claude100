# MeterProof

**Check your municipal bill against your own meter, and dispute it properly.**

South African municipalities, Johannesburg above all, routinely bill water and electricity on
*estimated* readings. Estimates compound, interest is added, and households end up with bills
many times their real usage plus disconnection threats. People lose these fights because
their complaints are vague: the Supreme Court of Appeal has held that only a dispute about
**specific amounts** triggers the protection in section 102(2) of the Municipal Systems Act.

MeterProof turns a homeowner's phone into an evidence machine:

1. **Log dated meter photos.** The camera's EXIF timestamp is read as independent proof.
2. **Add bills.** Every bill's reading dates are matched to what the meter actually showed
   (interpolated between readings), so over-billing is found and **priced in Rand**.
3. **Dispute properly.** One click produces a Section 102 dispute letter naming the specific
   amounts, an evidence-pack PDF (letter, readings log, photos, calculation), and later the
   follow-up, Section 62 appeal and disconnection-response letters. It also works out the
   undisputed amount to keep paying so the customer stays in good standing.

It also tells users honestly when the bill is right or when their own readings suggest a leak.

## What is included

| Area | Details |
|---|---|
| Product | Properties, readings with photo upload and EXIF time, bills with line items, the bill-vs-meter engine, charts, findings, dispute builder, four letter types, PDF evidence pack, dispute tracker and timeline |
| Payments | PayFast once-off and monthly subscriptions (signed checkout, ITN verification, renewals, cancellation via the PayFast API), direct EFT to your bank account with admin "mark received", PDF receipts |
| Plans | Free (1 property, full analysis) · Dispute Pack R299 once-off (6 months) · Homeowner R59/month or R590/year · Landlord R249/month or R2 490/year (15 properties) |
| Metrics | Admin dashboard with MRR, ARR run-rate, revenue (gross and net of fees), churn, ARPU, a visitor → paid funnel, sign-ups and revenue charts, acquisition sources, and customer outcomes (amount disputed, credits won) |
| Growth | Free no-signup bill checker, an SEO guide, first-party analytics with UTM and referrer attribution, sitemap |
| Email | Welcome, password reset, receipts, monthly reading reminders, dispute follow-ups at 14, 30 and 60 days, unsent-draft nudges, plan expiry |
| Trust and compliance | POPIA privacy policy, data export, self-service account deletion, ECT Act supplier details, CSRF protection, a strict CSP, scrypt passwords, rate limiting, uploads checked by file content and served only to their owner |

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000, PayFast sandbox, emails saved to data/outbox
npm test               # unit and end-to-end tests
```

To explore with realistic data:

```bash
DATA_DIR=./data-demo npm run seed
DATA_DIR=./data-demo ADMIN_EMAILS=owner@meterproof.co.za npm run dev
# customer: demo@meterproof.co.za / demo password
# admin:    owner@meterproof.co.za / demo password  → /admin
```

In development, the checkout page has a **Simulate successful payment** button, so you can test
paid features without PayFast. It is disabled automatically in production.

Requires Node.js 22.13 or newer. The app uses the built-in `node:sqlite`, so there is no
database server to run.

## Going live

See **[docs/GO-LIVE.md](docs/GO-LIVE.md)**. It covers opening a PayFast account that pays out to
your FNB account, hosting (Render blueprint or Docker on any VPS), email, your domain, legal
details and a launch checklist.

The business case, pricing logic, unit economics and go-to-market plan are in
**[docs/BUSINESS.md](docs/BUSINESS.md)**.

## Project layout

```
src/
  server.js, app.js        HTTP server and middleware
  config.js, db.js         environment config, SQLite schema and migrations
  lib/analysis.js          the bill-vs-meter engine (pure functions, unit tested)
  lib/letters.js, pdf.js   letter models, PDF letter, evidence pack and receipts
  lib/payfast.js           PayFast signing, ITN validation, subscriptions API
  lib/billing.js, plans.js payments, entitlements, renewals
  lib/metrics.js           admin metrics
  lib/scheduler.js         hourly reminder emails and housekeeping
  routes/                  marketing, auth, properties, disputes, billing, account, admin
  views/                   layout, charts (HTML/CSS) and pricing cards
public/                    stylesheet, small progressive-enhancement script, favicon
scripts/                   seed-demo.js, backup.js
test/                      node:test unit and end-to-end tests
```
