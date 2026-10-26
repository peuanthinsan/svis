import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(new URL('../package.json', import.meta.url));
const ExcelJS = require('exceljs');
const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VEHICLE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VEHICLE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const admin = { companyId: COMPANY, userId: USER, role: 'admin', username: 'synthetic-admin' };
const owner = { id: USER, username: 'synthetic-owner', first_name: 'Vehicle', last_name: 'Owner', role: 'vehicle_owner', fleet_id: '' };

async function loadModule(relative, imports = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    return require(name);
  }, module, module.exports);
  return module.exports;
}

const assignments = await loadModule('../lib/owner-vehicle-assignment.ts');
const validate = await loadModule('../lib/validate.ts');
const expectStatus = (status) => (error) => error instanceof assignments.OwnerVehicleAssignmentError && error.status === status;

// Scripted adapter responses check the production SQL and request contract without
// pretending to run PostgreSQL. The CTE and locking behavior also require an
// isolated PostgreSQL integration check before deployment.
function database(responses = []) {
  const calls = [];
  const transactions = [];
  const execute = (statement) => {
    calls.push(statement);
    assert.ok(responses.length, `Unexpected SQL: ${statement.text}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const sql = (strings, ...values) => sql.query(strings.join('?'), values);
  sql.query = (text, values = []) => ({ text, values, then(resolve, reject) {
    return Promise.resolve().then(() => execute({ text, values })).then(resolve, reject);
  } });
  sql.transaction = async (items, options) => {
    transactions.push({ items, options });
    return items.map(execute);
  };
  return { sql, calls, transactions, responses };
}

function response() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
  };
}

async function handler(relative, db, currentUser = admin) {
  const { requireAdmin } = await loadModule('../lib/admin-auth.ts', {
    './api-auth': { verifyAuth: async () => currentUser },
  });
  const imports = { '@neondatabase/serverless': { neon: () => db.sql }, bcryptjs: { hash: async () => 'hashed-password' } };
  for (const prefix of ['../../../lib/', '../../../../lib/']) {
    imports[`${prefix}admin-auth`] = { requireAdmin };
    imports[`${prefix}validate`] = validate;
    imports[`${prefix}api-auth`] = { BCRYPT_ROUNDS: 12 };
    imports[`${prefix}owner-vehicle-assignment`] = assignments;
    imports[`${prefix}audit`] = { logAudit: async () => {} };
  }
  return (await loadModule(relative, imports)).default;
}

const createInput = { username: 'synthetic-owner', passwordHash: 'hashed', firstName: 'Vehicle', lastName: 'Owner', role: 'vehicle_owner' };

test('selections require UUID arrays, normalize case and duplicates, and preserve explicit empty lists', () => {
  assert.deepEqual(assignments.normalizeVehicleIds([VEHICLE_A, VEHICLE_A.toUpperCase(), VEHICLE_B]), [VEHICLE_A, VEHICLE_B]);
  assert.deepEqual(assignments.normalizeVehicleIds([]), []);
  for (const value of [undefined, null, '', VEHICLE_A, {}, [null], [7], [VEHICLE_A, 'invalid'], ['']]) {
    assert.throws(() => assignments.normalizeVehicleIds(value), expectStatus(400));
  }
});

test('malformed and non-owner create selections cannot execute SQL', async () => {
  const db = database();
  await assert.rejects(assignments.createAccountWithVehicles(db.sql, COMPANY, { ...createInput, vehicleIds: ['bad-id'] }), expectStatus(400));
  await assert.rejects(assignments.createAccountWithVehicles(db.sql, COMPANY, { ...createInput, role: 'admin', vehicleIds: [VEHICLE_A] }), expectStatus(400));
  await assert.rejects(assignments.updateAccountWithVehicles(db.sql, COMPANY, USER, { vehicleIds: null }), expectStatus(400));
  assert.equal(db.calls.length, 0);
});

test('owner creation validates the complete same-company list in the account insertion statement', async () => {
  const db = database([[owner]]);
  assert.deepEqual(await assignments.createAccountWithVehicles(db.sql, COMPANY, { ...createInput, fleetId: 'IGNORED', vehicleIds: [VEHICLE_A, VEHICLE_B] }), owner);
  assert.equal(db.calls.length, 1);
  const { text, values } = db.calls[0];
  assert.equal(values[0], COMPANY);
  assert.equal(values[6], '', 'Owner accounts do not need a fleet');
  assert.deepEqual(values[7], [VEHICLE_A, VEHICLE_B]);
  assert.match(text, /WHERE company_id = \$1::uuid AND id = ANY\(\$8::uuid\[\]\)/);
  assert.match(text, /WHERE \(SELECT COUNT\(\*\) FROM selected_vehicles\) = cardinality\(\$8::uuid\[\]\)/);
  assert.match(text, /FROM created_user u CROSS JOIN selected_vehicles v/);
  assert.doesNotMatch(text, /UPDATE vehicle_master|INSERT INTO vehicle_master|UPDATE fleets/);
});

test('missing or foreign-company vehicles reject the complete account create', async () => {
  const db = database([[]]);
  await assert.rejects(assignments.createAccountWithVehicles(db.sql, COMPANY, { ...createInput, vehicleIds: [VEHICLE_A, VEHICLE_B] }), expectStatus(400));
  assert.equal(db.calls.length, 1, 'No separate account INSERT can succeed before validation');
});

test('omitted selections create an owner with zero grants instead of all company vehicles', async () => {
  const db = database([[owner]]);
  await assignments.createAccountWithVehicles(db.sql, COMPANY, createInput);
  assert.deepEqual(db.calls[0].values[7], []);
});

test('account edits serialize replacement and apply password and fields in the same guarded mutation', async () => {
  const db = database([[{ id: USER, role: 'vehicle_owner' }], [owner]]);
  await assignments.updateAccountWithVehicles(db.sql, COMPANY, USER, { firstName: 'Changed', passwordHash: 'new-hash', vehicleIds: [VEHICLE_B] });
  assert.equal(db.transactions.length, 1);
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.transactions[0].options, { isolationLevel: 'ReadCommitted' });
  assert.match(db.calls[0].text, /company_id = \$2::uuid FOR UPDATE/);
  const mutation = db.calls[1];
  assert.deepEqual(mutation.values, [COMPANY, USER, 'Changed', null, null, null, 'new-hash', true, [VEHICLE_B]]);
  assert.match(mutation.text, /password_hash = COALESCE\(\$7::text, u.password_hash\)/);
  assert.match(mutation.text, /COUNT\(\*\) FROM selected_vehicles\) = cardinality\(\$9::uuid\[\]\)/);
  assert.match(mutation.text, /DELETE FROM user_vehicle_access a USING updated_user u/);
  assert.match(mutation.text, /FROM updated_user u CROSS JOIN selected_vehicles v/);
  assert.doesNotMatch(mutation.text, /UPDATE vehicle_master|INSERT INTO vehicle_master/);
});

test('empty replacement removes every owner grant, while an omitted selection preserves it', async () => {
  for (const input of [{ vehicleIds: [] }, { firstName: 'Changed' }]) {
    const db = database([[{ id: USER, role: 'vehicle_owner' }], [owner]]);
    await assignments.updateAccountWithVehicles(db.sql, COMPANY, USER, input);
    assert.equal(db.calls[1].values[7], Object.hasOwn(input, 'vehicleIds'));
    assert.deepEqual(db.calls[1].values[8], []);
    assert.match(db.calls[1].text, /\$8::boolean AND NOT \(a.vehicle_id = ANY\(\$9::uuid\[\]\)\)/);
  }
});

test('role conversion revokes old owner grants in the account transaction', async () => {
  const db = database([[{ id: USER, role: 'vehicle_owner', last_name: 'Owner' }], [{ ...owner, role: 'driver', fleet_id: 'A' }]]);
  await assignments.updateAccountWithVehicles(db.sql, COMPANY, USER, { role: 'driver', fleetId: 'A' });
  assert.equal(db.calls[1].values[4], 'driver');
  assert.equal(db.calls[1].values[7], false);
  assert.match(db.calls[1].text, /u.role <> 'vehicle_owner' OR/);
});

test('converting a corporate owner to a person role requires a surname before profile or grants change', async () => {
  const db = database([[{ id: USER, role: 'vehicle_owner', last_name: '' }], []]);
  await assert.rejects(assignments.updateAccountWithVehicles(db.sql, COMPANY, USER, {
    role: 'driver', fleetId: 'A', passwordHash: 'must-not-change',
  }), (error) => expectStatus(400)(error) && /Last name/.test(error.message));
  assert.match(db.calls[1].text, /\$5::text IS NULL OR \$5::text = 'vehicle_owner'\s+OR length\(btrim\(COALESCE\(\$4::text, u.last_name\)\)\) > 0/);
  assert.match(db.calls[1].text, /DELETE FROM user_vehicle_access a USING updated_user u/);

  const valid = database([[{ id: USER, role: 'vehicle_owner', last_name: '' }], [{ ...owner, role: 'driver', last_name: 'Person' }]]);
  await assignments.updateAccountWithVehicles(valid.sql, COMPANY, USER, { role: 'driver', lastName: 'Person' });
  assert.equal(valid.calls[1].values[3], 'Person');
});

test('edit rejects unavailable users, non-owner selections and invalid company lists', async () => {
  const cases = [
    { locked: [], status: 404 },
    { locked: [{ id: USER, role: 'driver' }], status: 400 },
    { locked: [{ id: USER, role: 'vehicle_owner' }], status: 400 },
  ];
  for (const scenario of cases) {
    const db = database([scenario.locked, []]);
    await assert.rejects(assignments.updateAccountWithVehicles(db.sql, COMPANY, USER, { firstName: 'Must not change', passwordHash: 'must-not-change', vehicleIds: [VEHICLE_A] }), expectStatus(scenario.status));
    assert.equal(db.calls.filter(({ text }) => /UPDATE users/.test(text)).length, 1);
    assert.match(db.calls[1].text, /u.id = \$2::uuid AND u.company_id = \$1::uuid/);
    assert.match(db.calls[1].text, /COALESCE\(\$5::text, u.role\) = 'vehicle_owner'\s+AND \(SELECT COUNT/);
  }
});

test('checklist retrieval returns a complete stable catalog including inactive selected vehicles', async () => {
  const vehicles = Array.from({ length: 501 }, (_, index) => ({ id: String(index), is_active: index !== 500 }));
  const db = database([[{ ...owner, vehicles, selected_vehicle_ids: ['500'] }]]);
  const result = await assignments.getOwnerVehicleSelection(db.sql, COMPANY, USER);
  assert.equal(result.vehicles.length, 501);
  assert.deepEqual(result.selectedVehicleIds, ['500']);
  assert.equal(result.vehicles.at(-1).is_active, false);
  assert.equal(db.calls.length, 1, 'A single SQL statement supplies a stable snapshot on both hosting adapters');
  assert.doesNotMatch(db.calls[0].text, /LIMIT|is_active\s*=/i);
  assert.match(db.calls[0].text, /company_id = \$1::uuid/);
});

test('all user-management routes keep the real admin guard ahead of database access', async () => {
  for (const role of ['vehicle_owner', 'driver', 'supervisor', null]) {
    for (const [route, method] of [
      ['../api/admin/users/index.ts', 'POST'], ['../api/admin/users/[id].ts', 'PUT'],
      ['../api/admin/users/[id]/vehicles.ts', 'GET'], ['../api/admin/users/[id]/vehicles.ts', 'PUT'],
      ['../api/admin/users/import.ts', 'POST'], ['../api/admin/users/export.ts', 'GET'],
    ]) {
      const db = database();
      const api = await handler(route, db, role ? { ...admin, role } : null);
      const res = response();
      await api({ method, query: { id: USER }, body: { vehicleIds: [] }, headers: {} }, res);
      assert.equal(res.statusCode, role ? 403 : 401);
      assert.equal(db.calls.length, 0);
    }
  }
});

test('checklist endpoint accepts empty PUT and rejects malformed IDs and missing arrays', async () => {
  const db = database([[{ id: USER, role: 'vehicle_owner' }], [owner]]);
  const api = await handler('../api/admin/users/[id]/vehicles.ts', db);
  const saved = response();
  await api({ method: 'PUT', query: { id: USER }, body: { vehicleIds: [] } }, saved);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body, { vehicleIds: [] });
  assert.equal(saved.headers['cache-control'], 'no-store');
  for (const [query, body] of [[{ id: 'invalid' }, { vehicleIds: [] }], [{ id: USER }, {}], [{ id: USER }, { vehicleIds: ['bad'] }]]) {
    const res = response();
    await api({ method: 'PUT', query, body }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(db.calls.length, 2);
});

test('account create and update expose vehicle_owner and atomically pass their checklist', async () => {
  const createDb = database([[owner]]);
  const create = await handler('../api/admin/users/index.ts', createDb);
  const created = response();
  await create({ method: 'POST', query: {}, body: { username: owner.username, password: 'synthetic-password', firstName: 'Vehicle', lastName: 'Owner', role: 'vehicle_owner', vehicleIds: [VEHICLE_A] } }, created);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(createDb.calls[0].values[7], [VEHICLE_A]);

  const updateDb = database([[{ id: USER, role: 'driver' }], [owner]]);
  const update = await handler('../api/admin/users/[id].ts', updateDb);
  const updated = response();
  await update({ method: 'PUT', query: { id: USER }, body: { role: 'vehicle_owner', vehicleIds: [VEHICLE_B], password: 'synthetic-password' } }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updateDb.calls[1].values[6], 'hashed-password');
  assert.deepEqual(updateDb.calls[1].values[8], [VEHICLE_B]);
});

test('corporate owners can be created with a customer name and no surname while other roles still require one', async () => {
  const base = { username: 'synthetic-customer', password: 'synthetic-password', firstName: 'Synthetic Leasing', role: 'vehicle_owner' };
  for (const lastName of [undefined, '', '  ']) {
    const db = database([[{ ...owner, first_name: base.firstName, last_name: lastName ?? '' }]]);
    const api = await handler('../api/admin/users/index.ts', db);
    const res = response();
    await api({ method: 'POST', query: {}, body: { ...base, lastName } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(db.calls[0].values[3], 'Synthetic Leasing');
    assert.equal(db.calls[0].values[4], lastName ?? '');
    assert.deepEqual(db.calls[0].values[7], []);
  }
  for (const fields of [
    ...['driver', 'supervisor', 'admin'].flatMap((role) => [{ role, lastName: undefined }, { role, lastName: '' }]),
    { lastName: null }, { lastName: 1 }, { lastName: 'x'.repeat(101) },
    { firstName: '' }, { firstName: 'x'.repeat(101) },
  ]) {
    const db = database();
    const api = await handler('../api/admin/users/index.ts', db);
    const res = response();
    await api({ method: 'POST', query: {}, body: { ...base, ...fields } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.calls.length, 0);
  }
});

test('blank surname updates require an explicit owner role and preserve name length checks', async () => {
  const db = database([[{ id: USER, role: 'vehicle_owner', last_name: 'Old' }], [{ ...owner, last_name: '' }]]);
  const api = await handler('../api/admin/users/[id].ts', db);
  const res = response();
  await api({ method: 'PUT', query: { id: USER }, body: { role: 'vehicle_owner', firstName: 'Synthetic Leasing', lastName: '' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls[1].values[3], '');
  assert.equal(db.calls[1].values[7], false, 'A name-only edit leaves the vehicle checklist untouched');
  for (const fields of [
    { lastName: '' }, { role: 'driver', lastName: '' },
    { role: 'vehicle_owner', lastName: null }, { role: 'vehicle_owner', lastName: 'x'.repeat(101) },
    { role: 'vehicle_owner', firstName: '' },
  ]) {
    const invalid = response();
    await api({ method: 'PUT', query: { id: USER }, body: fields }, invalid);
    assert.equal(invalid.statusCode, 400);
  }
  assert.equal(db.calls.length, 2);
});

test('user imports accept owner labels without a fleet and do not infer any vehicle grants', async () => {
  const db = database([[], []]);
  const api = await handler('../api/admin/users/import.ts', db);
  const csv = 'Username,First Name,Last Name,Role,Fleet,Password\nsynthetic-owner,Vehicle,Owner,Vehicle Owner,,synthetic-password\n';
  const req = {
    method: 'PUT', query: { mode: 'add', filename: 'users.csv' }, headers: { 'content-type': 'text/csv' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(csv); },
  };
  const res = response();
  await api(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.add, 1);
  assert.equal(db.calls[1].values[5], 'vehicle_owner');
  assert.equal(db.calls[1].values[6], '');
  assert.doesNotMatch(db.calls[1].text, /user_vehicle_access/);
});

test('owner imports keep multiword customer names intact and do not require a surname', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Synthetic');
  sheet.addRow(['Username', 'First Name', 'Last Name', 'Role', 'Password']);
  sheet.addRow(['synthetic-customer', 'Synthetic Leasing', '', 'vehicle_owner', 'synthetic-password']);
  const sources = [
    { filename: 'users.csv', data: Buffer.from('Username,First Name,Last Name,Role,Password\nsynthetic-customer,Synthetic Leasing,,vehicle_owner,synthetic-password\n') },
    { filename: 'users.csv', data: Buffer.from('Username,Name,Role,Password\nsynthetic-customer,Synthetic Leasing,vehicle_owner,synthetic-password\n') },
    { filename: 'users.xlsx', data: Buffer.from(await workbook.xlsx.writeBuffer()) },
  ];
  for (const { filename, data } of sources) {
    const db = database([[], []]);
    const api = await handler('../api/admin/users/import.ts', db);
    const res = response();
    await api({ method: 'PUT', query: { mode: 'add', filename }, headers: {}, async *[Symbol.asyncIterator]() { yield data; } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(db.calls[1].values[3], 'Synthetic Leasing');
    assert.equal(db.calls[1].values[4], '');
    assert.doesNotMatch(db.calls[1].text, /user_vehicle_access/);
  }
});

test('imports still require person surnames and cap owner name lengths before mutation', async () => {
  for (const [firstName, lastName, role] of [['Synthetic', '', 'driver'], ['x'.repeat(101), '', 'vehicle_owner'], ['Synthetic', 'x'.repeat(101), 'vehicle_owner']]) {
    const db = database([[]]);
    const api = await handler('../api/admin/users/import.ts', db);
    const res = response();
    const data = Buffer.from(`Username,First Name,Last Name,Role,Password\nsynthetic-customer,${firstName},${lastName},${role},synthetic-password\n`);
    await api({ method: 'PUT', query: { mode: 'add', filename: 'users.csv' }, headers: {}, async *[Symbol.asyncIterator]() { yield data; } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.transactions.length, 0);
    assert.equal(db.calls.length, 1, 'Only the read-only import plan executes');
  }
});

test('user import clears grants when changing an owner role and preserves selections on owner updates', async () => {
  for (const newRole of ['driver', 'vehicle_owner']) {
    const db = database([[{ ...owner, is_active: true }], [], ...(newRole === 'driver' ? [[]] : [])]);
    const api = await handler('../api/admin/users/import.ts', db);
    const csv = `Username,First Name,Last Name,Role,Fleet\nsynthetic-owner,Vehicle,Owner,${newRole},A\n`;
    const req = {
      method: 'PUT', query: { mode: 'modify', filename: 'users.csv' }, headers: { 'content-type': 'text/csv' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(csv); },
    };
    const res = response();
    await api(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(db.transactions.length, 1);
    assert.equal(db.calls.filter(({ text }) => /DELETE FROM user_vehicle_access/.test(text)).length, newRole === 'driver' ? 1 : 0);
    assert.equal(db.calls[1].values[3], newRole === 'driver' ? 'A' : '');
  }
});

test('user export accepts owner filter and writes the exact role into the exported workbook', async () => {
  const db = database([[owner]]);
  const api = await handler('../api/admin/users/export.ts', db);
  const res = response();
  await api({ method: 'GET', query: { role: 'vehicle_owner' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(db.calls[0].values.includes('vehicle_owner'));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.equal(workbook.getWorksheet('Users').getCell('D2').value, 'vehicle_owner');
});
