# Going live

You need about one working day, mostly waiting on PayFast verification. Do the steps in order.

## 1. Business basics (day 1)

- **Trading as a sole proprietor is fine to start**: use your own name "t/a MeterProof". You can
  register a (Pty) Ltd with CIPC later. Revenue is taxed as part of your personal income
  (declare it on your ITR12 and provisional tax returns).
- **VAT**: you do not have to register until your taxable turnover passes SARS's compulsory
  VAT registration threshold (check the current figure on sars.gov.za). If you do register,
  set `BUSINESS_VAT_NUMBER` and receipts automatically become tax invoices showing VAT.
- **POPIA**: register yourself as Information Officer on the Information Regulator's eServices
  portal (inforegulator.org.za). Set `INFORMATION_OFFICER` to your name.
- **Domain**: register a `.co.za` (for example `meterproof.co.za`; check it is available).
  Pick a different `BRAND_NAME` if you prefer; the whole app follows that setting.

## 2. PayFast pays out to your FNB account (days 1 to 3)

1. Sign up at **payfast.io** as an individual or sole proprietor.
2. Complete verification (FICA): your ID, proof of address, and **proof of your FNB account**
   (a bank-stamped letter or recent statement). PayFast pays your balance out to that account.
3. In the PayFast dashboard, under **Settings → Developer settings**:
   - copy your **Merchant ID** and **Merchant Key**;
   - set a **Passphrase** (letters and digits; it must match `PAYFAST_PASSPHRASE` exactly);
   - make sure **Recurring Billing / Subscriptions** is enabled. If you cannot see it, ask
     PayFast support to enable it; the Homeowner and Landlord monthly plans need it.
4. Fees at the time of writing are 3.2% + R2 for cards and 2% (minimum R2) for Instant EFT,
   excluding VAT. Check payfast.io/fees.

**Direct EFT** (a fallback with no fees): set `EFT_ACCOUNT_NAME`, `EFT_ACCOUNT_NUMBER`,
`EFT_BRANCH_CODE` (FNB universal branch code 250655) and `EFT_ACCOUNT_TYPE`. Customers get a
unique reference (for example `MP00042`). When the money reflects in your FNB app, open
**/admin/payments** and click **Mark received** to activate their plan.

## 3. Hosting

The app is a single Node.js process with SQLite and an uploads folder on disk. It needs
**persistent storage**.

### Option A: Render (easiest, about US$7–10 a month)

1. Push this repo to GitHub (already done).
2. On render.com: **New → Blueprint** and select the repo. `render.yaml` creates the web
   service and a 5 GB disk mounted at `/data`.
3. Fill in the environment variables it asks for (see `.env.example`). Use
   `BASE_URL=https://yourdomain.co.za`.
4. Add your custom domain in Render and point a CNAME at it from your registrar. HTTPS is
   automatic.

### Option B: Docker on a VPS (South African hosting such as Afrihost, Xneelo or Hetzner SA)

```bash
docker build -t meterproof .
docker run -d --name meterproof --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v /srv/meterproof:/data --env-file .env meterproof
```

Put **Caddy** in front for automatic HTTPS (`Caddyfile`:
`meterproof.co.za { reverse_proxy 127.0.0.1:3000 }`).

### Backups (both options)

Run `npm run backup` daily (a Render cron job or host crontab). It writes a consistent copy of
the database plus uploads to `DATA_DIR/backups` and keeps 14 days. Copy that folder off the
server weekly (for example with rclone to Google Drive or S3).

## 4. Email

Use any SMTP provider (Brevo's free tier is enough to start; Postmark or Amazon SES as you
grow). Verify your domain and add the **SPF and DKIM** DNS records they give you, so reminders
do not land in spam. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`.

## 5. Test in the PayFast sandbox before taking real money

Deploy with `PAYFAST_MODE=sandbox` (the public sandbox credentials are the defaults) and run
this checklist on the live URL:

- [ ] Sign up, add a property, readings (with a phone photo) and two bills; over-billing shows.
- [ ] Buy the **Dispute Pack**: you are sent to sandbox.payfast.co.za. Pay with the sandbox
      wallet. You return to the app and the plan is active within seconds (this confirms the
      ITN reached `/billing/payfast/itn` and passed validation).
- [ ] Download the evidence pack and the receipt.
- [ ] Subscribe to **Homeowner monthly**, then **Cancel subscription** on the Plan page; the
      status changes to cancelled. This confirms the subscriptions API signature.
- [ ] Order an EFT plan and mark it received in **/admin/payments**.
- [ ] `/admin` shows the payments, MRR and funnel.

If a payment stays "confirming", check the server log for `payfast ITN rejected: …`; the
reason is logged (bad signature usually means the passphrase does not match).

## 6. Switch to live

Set `PAYFAST_MODE=live` and your real `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY` and
`PAYFAST_PASSPHRASE`. Optionally set `PAYFAST_CHECK_IP=1` to accept notifications only from
PayFast's servers. Do one real R299 purchase with your own card, check that it arrives in
PayFast and pays out to FNB, then refund yourself from the PayFast dashboard.

## 7. Launch checklist

- [ ] `BUSINESS_LEGAL_NAME`, `BUSINESS_ADDRESS`, `SUPPORT_EMAIL` and `INFORMATION_OFFICER` set
      (they appear in the Terms, Privacy Policy, receipts and the ECT Act notice).
- [ ] Read the Terms and Privacy pages once and adjust anything you want; consider a one-off
      review by an attorney.
- [ ] `ADMIN_EMAILS` contains your email; you can open `/admin`.
- [ ] Submit `https://yourdomain/sitemap.xml` in Google Search Console.
- [ ] Daily backup scheduled and a restore tested once (copy a backup's `meterproof.db` into a
      fresh `DATA_DIR` and start the app).
