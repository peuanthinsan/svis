const fs = require('node:fs');
const path = require('node:path');
const { neon, closePools } = require('../host/pg-neon.cjs');
const { requireConfirmedTarget } = require('./lib/db-target');

const { url: databaseUrl, dryRun } = requireConfirmedTarget({
  action: 'apply migration 025 (vehicle-owner role and per-vehicle access)',
  dryRun: process.argv.includes('--dry-run'),
});
const statements = fs.readFileSync(path.join(__dirname, '..', 'sql', '025-vehicle-owner-access.sql'), 'utf8')
  .replace(/--[^\r\n]*/g, '')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));

if (dryRun) {
  console.log(`Dry run: migration 025 not applied (${statements.length} statements).`);
  process.exit(0);
}

(async () => {
  try {
    const sql = neon(databaseUrl);
    await sql.transaction(statements.map((statement) => sql.query(statement)));
    console.log('Migration 025 complete. Vehicle-owner accounts are available. Existing fleets are unchanged.');
  } finally {
    await closePools();
  }
})().catch((error) => {
  console.error(`Migration 025 failed (${error.code || 'UNKNOWN'}).`);
  process.exitCode = 1;
});
