import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const SECOND_OWNER = '44444444-4444-4444-8444-444444444444';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = { userId: OWNER, companyId: COMPANY, companySlug: 'synthetic', role: 'vehicle_owner', fleetId: '' };
const vehicles = [
  { id: uuid(1), plate_number: 'SYNTHETIC-1', fleet_id: 'fleet-a', company_id: COMPANY },
  { id: uuid(2), plate_number: 'SYNTHETIC-2', fleet_id: 'fleet-b', company_id: COMPANY },
  { id: uuid(3), plate_number: 'SYNTHETIC-3', fleet_id: 'fleet-c', company_id: COMPANY },
  { id: uuid(4), plate_number: 'SYNTHETIC-4', fleet_id: 'fleet-a', company_id: OTHER_COMPANY },
].map((vehicle) => ({ ...vehicle, is_active: vehicle.id !== uuid(3), vehicle_type: 'van', daily_status: 'pending', tax_expiry_date: null }));

const bundles = new Map();
async function loadHandler(path, state) {
  if (!bundles.has(path)) {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`../${path}`, import.meta.url))],
      bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
      plugins: [{ name: 'isolated-boundaries', setup(builder) {
        builder.onResolve({ filter: /(?:api-auth|unit-status-sheet|\/email|\/audit)$|^@neondatabase\/serverless$|^@vercel\/blob$/ }, (args) => ({ path: args.path, namespace: 'test-boundary' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path: dependency }) => {
          let contents;
          if (dependency.endsWith('api-auth')) contents = 'export const verifyAuth = async () => __state.user;';
          else if (dependency === '@neondatabase/serverless') contents = 'export const neon = () => __state.sql;';
          else if (dependency.endsWith('unit-status-sheet')) contents = 'export const fetchSheetVehicles = async () => __state.sheet; export const recordVehicleActivity = async () => __state.recordActivity();';
          else if (dependency.endsWith('/email')) contents = 'export const sendInspectionFailEmail = () => __state.write(); export const sendVendorNotifyEmail = () => __state.write();';
          else if (dependency.endsWith('/audit')) contents = 'export const logAudit = () => __state.write();';
          else contents = 'export const put = () => __state.write();';
          return { contents, loader: 'js' };
        });
      } }],
    });
    bundles.set(path, result.outputFiles[0].text);
  }
  const loaded = { exports: {} };
  new Function('__state', 'require', 'module', 'exports', bundles.get(path))(state, require, loaded, loaded.exports);
  return loaded.exports.default;
}

function response() {
  return { statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    send(body) { this.body = body; return this; },
    end(body) { this.body = body; return this; },
  };
}

// A query-aware boundary fixture, not a SQL engine: it requires parameterized
// owner/company predicates before returning rows and applies the requested
// pagination afterward. Separate PostgreSQL validation covers SQL semantics.
function fixture(user = owner, assigned = [uuid(1), uuid(2)]) {
  const state = {
    user, assigned: [...assigned], queries: [], activityWrites: 0, sheet: null,
    write() { assert.fail('Owner request reached a write or email boundary'); },
    recordActivity() { state.activityWrites++; },
  };
  const logs = (rows) => rows.map((vehicle) => ({
    id: uuid(100 + Number(vehicle.id.slice(-2))), vehicle_id: vehicle.id,
    company_id: vehicle.company_id, vehicle_fleet: vehicle.fleet_id,
    current_fleet_id: vehicle.fleet_id, plate_number: vehicle.plate_number,
    vehicle_type: vehicle.vehicle_type, overall_status: 'pass', inspection_date: '2026-10-26',
    fleet_id: vehicle.fleet_id, results: [],
  }));
  const issues = (rows) => rows.map((vehicle) => ({
    id: uuid(200 + Number(vehicle.id.slice(-2))), vehicle_id: vehicle.id,
    inspection_id: uuid(100 + Number(vehicle.id.slice(-2))), company_id: vehicle.company_id,
    vehicle_fleet: vehicle.fleet_id, plate_number: vehicle.plate_number,
    vehicle_type: vehicle.vehicle_type, status: 'open', created_at: '2026-10-26T00:00:00Z',
    defect_photo_urls: [], completion_photo_urls: [],
  }));
  const execute = async (text, values = []) => {
    state.queries.push({ text, values });
    assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE)\b/);
    if (/FROM user_vehicle_access/.test(text)) {
      assert.ok(values.includes(state.user.userId));
      assert.ok(values.includes(state.user.companyId));
      assert.match(text, /vehicle\.company_id = access\.company_id/);
      return state.assigned.filter((id) => vehicles.some((vehicle) => vehicle.id === id && vehicle.company_id === state.user.companyId)).map((vehicle_id) => ({ vehicle_id }));
    }
    if (/FROM inspection_results/.test(text)) return [];
    assert.ok(values.includes(state.user.companyId), `Missing company scope: ${text}`);
    let rows = vehicles.filter((vehicle) => vehicle.company_id === state.user.companyId);
    if (state.user.role === 'vehicle_owner') {
      const scope = text.match(/(?:[a-z_]+\.)?(?:id|vehicle_id) = ANY\(\$(\d+)::uuid\[\]\)/);
      assert.ok(scope, `Missing owner predicate before a data read: ${text}`);
      const ids = values[Number(scope[1]) - 1];
      assert.ok(Array.isArray(ids), 'An owner scope must be an array, including when empty');
      assert.deepEqual(ids, state.assigned.filter((id) => vehicles.some((vehicle) => vehicle.id === id && vehicle.company_id === state.user.companyId)));
      rows = rows.filter((vehicle) => ids.includes(vehicle.id));
      const endOfPredicate = (text.indexOf('ORDER BY') < 0 ? text.length : text.indexOf('ORDER BY'));
      // Maintenance's LATERAL ORDER BY belongs to the selected vehicle's mileage
      // history; the outer WHERE is still evaluated before outer pagination.
      if (!text.includes('LEFT JOIN LATERAL')) assert.ok(scope.index < endOfPredicate);
    }
    const inactiveAllowance = text.match(/\$(\d+)::boolean OR (?:[a-z_]+\.)?is_active/);
    if (/\bAND (?:[a-z_]+\.)?is_active\b/.test(text)
      || (inactiveAllowance && values[Number(inactiveAllowance[1]) - 1] !== true)) {
      rows = rows.filter((vehicle) => vehicle.is_active);
    }
    const fleet = [...text.matchAll(/(?:[a-z_]+\.)?fleet_id = \$(\d+)/g)]
      .map((match) => values[Number(match[1]) - 1]).find((value) => typeof value === 'string' && value.startsWith('fleet-'));
    if (fleet) rows = rows.filter((vehicle) => vehicle.fleet_id === fleet);
    const scalarVehicleId = text.match(/WHERE [a-z_]+\.vehicle_id = \$(\d+)/);
    if (scalarVehicleId) rows = rows.filter((vehicle) => vehicle.id === values[Number(scalarVehicleId[1]) - 1]);
    const pattern = text.match(/plate_number ILIKE \$(\d+)/);
    if (pattern) {
      const query = String(values[Number(pattern[1]) - 1] ?? '').replaceAll('%', '');
      rows = rows.filter((vehicle) => vehicle.plate_number.includes(query));
    }
    const scalarId = text.match(/WHERE (?:v\.|il\.|ir\.)?id = \$(\d+)/);
    if (scalarId) {
      const requested = values[Number(scalarId[1]) - 1];
      if (text.includes('FROM inspection_logs il')) return logs(rows).filter((row) => row.id === requested);
      if (text.includes('FROM issue_reports ir')) return issues(rows).filter((row) => row.id === requested);
      return rows.filter((row) => row.id === requested);
    }
    if (text.includes('WITH latest_answered')) return [{ total: 0, passed: 0, failed: 0, inspections: [] }];
    if (text.includes('COUNT(*) FILTER (WHERE NOT vehicle_usable)') || text.includes('COUNT(DISTINCT vehicle_id)')) return [{ total: 0, today: 0 }];
    if (text.includes('GROUP BY fleet_id') || text.includes('GROUP BY v.fleet_id')) {
      return [...new Set(rows.map((row) => row.fleet_id))].map((fleet_id) => ({ fleet_id, total: rows.filter((row) => row.fleet_id === fleet_id).length, checked: 0 }));
    }
    if (text.includes('COUNT(*)')) return [{ total: rows.length, passed: rows.length, failed: 0 }];
    const pagination = text.match(/LIMIT \$(\d+) OFFSET \$(\d+)/);
    if (pagination) rows = rows.slice(values[Number(pagination[2]) - 1], values[Number(pagination[2]) - 1] + values[Number(pagination[1]) - 1]);
    if (text.includes('SELECT ir.id AS issue_id')) return [];
    if (text.includes('FROM issue_reports ir')) return issues(rows);
    if (text.includes('FROM inspection_logs il')) return logs(rows);
    if (text.includes('SELECT DISTINCT i.vehicle_id') || text.includes('SELECT DISTINCT a.vehicle_id')) return [];
    if (text.includes('SELECT DISTINCT v.plate_number')) return [];
    if (text.includes('vehicle_maintenance m')) return rows.map((row) => ({ ...row, latest_mileage: null, earliest_mileage: null, last_service_mileage: null, last_tire_change_mileage: null }));
    return rows;
  };
  state.sql = (strings, ...values) => execute(strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, ''), values);
  state.sql.query = execute;
  return state;
}

async function request(path, state, query = {}, method = 'GET', body = {}) {
  const handler = await loadHandler(path, state);
  const res = response();
  await handler({ method, query, body, headers: {} }, res);
  return res;
}

test('owners see assigned vehicles across fleets, and pagination follows authorization', async () => {
  const state = fixture();
  const res = await request('api/vehicles.ts', state, { limit: '1', offset: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.vehicles.map((vehicle) => vehicle.id), [uuid(2)]);
  assert.equal(res.body.vehicles[0].fleet_id, 'fleet-b');
});

test('empty assignments grant zero vehicles, and requested fleets cannot widen access', async () => {
  for (const [assigned, query] of [[[], {}], [[uuid(1), uuid(2)], { fleetId: 'fleet-c' }]]) {
    const state = fixture(owner, assigned);
    const res = await request('api/vehicles.ts', state, query);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 0);
    assert.deepEqual(res.body.vehicles, []);
  }
});

test('owner inventory includes explicitly assigned inactive vehicles in counts, filters and details', async () => {
  for (const query of [{}, { search: 'SYNTHETIC-3' }, { fleetId: 'fleet-c' }, { search: 'SYNTHETIC-3', fleetId: 'fleet-c' }]) {
    const res = await request('api/vehicles.ts', fixture(owner, [uuid(1), uuid(3)]), query);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, Object.keys(query).length ? 1 : 2);
    const inactive = res.body.vehicles.find((vehicle) => vehicle.id === uuid(3));
    assert.ok(inactive);
    assert.equal(inactive.is_active, false);
    assert.equal(inactive.fleet_id, 'fleet-c');
  }
  const detail = await request('api/vehicles.ts', fixture(owner, [uuid(3)]), { id: uuid(3) });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.is_active, false);
  const unassigned = await request('api/vehicles.ts', fixture(), { search: 'SYNTHETIC-3' });
  assert.equal(unassigned.body.total, 0);
  assert.deepEqual(unassigned.body.vehicles, []);
});

test('admin, supervisor and driver inventory remains active-only despite client inactive overrides', async () => {
  for (const role of ['admin', 'supervisor', 'driver']) {
    const state = fixture({ ...owner, role, fleetId: role === 'admin' ? '' : 'fleet-c' });
    const res = await request('api/vehicles.ts', state, { includeInactive: 'true' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, role === 'admin' ? 2 : 0);
    assert.ok(res.body.vehicles.every((vehicle) => vehicle.is_active));
    assert.ok(!res.body.vehicles.some((vehicle) => vehicle.id === uuid(3)));
  }
});

test('access changes on the next request and a second owner has independent membership', async () => {
  const state = fixture();
  assert.equal((await request('api/vehicles.ts', state)).body.total, 2);
  state.assigned = [uuid(1)];
  assert.deepEqual((await request('api/vehicles.ts', state)).body.vehicles.map((row) => row.id), [uuid(1)]);
  const second = fixture({ ...owner, userId: SECOND_OWNER }, [uuid(2), uuid(3), uuid(4)]);
  assert.deepEqual((await request('api/vehicles.ts', second)).body.vehicles.map((row) => row.id), [uuid(2), uuid(3)]);
  assert.equal(state.queries.filter(({ text }) => text.includes('FROM user_vehicle_access')).length, 2);
});

test('all status, search, fleet and history query branches retain the owner allowlist', async () => {
  for (const fleetId of [undefined, 'fleet-a']) {
    for (const search of [undefined, 'SYNTHETIC']) {
      const query = { ...(fleetId ? { fleetId } : {}), ...(search ? { search } : {}) };
      assert.equal((await request('api/vehicles.ts', fixture(), query)).statusCode, 200);
      for (const status of [undefined, 'open']) {
        assert.equal((await request('api/issues.ts', fixture(), { ...query, ...(status ? { status } : {}) })).statusCode, 200);
      }
      const dates = { startDate: '2026-10-01', endDate: '2026-10-26' };
      assert.equal((await request('api/history.ts', fixture(), { ...query, ...dates })).statusCode, 200);
      assert.equal((await request('api/history.ts', fixture(), { ...query, outOfService: 'true' })).statusCode, 200);
    }
  }
});

test('vehicle, inspection and issue ID lookups return 404 outside the owner checklist', async () => {
  for (const [path, allowed, denied] of [
    ['api/vehicles.ts', uuid(2), uuid(3)],
    ['api/inspections/[id].ts', uuid(102), uuid(103)],
    ['api/issues/[id].ts', uuid(202), uuid(203)],
  ]) {
    assert.equal((await request(path, fixture(), { id: allowed })).statusCode, 200, path);
    const state = fixture();
    assert.equal((await request(path, state, { id: denied })).statusCode, 404, path);
    assert.equal(state.queries.length, 2, 'Denied IDs must not fetch related photos/results');
  }
  assert.equal((await request('api/inspections.ts', fixture(), { vehicleId: uuid(2) })).statusCode, 200);
  assert.equal((await request('api/inspections.ts', fixture(), { vehicleId: uuid(3) })).statusCode, 404);
});

test('dashboard, maintenance and telematics expose only assigned vehicles without owner writes', async () => {
  const dashboard = await request('api/dashboard.ts', fixture());
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.body.totalVehicles, 2);
  assert.deepEqual(dashboard.body.fleets.map((fleet) => fleet.fleetId), ['fleet-a', 'fleet-b']);
  const maintenance = await request('api/maintenance.ts', fixture());
  assert.equal(maintenance.statusCode, 200);
  assert.deepEqual(maintenance.body.vehicles.map((vehicle) => vehicle.vehicleId), [uuid(1), uuid(2)]);
  for (const path of ['api/unit-status.ts', 'api/dashboard.ts']) {
    const state = fixture();
    state.sheet = vehicles.map((vehicle) => ({ plateNumber: vehicle.plate_number, fleet: 'untrusted-sheet-fleet', gpsStatus: 'running' }));
    const res = await request(path, state);
    assert.equal(res.statusCode, 200, path);
    const rows = path.includes('dashboard') ? res.body.unitStatus.vehicles : res.body.vehicles;
    assert.deepEqual(rows.map((vehicle) => vehicle.plateNumber), ['SYNTHETIC-1', 'SYNTHETIC-2']);
    assert.deepEqual(rows.map((vehicle) => vehicle.fleet), ['fleet-a', 'fleet-b']);
    assert.equal(state.activityWrites, 0, 'Read-only owners cannot trigger telemetry database writes');
  }
});

test('owner mutation requests fail before SQL, uploads, notifications or audit writes', async () => {
  for (const [path, method] of [
    ['api/inspections.ts', 'POST'], ['api/inspections.ts', 'PUT'], ['api/inspections.ts', 'DELETE'],
    ['api/issues/[id].ts', 'PATCH'], ['api/issues/[id]/notify-vendor.ts', 'POST'],
    ['api/issues/import.ts', 'POST'], ['api/maintenance.ts', 'PUT'], ['api/upload.ts', 'POST'],
  ]) {
    const state = fixture();
    const res = await request(path, state, { id: uuid(201) }, method);
    assert.equal(res.statusCode, 403, `${method} ${path}`);
    assert.equal(state.queries.length, 0);
  }
});

test('driver and supervisor fleet restrictions remain authoritative', async () => {
  for (const role of ['driver', 'supervisor']) {
    const state = fixture({ ...owner, role, fleetId: 'fleet-a' });
    const res = await request('api/vehicles.ts', state, { fleetId: 'fleet-b' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.vehicles.map((vehicle) => vehicle.id), [uuid(1)]);
    assert.ok(!state.queries.some(({ text }) => text.includes('user_vehicle_access')));
    const denied = fixture({ ...owner, role });
    assert.equal((await request('api/vehicles.ts', denied)).statusCode, 403);
    assert.equal(denied.queries.length, 0);
  }
});

test('issue workbook exports apply the same vehicle allowlist', async () => {
  const state = fixture();
  const res = await request('api/issues/export.ts', state);
  assert.equal(res.statusCode, 200);
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  const contents = JSON.stringify(workbook.worksheets[0].getSheetValues());
  assert.match(contents, /SYNTHETIC-1/);
  assert.match(contents, /SYNTHETIC-2/);
  assert.doesNotMatch(contents, /SYNTHETIC-3|SYNTHETIC-4/);
});
