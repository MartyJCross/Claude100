'use strict';

// Consistent online backup of the database plus a copy of all uploads.
// Usage: node scripts/backup.js [target-folder]   (default: DATA_DIR/backups)
// Schedule it daily (cron, Render cron job) and copy the folder off the server.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'), stamp);
fs.mkdirSync(target, { recursive: true });

const dbCopy = path.join(target, 'meterproof.db');
db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
fs.cpSync(config.uploadDir, path.join(target, 'uploads'), { recursive: true });

// Keep the 14 most recent backups in the default location.
if (!process.argv[2]) {
  const root = path.dirname(target);
  const all = fs.readdirSync(root).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
}

console.log(`Backup written to ${target}`);
