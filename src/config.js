'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Minimal .env loader so the app runs without extra dependencies.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

const config = {
  isProd,
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  brand: env.BRAND_NAME || 'MeterProof',
  supportEmail: env.SUPPORT_EMAIL || 'support@meterproof.co.za',
  dataDir,
  dbFile: env.DB_FILE || path.join(dataDir, 'meterproof.db'),
  uploadDir: path.join(dataDir, 'uploads'),
  outboxDir: path.join(dataDir, 'outbox'),
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Business details shown on receipts, legal pages and letters.
  business: {
    legalName: env.BUSINESS_LEGAL_NAME || 'MeterProof (sole proprietor)',
    address: env.BUSINESS_ADDRESS || 'South Africa',
    vatNumber: env.BUSINESS_VAT_NUMBER || '',
    infoOfficer: env.INFORMATION_OFFICER || 'The owner',
  },

  payfast: {
    mode: env.PAYFAST_MODE === 'live' ? 'live' : 'sandbox',
    // Public PayFast sandbox credentials are the defaults so checkout works out of the box.
    merchantId: env.PAYFAST_MERCHANT_ID || '10000100',
    merchantKey: env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
    passphrase: env.PAYFAST_PASSPHRASE === undefined ? 'jt7NOE43FZPn' : env.PAYFAST_PASSPHRASE,
    // Skip the server-to-server validation call (only for automated tests).
    skipValidation: env.PAYFAST_SKIP_VALIDATION === '1',
  },

  // Direct EFT into the owner's bank account (e.g. FNB). Shown on the EFT checkout page.
  eft: {
    enabled: env.EFT_ENABLED !== '0',
    bankName: env.EFT_BANK_NAME || 'FNB',
    accountName: env.EFT_ACCOUNT_NAME || 'MeterProof',
    accountNumber: env.EFT_ACCOUNT_NUMBER || '00000000000',
    branchCode: env.EFT_BRANCH_CODE || '250655',
    accountType: env.EFT_ACCOUNT_TYPE || 'Cheque',
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || `MeterProof <no-reply@meterproof.co.za>`,
  },

  // Dev-only "simulate payment" button. Never enabled in production.
  allowDevPayments: !isProd && env.ALLOW_DEV_PAYMENTS !== '0',
  disableScheduler: env.DISABLE_SCHEDULER === '1',
};

if (isProd && !/^https:\/\//.test(config.baseUrl)) {
  console.warn('WARNING: BASE_URL should be your public https:// address in production; PayFast sends payment notifications to it.');
}
if (isProd && config.payfast.mode === 'sandbox') {
  console.warn('WARNING: PAYFAST_MODE is "sandbox": no real payments will be taken.');
}

for (const dir of [config.dataDir, config.uploadDir, config.outboxDir]) fs.mkdirSync(dir, { recursive: true });

module.exports = config;
