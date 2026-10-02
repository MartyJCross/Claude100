'use strict';

const express = require('express');
const config = require('../config');
const { html } = require('../lib/html');
const { render } = require('../lib/render');
const { pricingCards } = require('../views/pricing');
const { quickCheck } = require('../lib/analysis');
const { track } = require('../lib/analytics');
const { rand, toNumber, toCents, isValidDate, prettyDate, daysBetween, num, today } = require('../lib/format');

const router = express.Router();

// ---------------------------------------------------------------- Landing page
router.get('/', (req, res) => {
  render(req, res, {
    description: 'Wrong municipal bill? MeterProof checks every bill against dated photos of your own meter, prices the over-billing in Rand and prepares a Section 102 dispute that protects you from disconnection.',
    body: html`
    <section class="hero"><div class="wrap hero-grid">
      <div>
        <span class="eyebrow">For South African homeowners and landlords</span>
        <h1>Your municipal bill is wrong. Now you can prove it.</h1>
        <p class="lede">${config.brand} checks every municipal bill against dated photos of your own water and electricity meters. When the municipality bills you on inflated estimates, we work out exactly how much you were over-charged and prepare a Section 102 dispute that legally protects you from disconnection on that amount.</p>
        <div class="row" style="margin-top:22px">
          <a class="btn big" href="/signup">Check my bills free</a>
          <a class="btn big secondary" href="/tools/bill-checker">30-second bill checker</a>
        </div>
        <p class="muted" style="margin-top:12px">Free for one property. Pay R299 once-off only when you want to dispute.</p>
      </div>
      <div class="mock" aria-label="Example result">
        <p class="muted" style="margin:0 0 8px;font-size:0.8rem">Example result</p>
        <span class="eyebrow" style="color:var(--critical-text)">Over-billing found</span>
        <div class="hero-figure">R4 380.00</div>
        <p class="text-2" style="margin:6px 0 14px">likely over-billed across 3 water bills, based on 6 dated meter photos</p>
        <ul class="flags">
          <li class="flag high"><span class="ic" aria-hidden="true">!</span><div><strong>Problem</strong>The bill's closing reading (2 310) is 64 kL ahead of what your meter actually showed on 30 Jun.</div></li>
          <li class="flag high"><span class="ic" aria-hidden="true">!</span><div><strong>Problem</strong>Your last 4 water charges were all estimated.</div></li>
          <li class="flag medium"><span class="ic" aria-hidden="true">?</span><div><strong>Check</strong>Interest was charged on an account that includes over-billing.</div></li>
        </ul>
        <p style="margin:14px 0 0" class="text-2">Keep paying about <strong>R1 140</strong>/month while the dispute runs.</p>
      </div>
    </div></section>

    <section class="section alt"><div class="wrap">
      <div class="section-head"><h2>Why bills run away, and why most disputes fail</h2></div>
      <div class="grid-3">
        <div><h3>Estimates compound</h3><p class="text-2">When nobody reads your meter, the municipality estimates. Each estimate builds on the last, interest is added, and a R900 water bill becomes R9 000.</p></div>
        <div><h3>Vague complaints get ignored</h3><p class="text-2">The Supreme Court of Appeal has held that a dispute must relate to <strong>specific amounts</strong> with reasons. "My bill is too high" is not a valid dispute, so credit control carries on.</p></div>
        <div><h3>Disconnection is the threat</h3><p class="text-2">Section 102(2) of the Municipal Systems Act stops credit control on an amount that is properly in dispute. Lodged correctly, a dispute protects you while it is resolved.</p></div>
      </div>
    </div></section>

    <section class="section"><div class="wrap">
      <div class="section-head"><span class="eyebrow">How it works</span><h2>Evidence first, then a dispute that works</h2></div>
      <div class="steps">
        <div class="step"><h3>Photograph your meter</h3><p class="text-2">Once a month, on your phone. Your camera stamps each photo with the date and time, and we read that stamp as independent proof. We send you a reminder.</p></div>
        <div class="step"><h3>Add your bills</h3><p class="text-2">Copy the readings and amounts from each bill. We match the bill's reading dates to what your meter really showed on those days.</p></div>
        <div class="step"><h3>See every error in Rand</h3><p class="text-2">Estimated readings, readings ahead of your meter, impossible spikes, charges that don't add up. We also tell you honestly when the bill is right, or when you might have a leak.</p></div>
        <div class="step"><h3>Dispute properly</h3><p class="text-2">A Section 102 letter naming the specific amounts, an evidence pack with your photos and calculations, then follow-up, appeal and disconnection-response letters when you need them.</p></div>
      </div>
    </div></section>

    <section class="section alt"><div class="wrap">
      <div class="grid-2" style="align-items:center">
        <div>
          <span class="eyebrow">Start today, even without old readings</span>
          <h2>One photo can prove an estimate wrong</h2>
          <p class="text-2">Meters only move forward. If your latest bill says the meter read 2 310 on 30 June and your meter shows 2 246 today, the bill is overstated by at least 64 kL, and you can prove it with a single dated photo.</p>
          <a class="btn" href="/tools/bill-checker">Try it with your bill</a>
        </div>
        <div class="card">
          <h3>Who uses ${config.brand}</h3>
          <ul class="ticks">
            <li>Homeowners in Johannesburg, Tshwane, Ekurhuleni, Cape Town and other municipalities facing estimated bills</li>
            <li>Landlords who carry the municipal account while tenants use the water</li>
            <li>Trustees of small complexes and body corporates</li>
            <li>Adult children managing a parent's municipal account</li>
          </ul>
        </div>
      </div>
    </div></section>

    <section class="section"><div class="wrap">
      <div class="section-head"><h2>Pricing</h2><p class="text-2">Checking is free. Pay once when you need the dispute pack.</p></div>
      ${pricingCards({ user: req.user, csrf: req.csrfToken })}
    </div></section>

    <section class="section alt"><div class="wrap narrow">
      <h2>Questions</h2>
      <details class="faq"><summary>Is this legal advice?</summary><p>No. ${config.brand} is a self-help tool. It organises your evidence and drafts letters based on the Municipal Systems Act, which you review and send yourself. For large amounts or court action, consult an attorney; your evidence pack will save them time.</p></details>
      <details class="faq"><summary>Do I stop paying my bill while I dispute?</summary><p>No, and you should not. Section 102 only protects the specific amount in dispute. ${config.brand} calculates the undisputed portion (based on your actual usage) so you can keep paying that and stay in good standing.</p></details>
      <details class="faq"><summary>Will the municipality accept a letter from an app?</summary><p>The letter is from you, in your name, and is written the way a formal dispute should be: account details, specific amounts, grounds, evidence and a request for a reference number. That is what municipalities' credit control by-laws and the courts require.</p></details>
      <details class="faq"><summary>What about prepaid electricity?</summary><p>Prepaid meters are not billed in arrears, so there is nothing to dispute. ${config.brand} is for conventional (post-paid) water and electricity meters billed on your municipal account.</p></details>
      <details class="faq"><summary>What happens to my data?</summary><p>Your readings, photos and bills are private to your account, stored securely and never sold. You can download or delete everything at any time. See our <a href="/legal/privacy">Privacy Policy</a> (POPIA).</p></details>
      <p style="margin-top:24px"><a class="btn big" href="/signup">Check my bills free</a></p>
    </div></section>`,
  });
});

// ---------------------------------------------------------------- Free tool
router.get('/tools/bill-checker', (req, res) => {
  const q = req.query;
  const utility = q.utility === 'electricity' ? 'electricity' : 'water';
  const u = utility === 'water' ? 'kL' : 'kWh';
  const billed = toNumber(q.billed_reading);
  const billedDate = String(q.billed_date || '');
  const actual = toNumber(q.actual_reading);
  const actualDate = String(q.actual_date || '');
  const amount = toCents(q.amount);
  const unitsCharged = toNumber(q.units);
  const submitted = billed !== null && actual !== null;
  let result = '';
  if (submitted) {
    const rate = amount && unitsCharged && unitsCharged > 0 ? amount / unitsCharged : null;
    const r = quickCheck({ utility, billedReading: billed, actualReading: actual, ratePerUnitCents: rate });
    const conclusive = isValidDate(billedDate) && isValidDate(actualDate) && actualDate >= billedDate;
    const gap = isValidDate(billedDate) && isValidDate(actualDate) ? daysBetween(actualDate, billedDate) : null;
    track('tool_used', { req, props: { overbilled: r.overbilled, conclusive } });
    if (r.overbilled) {
      result = html`<div class="callout" style="margin-top:20px">
        <span class="eyebrow" style="color:var(--critical-text)">${conclusive ? 'Over-billing proven' : 'Likely over-billing'}</span>
        <div class="hero-figure">${num(r.ahead)} ${u}</div>
        <p class="text-2">The bill's reading is ${num(r.ahead)} ${u} ahead of your meter${r.estimatedCents ? html`, worth about <strong>${rand(r.estimatedCents)}</strong> at the rate on your bill` : ''}.
        ${conclusive
          ? html`Your reading was taken ${actualDate === billedDate ? 'on the same day as' : 'after'} the bill's reading, and meters only move forward, so the bill is overstated by at least this much.`
          : html`Your reading was taken ${gap !== null ? `${gap} days` : ''} before the bill's reading date. Take a new reading today: if your meter is still below ${num(billed)}, the over-billing is proven.`}</p>
        <p><strong>Next:</strong> a dispute must name the specific amount and be lodged in writing to protect you from disconnection. ${config.brand} prepares the letter and evidence pack for you.</p>
        <a class="btn big" href="/signup">Build my dispute, free to start</a>
      </div>`;
    } else {
      result = html`<div class="callout good" style="margin-top:20px">
        <span class="eyebrow" style="color:var(--good-text)">No overstated reading</span>
        <h2>The bill's reading is not ahead of your meter</h2>
        <p class="text-2">That rules out the most common error. Bills can still be wrong in other ways: charged units that don't match the readings, wrong tariffs, double charges or interest on disputed amounts. Track your meter monthly and we will check every bill automatically.</p>
        <a class="btn" href="/signup">Track my bills free</a>
      </div>`;
    }
  }
  render(req, res, {
    title: 'Free municipal bill checker',
    active: 'tool',
    description: 'Is your municipal water or electricity bill based on an inflated estimated reading? Compare the reading on your bill with your meter in 30 seconds.',
    body: html`<section class="wrap page narrow">
      <span class="eyebrow">Free tool</span>
      <h1>Is your municipal bill ahead of your meter?</h1>
      <p class="text-2">Estimated bills often use a reading higher than what your meter actually shows. Compare the two in 30 seconds. No signup needed.</p>
      <form method="get" action="/tools/bill-checker" class="card">
        <div class="field"><label for="utility">Meter</label><select id="utility" name="utility"><option value="water" ${utility === 'water' ? 'selected' : ''}>Water (kL)</option><option value="electricity" ${utility === 'electricity' ? 'selected' : ''}>Electricity (kWh)</option></select></div>
        <fieldset><legend>From your bill</legend><div class="form-grid">
          <div class="field"><label for="billed_reading">Current (latest) reading on the bill</label><input id="billed_reading" name="billed_reading" inputmode="decimal" required value="${q.billed_reading || ''}"></div>
          <div class="field"><label for="billed_date">Date of that reading</label><input id="billed_date" name="billed_date" type="date" value="${q.billed_date || ''}"></div>
          <div class="field"><label for="units">Units charged <span class="hint">Optional</span></label><input id="units" name="units" inputmode="decimal" value="${q.units || ''}"></div>
          <div class="field"><label for="amount">Amount charged (R) <span class="hint">Optional</span></label><input id="amount" name="amount" inputmode="decimal" value="${q.amount || ''}"></div>
        </div></fieldset>
        <fieldset><legend>From your meter</legend><div class="form-grid">
          <div class="field"><label for="actual_reading">Your meter reading</label><input id="actual_reading" name="actual_reading" inputmode="decimal" required value="${q.actual_reading || ''}"></div>
          <div class="field"><label for="actual_date">Date you read it</label><input id="actual_date" name="actual_date" type="date" max="${today()}" value="${q.actual_date || today()}"></div>
        </div></fieldset>
        <button class="btn big" type="submit">Check my bill</button>
      </form>
      ${result}
      <div class="prose" style="margin-top:28px">
        <h2>Where to find the reading on your bill</h2>
        <p>Look for the consumption section for water or electricity. It lists a previous and a current reading with dates, often marked <strong>A</strong> (actual) or <strong>E</strong> (estimated). Use the current reading and its date.</p>
        <p>Read your meter from left to right. Black or white digits are whole kilolitres (kL); red digits are fractions. Write down the black digits and the first red digit after a decimal point.</p>
      </div>
    </section>`,
  });
});

// ---------------------------------------------------------------- Guide (SEO)
router.get('/guides/dispute-municipal-bill', (req, res) => {
  render(req, res, {
    title: 'How to dispute a municipal bill in South Africa',
    active: 'guide',
    description: 'A practical guide to disputing an estimated or inflated municipal account under section 102 of the Municipal Systems Act: what to include, what to keep paying, and how to escalate.',
    body: html`<section class="wrap page"><article class="prose">
      <span class="eyebrow">Guide</span>
      <h1>How to dispute a municipal bill in South Africa</h1>
      <p class="text-2">Updated ${prettyDate(today(), { long: true })}. This guide is general information, not legal advice.</p>

      <h2>1. Know what protects you: section 102</h2>
      <p>Section 102 of the Local Government: Municipal Systems Act 32 of 2000 lets a municipality consolidate your accounts and take credit control action (like restricting water or disconnecting electricity) on arrears. But section 102(2) says this does <strong>not</strong> apply where there is a dispute between you and the municipality about a <strong>specific amount</strong>.</p>
      <p>In <a href="https://www1.saflii.org/za/cases/ZASCA/2011/188.html" rel="noopener" target="_blank">Body Corporate Croftdene Mall v eThekwini Municipality</a> the Supreme Court of Appeal confirmed that the dispute must relate to specific amounts claimed by the municipality, with facts that show why they are wrong. A general complaint that "the bill is too high", or refusing to pay everything, does not qualify.</p>

      <h2>2. Gather evidence before you write</h2>
      <ul>
        <li><strong>Dated photos of your meter.</strong> Take one today. If the bill's latest reading is higher than your meter shows now, the bill is overstated, because meters only move forward.</li>
        <li><strong>Your bills</strong>, especially the consumption section showing readings, reading dates and whether each reading was actual (A) or estimated (E).</li>
        <li><strong>A calculation</strong> of billed versus actual consumption for each period, and what that difference costs.</li>
      </ul>

      <h2>3. Lodge the dispute in writing</h2>
      <p>Follow your municipality's dispute procedure (see your bill or its credit control by-laws). Your letter should include:</p>
      <ul>
        <li>your account number, the property and the account holder;</li>
        <li>each disputed amount, the bill it appears on, and why it is wrong;</li>
        <li>a reference to section 102(2) and a request that credit control be suspended on the disputed amount;</li>
        <li>a request for an actual meter reading, a corrected account and the reversal of interest on the disputed amount;</li>
        <li>your undertaking to keep paying the undisputed portion;</li>
        <li>your evidence, attached.</li>
      </ul>
      <p>Ask for a <strong>dispute reference number</strong> and keep proof of when and how you sent the dispute.</p>

      <h2>4. Keep paying the undisputed amount</h2>
      <p>Section 102 protects only the amount in dispute. Keep paying a fair amount based on your actual usage (for example, the average of recent correct bills). This keeps you in good standing and shows good faith.</p>

      <h2>5. Follow up and escalate</h2>
      <p>If there is no response, send a written follow-up and escalate to a supervisor, your ward councillor or, in Johannesburg and Cape Town, the municipal Ombudsman. Keep a log of every call (date, name, reference).</p>

      <h2>6. If the dispute is rejected: appeal within 21 days</h2>
      <p>Section 62 of the Municipal Systems Act allows you to appeal a decision made by a municipal official by giving written notice of the appeal and your reasons to the municipal manager <strong>within 21 days</strong> of being notified of the decision.</p>

      <h2>7. If you receive a disconnection notice</h2>
      <p>Respond immediately and in writing. Point out that the amount is subject to a lodged dispute (with its reference number), that section 102(2) bars credit control on that amount, and ask for written confirmation that services will not be disconnected. If services are cut regardless, urgent legal advice may be needed.</p>

      <div class="card" style="margin-top:28px">
        <h2>Do all of this in one place</h2>
        <p class="text-2">${config.brand} keeps your dated meter photos, checks every bill, calculates the specific amounts, and drafts the dispute, follow-up, appeal and disconnection letters with an evidence pack.</p>
        <a class="btn" href="/signup">Start free</a> <a class="btn ghost" href="/tools/bill-checker">Try the free checker</a>
      </div>
    </article></section>`,
  });
});

// ---------------------------------------------------------------- Legal
router.get('/legal/terms', (req, res) => {
  const b = config.business;
  render(req, res, {
    title: 'Terms of Service',
    body: html`<section class="wrap page"><article class="prose">
      <h1>Terms of Service</h1>
      <p class="muted">Last updated ${prettyDate(today(), { long: true })}</p>
      <p>These terms apply to your use of ${config.brand} (the "Service"), operated by ${b.legalName}, ${b.address} ("we", "us"). By creating an account you agree to them. Questions: <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>.</p>
      <h2>1. What the Service is</h2>
      <p>${config.brand} is a self-help tool that stores your meter readings, photos and municipal bills, compares them, estimates possible over-billing, and drafts letters for you to review and send. <strong>It is not legal advice and we are not a law firm.</strong> Calculations are estimates based on the information you enter. You are responsible for checking the information and letters before you use them, and for deciding whether to seek professional advice.</p>
      <h2>2. Your account</h2>
      <p>You must give accurate information, keep your password safe and be at least 18 years old. You may only add properties whose municipal accounts you are entitled to manage.</p>
      <h2>3. Plans, payment and cancellation</h2>
      <ul>
        <li>Prices are in South African Rand and shown before you pay. Payments are processed by PayFast or by direct EFT; we never see your card details.</li>
        <li>Once-off plans give access for the stated period and do not renew. Monthly subscriptions renew each month until cancelled; you can cancel at any time on your Plan page and keep access until the end of the paid month.</li>
        <li><strong>Cooling-off and refunds:</strong> if you are unhappy, email us within 7 days of your first payment for a full refund. This is in addition to any rights you have under the Consumer Protection Act and the Electronic Communications and Transactions Act.</li>
        <li>We may change prices with at least 30 days' notice for subscriptions; changes never affect a period you have already paid for.</li>
      </ul>
      <h2>4. Acceptable use</h2>
      <p>Do not upload unlawful content, try to access other users' data, interfere with the Service, or use it to send false or abusive correspondence.</p>
      <h2>5. Your content</h2>
      <p>You own the readings, photos, bills and letters you create. You give us permission to store and process them only to provide the Service to you. See the <a href="/legal/privacy">Privacy Policy</a>.</p>
      <h2>6. Availability and liability</h2>
      <p>We work hard to keep the Service available and accurate, but it is provided "as is". To the extent permitted by law, we are not liable for indirect or consequential loss, or for the outcome of any dispute with a municipality, and our total liability is limited to the amount you paid us in the 12 months before the claim. Nothing in these terms limits rights you have under the Consumer Protection Act that cannot be excluded.</p>
      <h2>7. Ending your account</h2>
      <p>You can delete your account at any time. We may suspend accounts that breach these terms.</p>
      <h2>8. Law</h2>
      <p>These terms are governed by the laws of the Republic of South Africa.</p>
      <h2>9. Supplier information (ECT Act section 43)</h2>
      <p>${b.legalName} · ${b.address} · <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>${b.vatNumber ? ` · VAT ${b.vatNumber}` : ''}</p>
    </article></section>`,
  });
});

router.get('/legal/privacy', (req, res) => {
  const b = config.business;
  render(req, res, {
    title: 'Privacy Policy',
    body: html`<section class="wrap page"><article class="prose">
      <h1>Privacy Policy (POPIA)</h1>
      <p class="muted">Last updated ${prettyDate(today(), { long: true })}</p>
      <p>${b.legalName} ("we") is the responsible party for personal information processed through ${config.brand}. Our Information Officer is ${b.infoOfficer}, reachable at <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>.</p>
      <h2>What we collect and why</h2>
      <ul>
        <li><strong>Account details</strong> (name, email, optional phone and postal address): to run your account and put your name on letters you generate.</li>
        <li><strong>Property and municipal account details, meter readings, meter photos and bills:</strong> to compare bills with your meter and prepare disputes. Photos may contain camera metadata such as the time taken and, depending on your phone, location; we use the time as evidence and keep the file as you uploaded it.</li>
        <li><strong>Payment records</strong> (plan, amount, date, PayFast transaction reference): to provide your plan and meet tax record-keeping duties. Card details are handled by PayFast, never by us.</li>
        <li><strong>Usage information</strong> (pages viewed, product events, a random visitor identifier and campaign source): to understand and improve the Service. We use first-party cookies only, no advertising trackers.</li>
      </ul>
      <h2>Cookies</h2>
      <p><code>sid</code> keeps you logged in; <code>csrf</code> protects forms; <code>aid</code> is a random visitor ID for our own analytics; <code>utm</code> remembers which campaign brought you to us (90 days).</p>
      <h2>Sharing</h2>
      <p>We do not sell your information. We share it only with service providers who help us run the Service (hosting, email delivery, PayFast for payments) under confidentiality obligations, or where the law requires it. Letters and evidence packs go to a municipality only when you send them. Our hosting provider may store data outside South Africa in a country with adequate data protection laws or under binding agreements, as permitted by section 72 of POPIA.</p>
      <h2>Security and retention</h2>
      <p>Data is encrypted in transit, access is restricted, and uploads are only served to your logged-in account. We keep your data while your account is open. When you delete your account we delete your properties, readings, photos, bills and disputes immediately; payment records are kept for 5 years for tax purposes.</p>
      <h2>Your rights</h2>
      <p>You may access, correct or delete your personal information, object to processing, and withdraw consent for reminder emails at any time. Download your data or delete your account from the Account page, or email us. If you are unhappy with how we handle your information, you may complain to the Information Regulator (<a href="https://inforegulator.org.za" rel="noopener" target="_blank">inforegulator.org.za</a>).</p>
    </article></section>`,
  });
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /app\nDisallow: /admin\nDisallow: /account\nDisallow: /billing\nDisallow: /files\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const urls = ['/', '/pricing', '/tools/bill-checker', '/guides/dispute-municipal-bill', '/legal/terms', '/legal/privacy'];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${config.baseUrl}${u}</loc></url>`).join('')}</urlset>`);
});

module.exports = router;
