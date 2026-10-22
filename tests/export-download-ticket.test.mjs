import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(new URL('../package.json', import.meta.url));
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const SECRET = 'synthetic-export-test-secret-that-is-not-a-production-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_COMPANY = '33333333-3333-4333-8333-333333333333';
const admin = {
  userId: USER_ID, username: 'synthetic-admin', companyId: COMPANY_ID,
  companySlug: 'test', companyName: 'Synthetic company', role: 'admin', fleetId: '',
};

async function loadModule(relative, imports = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    return require(name);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const tickets = await loadModule('../lib/export-download-ticket.ts');
const http = await loadModule('../lib/export-http.ts');
const branding = await loadModule('../branding.ts');
const types = await loadModule('../lib/types.ts');
// api-auth captures JWT_SECRET at module load; isolate that dependency without
// leaving a changed environment for any other tests in this process.
const previousSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = SECRET;
const auth = await loadModule('../lib/api-auth.ts');
if (previousSecret === undefined) delete process.env.JWT_SECRET;
else process.env.JWT_SECRET = previousSecret;

const bearer = (user = admin) => `Bearer ${jwt.sign(user, SECRET, { expiresIn: '5m' })}`;
const expectStatus = (status) => (error) => error instanceof tickets.ExportRequestError && error.status === status;

// This is an adapter mock, not PostgreSQL. It checks which scopes/operations the
// real helpers and handlers issue; SQL locking/transaction semantics require the
// separate isolated PostgreSQL validation and the production deployment gate.
function mockDatabase({ ownerExists = true, rejectInsert = false } = {}) {
  const records = new Map();
  const queries = [];
  let transactions = 0;
  function execute(text, values = []) {
    queries.push({ text, values });
    if (text === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return [];
    if (/^SELECT id FROM users/.test(text)) return ownerExists ? [{ id: USER_ID }] : [];
    if (/^DELETE FROM export_download_tickets\s+WHERE user_id/.test(text)) {
      for (const [hash, row] of records) {
        if (row.user_id === values[0] && row.company_id === values[1]
          && row.expires_at <= Date.now()) records.delete(hash);
      }
      return [];
    }
    if (/^INSERT INTO export_download_tickets/.test(text)) {
      if (!ownerExists || rejectInsert) return [];
      const [hash, userId, companyId, fleets, start, end, expiresAt] = values;
      records.set(hash, {
        user_id: userId, company_id: companyId, fleet_ids: [...fleets],
        date_start: start, date_end: end, expires_at: Date.parse(expiresAt),
      });
      return [{ token_hash: hash }];
    }
    if (/^DELETE FROM export_download_tickets\s+WHERE token_hash/.test(text)) {
      assert.match(text, /RETURNING user_id::text AS user_id, company_id::text AS company_id/);
      const row = records.get(values[0]);
      if (!row || row.expires_at <= Date.now()) return [];
      records.delete(values[0]);
      return [row];
    }
    if (/FROM inspection_logs il|FROM vehicle_master/.test(text)) return [];
    throw new Error(`Unexpected SQL in export test: ${text}`);
  }
  const sql = {
    query(text, values = []) {
      return { text, values, then(resolve, reject) {
        return Promise.resolve().then(() => execute(text, values)).then(resolve, reject);
      } };
    },
    async transaction(items) {
      transactions += 1;
      return items.map((item) => execute(item.text, item.values));
    },
  };
  return { sql, records, queries, get transactions() { return transactions; } };
}

function response() {
  const headers = new Map();
  return {
    statusCode: 200, body: undefined, headers,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end(value) { this.body = value; return this; },
  };
}

async function handlers(db) {
  const imports = {
    '@neondatabase/serverless': { neon: () => db.sql },
    '../../lib/api-auth': auth,
    '../../lib/export-download-ticket': tickets,
    '../../lib/export-http': http,
    '../../branding': branding,
    '../../lib/types': types,
  };
  return {
    issue: (await loadModule('../api/dashboard/export-ticket.ts', imports)).default,
    download: (await loadModule('../api/dashboard/export.ts', imports)).default,
  };
}

test('capabilities use five-minute signatures, random nonces, and a separate session key domain', async () => {
  const now = Date.now();
  const first = tickets.signExportTicket(SECRET, now);
  const second = tickets.signExportTicket(SECRET, now);
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, createHash('sha256').update(first.token).digest('hex'));
  assert.equal(tickets.verifyExportTicket(first.token, SECRET, now), first.tokenHash);
  assert.equal(Date.parse(first.expiresAt), (Math.floor(now / 1000) + 300) * 1000);
  assert.throws(() => tickets.verifyExportTicket(first.token, SECRET, Date.parse(first.expiresAt)), expectStatus(410));
  assert.throws(() => tickets.verifyExportTicket(first.token, 'different-secret', now), expectStatus(410));
  assert.throws(() => tickets.verifyExportTicket(first.token, SECRET, now - 10_000), expectStatus(410));
  assert.throws(() => tickets.verifyExportTicket(jwt.sign(admin, SECRET), SECRET), expectStatus(410));
  assert.equal(await auth.verifyAuth({ headers: { authorization: `Bearer ${first.token}` } }), null);
  assert.equal((await auth.verifyAuth({ headers: { authorization: bearer() } })).userId, USER_ID);
});

test('capability envelope rejects tampering, wrong purpose/issuer/audience/algorithm, and duplicate query values', () => {
  const { token } = tickets.signExportTicket(SECRET);
  const [header, payload, signature] = token.split('.');
  const changed = `${header}.${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`;
  assert.throws(() => tickets.verifyExportTicket(changed, SECRET), expectStatus(410));
  const key = createHmac('sha256', SECRET).update('SVIS/export-download-ticket/key/v1').digest();
  for (const changes of [{ purpose: 'login' }, { iss: 'other' }, { aud: 'other' }, { exp: 9_999_999_999 }]) {
    const claims = { ...JSON.parse(Buffer.from(payload, 'base64url')), ...changes };
    const unsigned = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const correctlySignedWrongClaims = `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`;
    assert.throws(() => tickets.verifyExportTicket(correctlySignedWrongClaims, SECRET), expectStatus(410));
  }
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'svis-export-ticket', v: 1 })).toString('base64url');
  assert.throws(() => tickets.verifyExportTicket(`${noneHeader}.${payload}.${signature}`, SECRET), expectStatus(410));
  for (const value of [null, undefined, '', [token, token], 'x'.repeat(2048)]) {
    assert.throws(() => tickets.verifyExportTicket(value, SECRET), expectStatus(410));
  }
});

test('scope validates real calendar dates, range and types, and keeps a non-admin in the assigned fleet', () => {
  const resolved = tickets.resolveExportScope(admin, { fleetId: 'CXM, EGW, CXM', dateStart: '2024-02-29', dateEnd: '2024-03-01' });
  assert.deepEqual(resolved, {
    userId: USER_ID, companyId: COMPANY_ID, fleetIds: ['CXM', 'EGW'], dateStart: '2024-02-29', dateEnd: '2024-03-01',
  });
  assert.deepEqual(tickets.resolveExportScope({ ...admin, role: 'supervisor', fleetId: 'CXM' }, {
    fleetId: 'EGW', companyId: OTHER_COMPANY, role: 'admin',
  }).fleetIds, ['CXM']);
  assert.throws(() => tickets.resolveExportScope({ ...admin, role: 'supervisor', fleetId: '' }, {}), expectStatus(403));
  for (const input of [
    null, [], { dateStart: '2025-02-29' }, { dateEnd: '2026-04-31' }, { dateStart: '2026-1-01' },
    { dateStart: '0000-01-01' }, { dateStart: '2026-10-23', dateEnd: '2026-10-22' },
    { dateStart: ['2026-10-22'] }, { dateEnd: 123 }, { fleetId: ['CXM'] }, { fleetId: 'bad\nvalue' },
  ]) assert.throws(() => tickets.resolveExportScope(admin, input), expectStatus(400));
});

test('issuance stores only hash and immutable scope, and handles missing owner or ticket cap', async () => {
  const db = mockDatabase();
  const scope = tickets.resolveExportScope(admin, { fleetId: 'CXM', dateStart: '2026-10-22' });
  const issued = await tickets.issueExportTicket(db.sql, scope, SECRET);
  const url = new URL(issued.downloadUrl, 'https://svis.songdeegps.com');
  assert.equal(url.pathname, '/api/dashboard/export');
  assert.deepEqual([...url.searchParams.keys()], ['downloadTicket']);
  const token = url.searchParams.get('downloadTicket');
  const hash = tickets.verifyExportTicket(token, SECRET);
  assert.equal(db.transactions, 1);
  assert.equal(db.queries[0].text, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  assert.match(db.queries[1].text, /company_id = \$2::uuid FOR UPDATE/);
  assert.equal(db.records.get(hash).company_id, COMPANY_ID);
  assert.deepEqual(db.records.get(hash).fleet_ids, ['CXM']);
  assert.ok(!JSON.stringify(db.queries).includes(token));
  assert.equal(db.queries[3].values.at(-1), tickets.MAX_OUTSTANDING_EXPORT_TICKETS);
  await assert.rejects(tickets.issueExportTicket(mockDatabase({ rejectInsert: true }).sql, scope, SECRET), expectStatus(429));
  await assert.rejects(tickets.issueExportTicket(mockDatabase({ ownerExists: false }).sql, scope, SECRET), expectStatus(401));
});

test('redemption executes one atomic deletion, rejects replay, and rejects invalid signatures before SQL', async () => {
  const db = mockDatabase();
  const expected = tickets.resolveExportScope(admin, { fleetId: 'CXM', dateStart: '2026-10-22' });
  const issued = await tickets.issueExportTicket(db.sql, expected, SECRET);
  const token = new URL(issued.downloadUrl, 'https://svis.songdeegps.com').searchParams.get('downloadTicket');
  const attempts = await Promise.allSettled([
    tickets.redeemExportTicket(db.sql, token, SECRET), tickets.redeemExportTicket(db.sql, token, SECRET),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.deepEqual(attempts.find((attempt) => attempt.status === 'fulfilled').value, expected);
  assert.equal(attempts.find((attempt) => attempt.status === 'rejected').reason.status, 410);
  const count = db.queries.length;
  await assert.rejects(tickets.redeemExportTicket(db.sql, 'bad-token', SECRET), expectStatus(410));
  assert.equal(db.queries.length, count);
});

test('methods and CORS errors do not authenticate or consume a download ticket', async () => {
  const db = mockDatabase();
  const api = await handlers(db);
  for (const [method, expectedStatus] of [['HEAD', 405], ['OPTIONS', 204], ['POST', 405]]) {
    const res = response();
    await api.download({ method, headers: { origin: 'https://svis.songdeegps.com' }, query: { downloadTicket: 'unused' } }, res);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(res.getHeader('Access-Control-Allow-Origin'), 'https://svis.songdeegps.com');
    assert.match(res.getHeader('Cache-Control'), /no-store/);
  }
  const postOptions = response();
  await api.issue({ method: 'OPTIONS', headers: {}, query: {} }, postOptions);
  assert.equal(postOptions.statusCode, 204);
  assert.equal(db.queries.length, 0);
  for (const origin of ['https://svis.songdeegps.com', 'https://songdee-svis.vercel.app', 'https://evil.example', 'null', undefined]) {
    const res = response();
    await api.download({ method: 'GET', headers: { origin }, query: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.getHeader('Access-Control-Allow-Origin'),
      ['https://svis.songdeegps.com', 'https://songdee-svis.vercel.app'].includes(origin) ? origin : undefined);
    assert.equal(res.getHeader('Vary'), 'Origin');
  }
});

test('ticket endpoint rejects unauthenticated, invalid and unassigned requests without SQL', async () => {
  const db = mockDatabase();
  const api = await handlers(db);
  const cases = [
    [{}, {}, 401],
    [{ authorization: bearer(), 'content-type': 'text/plain' }, {}, 415],
    [{ authorization: bearer(), 'content-type': 'application/json' }, { dateStart: '2026-02-30' }, 400],
    [{ authorization: bearer({ ...admin, role: 'supervisor' }), 'content-type': 'application/json' }, {}, 403],
  ];
  for (const [headers, body, status] of cases) {
    const res = response();
    await api.issue({ method: 'POST', headers: { ...headers, origin: 'https://svis.songdeegps.com' }, body, query: {} }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.getHeader('Access-Control-Allow-Origin'), 'https://svis.songdeegps.com');
  }
  assert.equal(db.queries.length, 0);
});

test('real handler creates an XLSX from ticket scope after proxy return and ignores query overrides', async () => {
  const db = mockDatabase();
  const api = await handlers(db);
  const issued = response();
  await api.issue({
    method: 'POST', headers: { authorization: bearer(), 'content-type': 'application/json' }, query: {},
    body: { fleetId: 'CXM', dateStart: '2026-10-22', dateEnd: '2026-10-22' },
  }, issued);
  assert.equal(issued.statusCode, 200);
  const token = new URL(issued.body.downloadUrl, 'https://svis.songdeegps.com').searchParams.get('downloadTicket');
  const res = response();
  await api.download({
    method: 'GET', headers: {}, query: {
      downloadTicket: token, _sm_nck: '1', fleetId: 'OUTSIDE', companyId: OTHER_COMPANY,
      dateStart: '2000-01-01', dateEnd: '2099-12-31',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.getHeader('Content-Disposition'), /^attachment; filename=".*\.xlsx"$/);
  assert.match(res.getHeader('Content-Type'), /spreadsheetml/);
  assert.ok(Buffer.isBuffer(res.body));
  const reportQueries = db.queries.filter(({ text }) => /FROM inspection_logs il|FROM vehicle_master/.test(text));
  assert.equal(reportQueries.length, 4);
  for (const { values } of reportQueries) {
    assert.equal(values[0], COMPANY_ID);
    assert.ok(values.includes('CXM'));
    assert.ok(!values.some((value) => ['OUTSIDE', OTHER_COMPANY, '2000-01-01', '2099-12-31'].includes(value)));
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Summary', 'By Fleet', 'Inspections', 'Checklist Detail']);
  assert.equal(workbook.getWorksheet('Summary').getCell('B4').value, 'CXM');
  assert.equal(workbook.getWorksheet('Summary').getCell('B5').value, '2026-10-22');
  const replay = response();
  await api.download({ method: 'GET', headers: { authorization: bearer() }, query: { downloadTicket: token } }, replay);
  assert.equal(replay.statusCode, 410);
});

test('existing bearer export still creates the workbook and fails closed for a missing fleet', async () => {
  const db = mockDatabase();
  const api = await handlers(db);
  const res = response();
  await api.download({ method: 'GET', headers: { authorization: bearer() }, query: { fleetId: 'CXM' } }, res);
  assert.equal(res.statusCode, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.equal(workbook.worksheets.length, 4);
  assert.equal(db.transactions, 0);
  const denied = response();
  const queryCount = db.queries.length;
  await api.download({ method: 'GET', headers: { authorization: bearer({ ...admin, role: 'supervisor' }) }, query: {} }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(db.queries.length, queryCount);
});

test('failure logs contain bounded codes rather than credentials or database error messages', () => {
  const messages = [];
  const previous = console.error;
  console.error = (message) => messages.push(message);
  try {
    http.logExportFailure('export_ticket_issue_failed', { code: '42P01', message: `SELECT secret ${SECRET}` });
    http.logExportFailure('dashboard_export_failed', { code: `secret ${SECRET}`, message: SECRET });
  } finally {
    console.error = previous;
  }
  assert.deepEqual(messages.map((message) => JSON.parse(message)), [
    { event: 'export_ticket_issue_failed', code: '42P01' },
    { event: 'dashboard_export_failed', code: 'UNKNOWN' },
  ]);
  assert.ok(!messages.join('').includes(SECRET));
});
