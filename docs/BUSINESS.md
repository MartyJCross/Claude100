# MeterProof: business plan

## The problem

Municipal billing in South Africa is broken for a large minority of households. When meters
are not read, which is common in Johannesburg, Tshwane and Ekurhuleni, municipalities bill on
**estimates**. Estimates compound month after month, interest is charged on top, and an
ordinary household can face a five-figure bill and a disconnection notice. The Johannesburg
problem is well documented (OUTA and Schindlers Attorneys, Daily Maverick, Feb 2024).

The law already protects these people. **Section 102(2) of the Municipal Systems Act** bars
credit control on an amount that is in dispute, and **section 62** gives a 21-day appeal. But
the protection only applies to a dispute about **specific amounts** with reasons (*Croftdene
Mall v eThekwini*, SCA 2011). Most people write "my bill is too high", have no evidence, stop
paying altogether, and lose.

What they are missing is evidence and a properly drafted dispute. Attorneys and billing
consultants charge thousands of rand or a percentage of the amount recovered.

## The product

MeterProof is a phone-first web app that:

1. collects **dated meter photos** (the camera timestamp is read as proof) with monthly reminders;
2. checks every bill against the real meter and **prices the over-billing in Rand**;
3. generates the **Section 102 dispute letter and evidence pack**, works out the undisputed
   amount to keep paying, and tracks the dispute with follow-up, appeal and
   disconnection-response letters.

It is honest: it shows when a bill is correct and warns about possible leaks, which builds
trust and word of mouth.

## Why it sells easily

- **Acute, expensive pain.** People search for a solution the day the bill arrives. The free
  checker gives a proven Rand figure in 30 seconds, and the dispute pack costs about 5–15% of a
  typical over-billing.
- **Value before payment.** The analysis is free; the paywall sits exactly where the user has
  just seen "R4 380 over-billed" and wants the letter.
- **No competition at this price.** The alternatives are attorneys, billing consultants that
  charge a share of the recovery, or a frustrating call centre. We found no app built around
  Section 102 disputes.
- **Viral by nature.** Neighbours share meter readers and billing problems. Community WhatsApp
  and Facebook groups discuss billing every week.

## Customers

| Segment | Why they pay | Plan |
|---|---|---|
| Homeowners with a bad bill (primary) | Urgent, high-value fix | Dispute Pack R299 |
| Homeowners burned before | Peace of mind, monthly checks | Homeowner R59/month |
| Small landlords | They carry the municipal account; tenants use the water | Landlord R249/month |
| Trustees of small complexes, people managing a parent's account | Responsibility for someone else's money | Homeowner or Landlord |

## Pricing and unit economics

| Plan | Price | PayFast card fee (3.2% + R2, plus VAT) | Net to you |
|---|---|---|---|
| Dispute Pack (6 months) | R299 once-off | about R13 | about R286 |
| Homeowner | R59/month | about R4.50 | about R54.50 |
| Homeowner, 12 months | R590 | about R24 | about R566 |
| Landlord | R249/month | about R11.50 | about R237.50 |

Direct EFT payments carry no gateway fee.

**Fixed costs**: hosting about R180/month (Render starter plus disk), email free to R300,
domain about R100/year. **Gross margin is above 90%.** About four Dispute Packs a month
cover running costs.

**Illustrative targets**

| Month | Dispute Packs | Subscribers | Monthly revenue |
|---|---|---|---|
| 3 | 40 | 25 | R14 085 |
| 6 | 100 | 120 | R40 100 |
| 12 | 200 | 400 | R93 800 |

These assume a mix of Homeowner and Landlord subscribers averaging about R85.

## Go-to-market

### Channels, in order of expected return

1. **Community groups (free, fast).** Suburb Facebook groups, ratepayers' association
   WhatsApp groups and neighbourhood-watch groups in Joburg, Tshwane and Ekurhuleni. Post
   the free checker, not a sales pitch (script below).
2. **Google Search ads on high-intent searches**, for example: "dispute municipal bill",
   "City of Joburg estimated water bill", "section 102 dispute", "water bill too high
   Johannesburg". Send them to `/tools/bill-checker?utm_source=google&utm_campaign=...`. Start
   at R100–R200 a day and keep the keywords that produce Dispute Packs (see `/admin`
   acquisition sources).
3. **SEO.** The guide at `/guides/dispute-municipal-bill` and the free checker target the
   same searches organically. Add one guide per metro over time.
4. **Ratepayers' associations and residents' committees.** Offer a free talk or WhatsApp voice
   note on "how to dispute your bill properly". These groups are trusted and organised.
5. **Landlords and agents.** Rental agents, property managers and landlord Facebook groups for
   the Landlord plan.
6. **Local press and radio.** Billing-crisis stories run constantly. Once you have outcomes
   ("MeterProof users have disputed R1.2m and won back R640k"), the admin dashboard's customer
   outcomes panel is your press release.

Tag every link with `utm_source`/`utm_campaign`. The admin dashboard shows sign-ups and paid
conversions per source, so you can see which channel works.

### Post script for community groups

> Got an estimated water bill that makes no sense? Quick check: compare the "current reading"
> on your bill with what your meter shows today. Meters can't go backwards, so if the bill's
> number is higher, you're being over-billed and you can prove it.
> I built a free tool that does the maths in 30 seconds: **[link]**
> If it shows over-billing, it also explains how to dispute it under section 102 of the
> Municipal Systems Act so they can't cut you off for the disputed amount.

### Reply when someone asks "does it work?"

> It doesn't argue with the council for you. It makes sure your dispute is the kind they
> legally have to deal with: specific amounts, dated photos of your meter and the
> calculation, plus the follow-up and appeal letters if they ignore you. Checking is free;
> the letter pack is R299 once-off.

## First 30 days

| Week | Do |
|---|---|
| 1 | Go live (docs/GO-LIVE.md). Run your own property through it. Ask 5 friends with bad bills to try it free and give feedback. |
| 2 | Post in 10 suburb groups (one post per group). Start a R100/day Google Ads test. |
| 3 | Contact 5 ratepayers' associations. Turn the best questions into FAQ and guide content. |
| 4 | Review the funnel in `/admin`: visitors → checker → sign-up → bill added → dispute → paid. Fix the biggest drop first. |

## The numbers to watch (all in /admin)

- **Checker → sign-up rate** tells you whether the free tool converts.
- **Sign-up → "added a bill"** is activation. If it is low, simplify the bill form or offer help.
- **Built a dispute → paid** tells you whether the price and paywall work.
- **Credits won** is your marketing proof and the reason people renew.
- **MRR and churn** show the health of the subscription side.

## Roadmap ideas, once there is demand

- Bill photo or PDF upload with automatic reading extraction (OCR), so the bill form disappears.
- General valuation roll objections (rates disputes): seasonal and high value.
- A body corporate plan with bulk meters and per-unit allocation.
- A WhatsApp reading-reminder bot.
- Referral credits and partner codes for ratepayers' associations.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Seen as legal advice | Clear self-help positioning and disclaimers; letters are the user's own; a "see an attorney" path for large amounts |
| Municipality ignores letters | Built-in follow-up, Ombud, s62 appeal and disconnection-response letters plus the dispute timeline |
| Bills are actually right | The honest "all clear" and leak warnings build trust; the user pays nothing to find out |
| Billing problems get fixed | They rarely do overnight; the same tool covers rates and other charges, and other metros |
