// Regression test for scripts/lib/db-target.js — the safety guard that stands
// between every write script in scripts/ and a real database.
//
// Why this test exists: the guard's job is to refuse a write before `neon()`
// is ever constructed, unless the operator explicitly typed --confirm. The
// only way to prove "refuses before connecting" is to actually run each
// script and watch it either exit without touching the network, or (for the
// three scripts whose dry-run legitimately needs to read current state) show
// that the network attempt failed against a fake target rather than any real
// production database.
//
// Everything here is spawned as a child process against a FAKE, decommissioned
// Neon host. We never read the ambient DATABASE_URL and we never pass
// --confirm — see buildChildEnv() and the per-script test bodies below.
//
// COVERAGE LIMIT — read this before trusting a green run as "fully proven":
// this suite is COMPLETE for realistic regressions against the Class A
// scripts as they exist TODAY (the scripts listed in CLASS_A_SCRIPTS below,
// which return before ever calling neon() during --dry-run). Every
// current Class A script either rethrows or exits nonzero on a failed
// write — including migrate-013/014's `safe()` wrapper, which rethrows
// anything that is not an "already exists" error — so deleting the
// `if (dryRun) { ... return; }` guard from any of them today produces a
// failed write that prints and exits nonzero, and dialedTheTarget() catches
// it. That is proven concretely by the leaky-caller.js self-test below.
//
// Detection is TEXT-based, though: dialedTheTarget() only inspects child
// stdout+stderr for known failure signatures (see its doc comment). A
// FUTURE Class A caller that ignores `dryRun` AND wraps its write in a
// catch block that prints nothing on failure would produce no text
// signature at all — dry-run output would still say "DRY RUN", the process
// would still exit 0, and this suite would not notice the target was
// dialed. leaky-caller.js only proves detection of a swallower that prints
// `err.message`; a silent swallower is a real, named gap in this net, not
// a theoretical one — new Class A code must not introduce one.
//
// This suite is only a PARTIAL net for Class B (seed-db.js,
// seed-users-postgres.js, wipe-history.js), whose dry-run legitimately
// connects to read current state before printing a preview. Against the
// fake host used here, the first SELECT in each of those scripts fails
// before any write statement would ever be reached — so if someone deleted
// the `if (dryRun) { ... return; }` guard from inside seed-db.js's write
// path, assertion 3 would still pass identically: dialedTheTarget() would
// still be true (the read already made it true), and nothing distinguishes
// "read, then correctly stopped" from "read, then would have gone on to
// write". The `doesNotMatch(/wipe complete/)` check on wipe-history.js is
// corroboration only, not proof — that script dies on its first failed
// SELECT regardless of whether the write guard below it is intact.
//
// Closing that gap for real would need a mock Postgres endpoint that serves
// reads and records whether a write statement was ever sent — out of scope
// for this task. Naming it here so a future reader does not mistake a green
// run for "Class B dry-run writes are provably impossible"; for Class B,
// prevention still rests on caller discipline and code review, the same way
// it did before this guard existed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const {
  requireConfirmedTarget,
  resolveDatabaseUrl,
} = require('../scripts/lib/db-target.js');

// A syntactically valid Neon connection string pointing at a project that was
// never real. Any script that reaches this host and tries to query it will
// fail — nothing it names can ever be written to.
const FAKE_DATABASE_URL =
  'postgresql://neondb_owner:fakepw@ep-dead-canary-12345678.us-east-1.aws.neon.tech/deaddb?sslmode=require';

// wipe-history.js also checks this before it does anything else. A dummy
// value lets it fail on the (fake) database, not on a missing token.
const DUMMY_BLOB_TOKEN = 'dummy-blob-token-not-real';

/**
 * Build the exact environment a spawned script sees. We start from the
 * parent's env (so PATH, HOME, etc. still work) but explicitly delete
 * DATABASE_URL first and then set it back to the fake value, so a real
 * .env.local or an ambient DATABASE_URL exported in the developer's shell
 * can never leak into a test run. dotenv only fills in *missing* variables
 * (verified separately below), so this explicit value always wins even
 * though db-target.js still calls dotenv.config() internally.
 *
 * We also delete LEAK_CANARY_SELF_TEST unconditionally. That variable is
 * leaky-caller.js's safety latch (see its header) — the suite must not
 * depend on whatever the developer happens to have exported in their own
 * shell. Without this, a developer with LEAK_CANARY_SELF_TEST=1 already set
 * ambiently would silently disarm the latch for every spawned child, not
 * just the one self-test that is supposed to open it. Only that one test
 * passes it back explicitly, via envOverrides.
 *
 * We also delete SVIS_COMPANY_SLUG and SVIS_USERS_FILE for the same reason:
 * this suite must not depend on the developer's ambient environment, and
 * each of these two can change a Class B script's outcome before it ever
 * reaches the network. scripts/lib/company-target.js's selectCompanySlug()
 * throws "SVIS_COMPANY_SLUG is set but empty" the moment the variable is set
 * but blank or whitespace-only (its own doc comment names
 * `export SVIS_COMPANY_SLUG=$TENANT` with TENANT unset as the exact real-world
 * cause) — and it throws that BEFORE the dry-run branch, so seed-db.js and
 * seed-users-postgres.js never reach their first SELECT and assertion 3
 * (dialedTheTarget === true) fails on an ambient shell export, not a code
 * regression. SVIS_USERS_FILE is read at the top of seed-users-postgres.js,
 * unconditionally and before requireConfirmedTarget() is ever called; an
 * ambient value pointing at a missing or malformed file makes that script
 * throw before it prints "DATABASE TARGET" at all, breaking every assertion
 * group that touches it (1, 3, and 4 for its Class B group). We checked the
 * other env vars the guard-calling scripts read (SVIS_SEED_PASSWORD,
 * SVIS_ADMIN_PASSWORD, SVIS_DEACTIVATION_ALLOWLIST) and none of them can
 * change an assertion's outcome here: SVIS_SEED_PASSWORD and
 * SVIS_DEACTIVATION_ALLOWLIST are only read on paths this suite never
 * exercises (past the `if (dryRun) return` short-circuit, or in printed
 * counts no assertion checks), and SVIS_ADMIN_PASSWORD is always supplied
 * explicitly via SCRIPT_INPUT_OVERRIDES for reset-admin-password.js's one
 * test occurrence, so an ambient value is always overridden below anyway —
 * we did not scrub those. Deletion happens here, before overrides are
 * spread back in below, so an explicit envOverrides value (e.g. the
 * SVIS_ADMIN_PASSWORD SCRIPT_INPUT_OVERRIDES supplies) still wins.
 */
function buildChildEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.LEAK_CANARY_SELF_TEST;
  delete env.SVIS_COMPANY_SLUG;
  delete env.SVIS_USERS_FILE;
  return {
    ...env,
    DATABASE_URL: FAKE_DATABASE_URL,
    BLOB_READ_WRITE_TOKEN: DUMMY_BLOB_TOKEN,
    ...overrides,
  };
}

/** Run any repo-relative .js file as a child process and capture everything. */
function runFile(relativePath, args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [relativePath, ...args], {
    cwd: REPO_ROOT,
    env: buildChildEnv(envOverrides),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

/** Run one of the scripts/*.js files as a child process and capture everything. */
function runScript(scriptName, args, envOverrides = {}) {
  return runFile(path.join('scripts', scriptName), args, envOverrides);
}

/**
 * Proof that neon() actually dialed the fake target — used BOTH directions:
 * asserted `false` wherever nothing should ever call neon() (assertions 1, 2,
 * 4 below — the guard must refuse, or the script must return, before any
 * network attempt), and asserted `true` wherever a live read is genuinely
 * expected (assertion 3, plus the self-test at the bottom of this file).
 *
 * This MUST stay a superset of every failure shape neon() can produce
 * against a fake host — never a list narrowed to make one particular
 * assertion pass. A signature missing from this list does not fail loudly:
 * it silently turns into a PASS for assertions 1/2/4, which is exactly the
 * shape of the defect this whole task exists to eliminate — a caller that
 * ignores `dryRun`, dials the real target, and only gets caught if the
 * fake host happens to fail in a way this list already recognizes. (Proven
 * concretely by tests/fixtures/leaky-caller.js below: it dials the target
 * and swallows the failure, and this detector is what has to catch that.)
 *
 * Two failure shapes are known so far:
 *   - A plain network failure (no route to host, nothing listening,
 *     DNS never resolves): ENOTFOUND, ECONNREFUSED, EAI_AGAIN,
 *     "fetch failed", getaddrinfo.
 *   - A real Postgres wire-protocol round trip against Neon's shared proxy.
 *     Verified with `nslookup`: `*.us-east-1.aws.neon.tech` is a wildcard
 *     CNAME to Neon's regional proxy. Neon routes to the actual project by
 *     TLS SNI, not DNS, so a decommissioned/never-existed endpoint id still
 *     completes a real TLS handshake in any environment with normal internet
 *     egress (this sandbox, and any default GitHub Actions runner) — it only
 *     fails afterwards, at the wire protocol, as `NeonDbError: password
 *     authentication failed for user 'neondb_owner'`. That is real evidence
 *     the target was dialed, just not a "connection" error in the DNS/TCP
 *     sense, so it belongs in this list too.
 */
const DIALED_TARGET_PATTERNS = [
  /ENOTFOUND/,
  /fetch failed/,
  /getaddrinfo/,
  /ECONNREFUSED/,
  /EAI_AGAIN/,
  /password authentication failed/i,
];

function dialedTheTarget(text) {
  return DIALED_TARGET_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Script classification (mirrors the task spec's Class A / no-dry-run /
// Class B split).
// ---------------------------------------------------------------------------

// Class A: dry-run reads nothing, returns before ever calling neon().
const CLASS_A_SCRIPTS = [
  'migrate-004.js',
  'migrate-005.js',
  'migrate-007.js',
  'migrate-008.js',
  'migrate-013.js',
  'migrate-014.js',
  'migrate-016.js',
  'migrate-017.js',
  'migrate-018.js',
  'migrate-019.js',
  'migrate-023.js',
  'migrate-025.js',
  'run-sql.js',
];

// No dry-run mode at all — the guard always demands --confirm.
const NO_DRY_RUN_SCRIPTS = ['migrate-020.js', 'migrate-021.js', 'reset-admin-password.js', 'reset-all-passwords.js'];

// Class B: dry-run legitimately connects to read current state before it can
// print a preview.
const CLASS_B_SCRIPTS = ['seed-db.js', 'seed-users-postgres.js', 'wipe-history.js', 'import-inspection-logs.js'];

const ALL_SCRIPTS = [...CLASS_A_SCRIPTS, ...NO_DRY_RUN_SCRIPTS, ...CLASS_B_SCRIPTS];

/**
 * Find every script under scripts/, recursively (including scripts/lib/ and
 * any future subdirectory), whose source actually calls
 * requireConfirmedTarget. This is the ground truth the three classification
 * lists above are checked against. scripts/lib/db-target.js is excluded by
 * path — it DEFINES requireConfirmedTarget, it does not call it — and
 * scripts/check-013.js is excluded naturally: it calls resolveDatabaseUrl()/
 * announceTarget() directly, never requireConfirmedTarget().
 *
 * Why this exists: a hardcoded array compared to a hardcoded number (the old
 * `assert.equal(ALL_SCRIPTS.length, 17, ...)`) can never fail — both sides
 * live in this file and neither reflects the filesystem. A new script added
 * to scripts/ that calls the guard would silently get zero test coverage.
 * Proven concretely, back when that old check still existed: adding a
 * throwaway guard-calling probe script to scripts/ left `npm test` fully
 * green at whatever the suite's pass count was AT THAT TIME — a stale
 * snapshot, not this suite's current count — because the old check never
 * looked at disk. This function is what makes the matrix self-checking
 * instead of self-referential; the on-disk-vs-recursive fix is re-verified
 * below with the same kind of throwaway probe, this time placed in a
 * subdirectory too.
 */
// scripts/lib/db-target.js DEFINES requireConfirmedTarget; its own source
// text contains the identifier (the `function requireConfirmedTarget(...)`
// declaration itself), so it must be excluded by path or it would
// misclassify itself as a caller.
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const DB_TARGET_DEFINITION_RELPATH = 'lib/db-target.js';

function guardCallingScriptsOnDisk() {
  return readdirSync(SCRIPTS_DIR, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => {
      // Directory-relative path, normalized to forward slashes regardless of
      // OS, so subdirectory scripts (e.g. scripts/lib/probe-tmp.js) get a
      // stable, comparable identifier instead of colliding with a top-level
      // file of the same name.
      const relDir = path.relative(SCRIPTS_DIR, entry.parentPath);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      return relPath.split(path.sep).join('/');
    })
    .filter((relPath) => relPath !== DB_TARGET_DEFINITION_RELPATH)
    .filter((relPath) => readFileSync(path.join(SCRIPTS_DIR, relPath), 'utf8').includes('requireConfirmedTarget'))
    .sort();
}

test('the classification matrix (CLASS_A/NO_DRY_RUN/CLASS_B) exactly matches every guard-calling script on disk', () => {
  const onDisk = guardCallingScriptsOnDisk();
  const inMatrix = [...ALL_SCRIPTS].sort();

  const onDiskButUnclassified = onDisk.filter((name) => !inMatrix.includes(name));
  const classifiedButMissingFromDisk = inMatrix.filter((name) => !onDisk.includes(name));

  assert.deepEqual(
    onDiskButUnclassified,
    [],
    `scripts/ has guard-calling script(s) not in any of CLASS_A_SCRIPTS / NO_DRY_RUN_SCRIPTS / ` +
    `CLASS_B_SCRIPTS: ${JSON.stringify(onDiskButUnclassified)}. Classify each one into whichever ` +
    `list matches its dry-run behavior (does it call neon() during --dry-run, or not?) so it gets ` +
    `test coverage instead of silently having none.`,
  );
  assert.deepEqual(
    classifiedButMissingFromDisk,
    [],
    `the matrix lists script(s) that no longer exist in scripts/: ${JSON.stringify(classifiedButMissingFromDisk)}. ` +
    `Remove them from CLASS_A_SCRIPTS / NO_DRY_RUN_SCRIPTS / CLASS_B_SCRIPTS.`,
  );
  // Derived, not literal: this is a consequence of the two checks above
  // holding, not an independent hardcoded expectation.
  assert.equal(inMatrix.length, onDisk.length);
});

// Two scripts (reset-admin-password.js, reset-all-passwords.js) check for a
// required input *before* calling the guard at all. Supply dummy values so
// the guard is actually reached — otherwise this test would only prove that
// an unrelated earlier check works, not that the guard does.
const SCRIPT_INPUT_OVERRIDES = {
  'import-inspection-logs.js': {
    args: ['tests/fixtures/empty-inspection-export.csv'],
    env: { SVIS_COMPANY_SLUG: 'dhl' },
  },
  'reset-admin-password.js': {
    args: [],
    env: { SVIS_ADMIN_PASSWORD: 'dummy-fake-admin-password-for-test' },
  },
  'reset-all-passwords.js': {
    args: ['dummy-fake-new-password-for-test'],
    env: {},
  },
};

function scriptInputs(scriptName) {
  return SCRIPT_INPUT_OVERRIDES[scriptName] || { args: [], env: {} };
}

/**
 * DEVIATION FROM THE SPEC, DOCUMENTED HERE AND IN THE FINAL REPORT:
 *
 * The spec says assertion (1) ("no flags") applies to "ALL 17 scripts" and
 * should show the guard's refusal path (stderr contains "Refusing to").
 * wipe-history.js does not fit that: its own --yes flag *is* what maps to
 * the guard's `dryRun` argument (`dryRun: !CONFIRMED`). Running it with zero
 * flags means CONFIRMED is false, so the guard takes the DRY RUN branch
 * (documented in Task 3 as correct and deliberate), not the refusal branch —
 * there is no "Refusing to" text and no early exit. The guard's actual
 * refusal path for wipe-history.js requires --yes without --confirm (dryRun:
 * false with no --confirm in argv). We use that invocation for wipe-history.js
 * so the assertion tests the thing it's meant to test — the guard's refusal —
 * rather than accidentally re-running wipe-history's Class B dry-run case
 * under a different assertion.
 */
function noFlagsInvocation(scriptName) {
  if (scriptName === 'wipe-history.js') return ['--yes'];
  return [];
}

/** True if seed-db.js's data-*.json imports are present; false means it crashes at module load, before the guard. */
function seedDbDataFilesPresent() {
  return existsSync(path.join(REPO_ROOT, 'scripts', 'data-vehicles.json')) &&
    existsSync(path.join(REPO_ROOT, 'scripts', 'data-emails.json'));
}

/** True if seed-users-postgres.js's default data file is present. */
function seedUsersDataFilePresent() {
  return existsSync(path.join(REPO_ROOT, 'scripts', 'data-users.json'));
}

/** Returns a skip reason string if a script's required (gitignored) data file is missing, else null. */
function missingDataFileReason(scriptName) {
  if (scriptName === 'seed-db.js' && !seedDbDataFilesPresent()) {
    return 'scripts/data-vehicles.json (and/or scripts/data-emails.json) is gitignored and absent in this environment';
  }
  if (scriptName === 'seed-users-postgres.js' && !seedUsersDataFilePresent()) {
    return 'scripts/data-users.json is gitignored and absent in this environment';
  }
  return null;
}

// ---------------------------------------------------------------------------
// (1) No flags: every script must refuse before connecting.
// ---------------------------------------------------------------------------

for (const scriptName of ALL_SCRIPTS) {
  test(`${scriptName} --no flags-- refuses before connecting`, (t) => {
    const skipReason = missingDataFileReason(scriptName);
    if (skipReason) {
      t.skip(skipReason);
      return;
    }

    const { args: inputArgs, env } = scriptInputs(scriptName);
    const args = [...inputArgs, ...noFlagsInvocation(scriptName)];
    const result = runScript(scriptName, args, env);

    assert.notEqual(result.status, 0, `expected nonzero exit; got ${result.status}\n${result.combined}`);
    assert.match(result.stdout, /DATABASE TARGET/);
    assert.match(result.stdout, /us-east-1/);
    assert.match(result.stderr, /Refusing to/);
    // Primary proof, not the exit code: the guard must refuse BEFORE neon()
    // is ever constructed. A caller that swallowed a write failure could
    // still exit nonzero for an unrelated reason, so the exit-code check
    // above is corroborating, not load-bearing — this is.
    assert.equal(dialedTheTarget(result.combined), false, `expected no evidence the target was dialed; guard should refuse first:\n${result.combined}`);
  });
}

// ---------------------------------------------------------------------------
// (2) --dry-run, Class A: must not connect, must exit 0, must say DRY RUN.
// ---------------------------------------------------------------------------

for (const scriptName of CLASS_A_SCRIPTS) {
  test(`${scriptName} --dry-run stays read-only and exits 0`, () => {
    const { args: inputArgs, env } = scriptInputs(scriptName);
    const result = runScript(scriptName, [...inputArgs, '--dry-run'], env);

    assert.match(result.stdout, /DRY RUN/);
    // Primary proof, not the exit code (see the exit-0 check below): a
    // caller that ignores `dryRun` and swallows its write failure — the
    // exact defect this task exists to eliminate — still exits 0 and still
    // prints "DRY RUN". Only the detector actually catches it.
    assert.equal(dialedTheTarget(result.combined), false, `dry run must never touch the network:\n${result.combined}`);
    assert.equal(result.status, 0, `expected exit 0; got ${result.status}\n${result.combined}`);
  });
}

// ---------------------------------------------------------------------------
// (3) --dry-run, Class B: these need a live read to build their preview, so
// they DO reach the network. That is correct, not a regression — a preview
// of "what would change" requires reading what currently exists. Proof here
// is the opposite of (2): we expect dialedTheTarget() to be true (see its
// doc comment for why the failure shape differs from a raw ENOTFOUND in a
// networked environment).
// ---------------------------------------------------------------------------

for (const scriptName of CLASS_B_SCRIPTS) {
  test(`${scriptName} --dry-run reaches the network for its preview (expected)`, (t) => {
    const skipReason = missingDataFileReason(scriptName);
    if (skipReason) {
      t.skip(skipReason);
      return;
    }

    // wipe-history.js's dry-run is "no --yes"; the other two use --dry-run.
    const { args: inputArgs, env } = scriptInputs(scriptName);
    const args = scriptName === 'wipe-history.js' ? inputArgs : [...inputArgs, '--dry-run'];
    const result = runScript(scriptName, args, env);

    assert.match(result.stdout, /DATABASE TARGET/);
    assert.match(result.stdout, /DRY RUN/);
    assert.equal(
      dialedTheTarget(result.combined),
      true,
      `expected the preview's live read against the fake host to fail:\n${result.combined}`,
    );

    if (scriptName === 'wipe-history.js') {
      assert.doesNotMatch(result.stdout, /wipe complete/);
    }
  });
}

// ---------------------------------------------------------------------------
// (4) --dry-run --confirm together, Class A: dry-run must still win.
// ---------------------------------------------------------------------------

for (const scriptName of CLASS_A_SCRIPTS) {
  test(`${scriptName} --dry-run --confirm: dry-run wins over confirm`, () => {
    const { args: inputArgs, env } = scriptInputs(scriptName);
    const result = runScript(scriptName, [...inputArgs, '--dry-run', '--confirm'], env);

    assert.match(result.stdout, /DRY RUN/);
    assert.doesNotMatch(result.stdout, /Mode: WRITE/);
    // Primary proof, not the exit code: --confirm must not override
    // --dry-run even when both are present, so the target must never be
    // dialed here either.
    assert.equal(dialedTheTarget(result.combined), false, `expected no evidence the target was dialed when --dry-run and --confirm are both present:\n${result.combined}`);
    assert.equal(result.status, 0, `expected exit 0; got ${result.status}\n${result.combined}`);
  });
}

// ---------------------------------------------------------------------------
// (5) DATABASE_URL unset: the error must point at .env.local and vercel env pull.
// ---------------------------------------------------------------------------

test('resolveDatabaseUrl() names .env.local and the vercel env pull remedy when DATABASE_URL is unset', () => {
  const hadUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const previousUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(
      () => resolveDatabaseUrl(),
      (error) => {
        assert.match(error.message, /\.env\.local/);
        assert.match(error.message, /vercel env pull/);
        return true;
      },
    );
  } finally {
    if (hadUrl) {
      process.env.DATABASE_URL = previousUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

// ---------------------------------------------------------------------------
// (6) Contract unit assertions on the frozen { url, dryRun } return shape.
// ---------------------------------------------------------------------------

test('requireConfirmedTarget() returns a frozen { url, dryRun: true } object on dry-run', () => {
  const hadUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = FAKE_DATABASE_URL;
  try {
    const result = requireConfirmedTarget({ action: 'unit-test dry run', dryRun: true, argv: [] });
    assert.equal(typeof result, 'object');
    assert.notEqual(result, null);
    assert.equal(result.url, FAKE_DATABASE_URL);
    assert.equal(result.dryRun, true);
    assert.equal(Object.isFrozen(result), true);
  } finally {
    if (hadUrl) {
      process.env.DATABASE_URL = previousUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test('requireConfirmedTarget() returns dryRun: false when --confirm is in argv', () => {
  const hadUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = FAKE_DATABASE_URL;
  try {
    const result = requireConfirmedTarget({
      action: 'unit-test confirmed write',
      dryRun: false,
      argv: ['--confirm'],
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.url, FAKE_DATABASE_URL);
    assert.equal(Object.isFrozen(result), true);
  } finally {
    if (hadUrl) {
      process.env.DATABASE_URL = previousUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

// ---------------------------------------------------------------------------
// (7) Anti-regression: the return value is an object, never a bare string.
// A future refactor back to the old string contract must fail this test.
// ---------------------------------------------------------------------------

test('requireConfirmedTarget() never returns a bare string (old contract)', () => {
  const hadUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = FAKE_DATABASE_URL;
  try {
    const result = requireConfirmedTarget({ action: 'unit-test anti-regression', dryRun: true, argv: [] });
    assert.notEqual(typeof result, 'string');
  } finally {
    if (hadUrl) {
      process.env.DATABASE_URL = previousUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

// ---------------------------------------------------------------------------
// Self-test: prove dialedTheTarget() can actually fail a bad caller, rather
// than assuming it. tests/fixtures/leaky-caller.js is a deliberately broken
// script that destructures `{ url }`, ignores `dryRun`, calls neon()
// unconditionally, and swallows the write failure — the exact defect this
// whole task exists to eliminate. If dialedTheTarget() ever regressed to a
// narrower list that missed this, every assertion above that asserts
// `false` (1, 2, 4) would start silently passing on a real leak. This test
// is what stops that regression from coming back unnoticed.
//
// LEAK_CANARY_SELF_TEST=1 is the fixture's own safety latch (see its header
// comment): without it, the fixture refuses to run at all, because merely
// requiring scripts/lib/db-target loads .env.local and would otherwise dial
// whatever DATABASE_URL is really configured. This is the one and only
// place in the whole suite allowed to set that variable.
// ---------------------------------------------------------------------------

test('dialedTheTarget() catches a caller that ignores dryRun and swallows its write failure (self-test)', () => {
  const result = runFile(path.join('tests', 'fixtures', 'leaky-caller.js'), ['--dry-run'], {
    LEAK_CANARY_SELF_TEST: '1',
  });

  // The leak really happened exactly as the planted proof described: exit 0,
  // claiming no writes were performed.
  assert.equal(result.status, 0, `expected the leaky fixture to exit 0 (that is the bug being proven):\n${result.combined}`);
  assert.match(result.combined, /Dry run complete; no writes performed/);

  // ...but the detector must see through that false claim.
  assert.equal(
    dialedTheTarget(result.combined),
    true,
    `expected dialedTheTarget() to catch the leaky caller dialing the target, but it did not:\n${result.combined}`,
  );
});

// ---------------------------------------------------------------------------
// Self-test: prove the fixture's own safety latch works, i.e. that
// tests/fixtures/leaky-caller.js is NOT runnable by hand. Without
// LEAK_CANARY_SELF_TEST=1, it must refuse before requiring db-target.js at
// all — no target announced, no network attempt, nonzero exit. This is what
// stops the fixture itself from becoming the second production write vector
// this task had to fix.
// ---------------------------------------------------------------------------

test('leaky-caller.js fixture refuses to run without LEAK_CANARY_SELF_TEST=1 (latch self-test)', () => {
  const result = runFile(path.join('tests', 'fixtures', 'leaky-caller.js'), ['--dry-run']);

  assert.notEqual(result.status, 0, `expected the fixture to refuse without the latch; got exit ${result.status}\n${result.combined}`);
  assert.doesNotMatch(result.combined, /DATABASE TARGET/);
  assert.equal(dialedTheTarget(result.combined), false, `fixture must not dial anything without the latch:\n${result.combined}`);
});

// ---------------------------------------------------------------------------
// Sanity check on the assumption the whole test file depends on: dotenv must
// never override an already-set environment variable. If this ever changes,
// every test above would silently start reading a real .env.local instead.
// ---------------------------------------------------------------------------

test('dotenv does not override an already-set DATABASE_URL (safety assumption for this whole file)', () => {
  const hadUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = FAKE_DATABASE_URL;
  try {
    // Re-require dotenv fresh and point it at this repo's real .env.local
    // path (present or not) the same way db-target.js does.
    delete require.cache[require.resolve('dotenv')];
    const dotenv = require('dotenv');
    dotenv.config({ path: path.resolve(REPO_ROOT, '.env.local'), quiet: true });
    assert.equal(process.env.DATABASE_URL, FAKE_DATABASE_URL);
  } finally {
    if (hadUrl) {
      process.env.DATABASE_URL = previousUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});
