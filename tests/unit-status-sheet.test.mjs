import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const [sheetSource, dashboardSource, unitStatusSource] = await Promise.all([
  readFile(new URL('../lib/unit-status-sheet.ts', import.meta.url), 'utf8'),
  readFile(new URL('../api/dashboard.ts', import.meta.url), 'utf8'),
  readFile(new URL('../api/unit-status.ts', import.meta.url), 'utf8'),
]);

// Execute the actual modules with isolated dependencies. Neither fetch nor SQL
// can reach a network or database, including the handlers' activity-log writes.
function loadModule(source, imports = {}, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), output)(
    (name) => {
      if (name in imports) return imports[name];
      throw new Error(`Unexpected import: ${name}`);
    }, module, module.exports, ...Object.values(globals),
  );
  return module.exports;
}

const NOW = Date.parse('2026-10-09T16:00:00Z'); // 23:00 in Bangkok.
const MINUTE = 60_000;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/synthetic-unit-status/edit?gid=42#gid=42';
class FixedDate extends Date { static now() { return NOW; } }
const isoAge = (age) => new Date(NOW - age).toISOString();
const headers = ['VehicleNo', 'Fleet', 'DriverName', 'Status', 'Ignition', 'Speed', 'LastFixTime', 'UpdatedAt'];
function csvFor(rows) {
  return [headers.join(','), ...rows.map((row) => headers.map((key) => row[key] ?? '').join(','))].join('\n');
}
function deviceRow(plate, status, ignition, age, extra = {}) {
  return { VehicleNo: plate, Fleet: 'sheet-fleet-is-stale', DriverName: 'Synthetic driver',
    Status: status, Ignition: ignition, Speed: ignition === 'ON' ? 25 : 0,
    LastFixTime: isoAge(age), UpdatedAt: isoAge(0), ...extra };
}
function sheetModule(csv) {
  const downloads = [];
  const sheet = loadModule(sheetSource, {}, {
    Date: FixedDate,
    fetch: async (url, options) => {
      downloads.push({ url, options });
      return { ok: true, text: async () => csv };
    },
  });
  return { sheet, downloads };
}
const { resolveDhlGpsStatus } = sheetModule('').sheet;

test('DHL OFF/Stop remains online at 59 and exactly 60 minutes, then expires', () => {
  for (const age of [0, 59 * MINUTE, 60 * MINUTE]) {
    assert.equal(resolveDhlGpsStatus({ status: 'Stop', ignition: 'OFF', lastFixTime: isoAge(age) }, NOW), 'stopped');
  }
  for (const age of [60 * MINUTE + 1, 61 * MINUTE, 24 * 60 * MINUTE]) {
    assert.equal(resolveDhlGpsStatus({ status: 'Stop', ignition: 'OFF', lastFixTime: isoAge(age) }, NOW), 'offline');
  }
});

test('new data after an earlier stop restarts the inactivity window', () => {
  const stopped = { status: 'Stop', ignition: 'OFF', lastFixTime: isoAge(90 * MINUTE) };
  assert.equal(resolveDhlGpsStatus(stopped, NOW), 'offline');
  assert.equal(resolveDhlGpsStatus({ ...stopped, lastFixTime: isoAge(2 * MINUTE) }, NOW), 'stopped');
  assert.equal(resolveDhlGpsStatus({ ...stopped, status: 'Running', ignition: 'ON', speed: 30,
    lastFixTime: isoAge(2 * MINUTE) }, NOW), 'running');
});

test('fresh Idle, Stop and Stopped are online; OFF overrides a running label', () => {
  for (const status of ['Idle', 'Stop', 'Stopped', ' idle ']) {
    assert.equal(resolveDhlGpsStatus({ status, ignition: 'ON', lastFixTime: isoAge(MINUTE) }, NOW), 'stopped');
  }
  for (const status of ['Running', 'Moving']) {
    assert.equal(resolveDhlGpsStatus({ status, ignition: 'ON', lastFixTime: isoAge(MINUTE) }, NOW), 'running');
    assert.equal(resolveDhlGpsStatus({ status, ignition: ' off ', lastFixTime: isoAge(MINUTE) }, NOW), 'stopped');
  }
});

test('a fresh packet resolves premature Offline/unknown labels using valid ignition and speed', () => {
  for (const status of ['Offline', 'unrecognized', '']) {
    assert.equal(resolveDhlGpsStatus({ status, ignition: 'ON', speed: 12, lastFixTime: isoAge(MINUTE) }, NOW), 'running');
    assert.equal(resolveDhlGpsStatus({ status, ignition: ' on ', speed: 0, lastFixTime: isoAge(MINUTE) }, NOW), 'stopped');
    assert.equal(resolveDhlGpsStatus({ status, ignition: 'OFF', speed: 12, lastFixTime: isoAge(MINUTE) }, NOW), 'stopped');
    for (const ignition of [undefined, '', 'invalid']) {
      assert.equal(resolveDhlGpsStatus({ status, ignition, speed: 12, lastFixTime: isoAge(MINUTE) }, NOW), 'offline');
    }
  }
});

test('stale Running, Stop, Idle and premature Offline packets are all offline', () => {
  for (const status of ['Running', 'Moving', 'Stop', 'Stopped', 'Idle', 'Offline']) {
    for (const ignition of ['ON', 'OFF']) {
      assert.equal(resolveDhlGpsStatus({ status, ignition, speed: 30,
        lastFixTime: isoAge(60 * MINUTE + 1) }, NOW), 'offline');
    }
  }
});

test('dotted and unzoned ISO device times use Bangkok while explicit offsets are preserved', () => {
  for (const lastFixTime of [
    '2026.10.09 22:00:00', '2026-10-09 22:00:00', '2026-10-09T22:00:00',
    '2026-10-09T15:00:00Z', '2026-10-09T22:00:00+07:00',
    '2026-10-09T11:00:00-04:00',
  ]) {
    assert.equal(resolveDhlGpsStatus({ status: 'Stop', ignition: 'OFF', lastFixTime }, NOW), 'stopped', lastFixTime);
    assert.equal(resolveDhlGpsStatus({ status: 'Stop', ignition: 'OFF', lastFixTime }, NOW + 1), 'offline', lastFixTime);
  }
});

test('missing, invalid calendar, invalid clock and future timestamps fail offline', () => {
  for (const lastFixTime of [undefined, '', 'not a time', '2026.13.09 22:00:00',
    '2026.02.30 22:00:00', '2026-10-09T25:00:00+07:00', isoAge(-1)]) {
    assert.equal(resolveDhlGpsStatus({ status: 'Running', ignition: 'ON', speed: 30,
      lastFixTime }, NOW), 'offline', String(lastFixTime));
  }
});

async function fetchRows(rows, options) {
  const harness = sheetModule(csvFor(rows));
  const queries = [];
  const sql = async (strings, ...values) => {
    queries.push({ text: strings.join('?'), values });
    return [{ value: SHEET_URL }];
  };
  const vehicles = await harness.sheet.fetchSheetVehicles(sql, 'synthetic-company', options);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, ['synthetic-company']);
  assert.match(queries[0].text, /company_id =/);
  assert.deepEqual(harness.downloads, [{
    url: 'https://docs.google.com/spreadsheets/d/synthetic-unit-status/export?format=csv&gid=42',
    options: { redirect: 'follow' },
  }]);
  return vehicles;
}

test('DHL fetch uses LastFixTime; a fresh UpdatedAt cannot revive stale/missing device data', async () => {
  const vehicles = await fetchRows([
    deviceRow('STOP-BOUNDARY', 'Stop', 'OFF', 60 * MINUTE),
    deviceRow('STOP-STALE', 'Stop', 'OFF', 60 * MINUTE + 1),
    deviceRow('IDLE-FRESH', 'Idle', 'ON', MINUTE, { Speed: 0 }),
    deviceRow('NO-FIX', 'Running', 'ON', 0, { LastFixTime: '' }),
  ], { companySlug: 'dhl', now: NOW });
  assert.deepEqual(vehicles.map((v) => [v.plateNumber, v.gpsStatus]), [
    ['STOP-BOUNDARY', 'stopped'], ['STOP-STALE', 'offline'], ['IDLE-FRESH', 'stopped'], ['NO-FIX', 'offline'],
  ]);
});

test('DHL duplicate plates prefer the latest valid device report, then status on time ties', async () => {
  const vehicles = await fetchRows([
    deviceRow('LATEST', 'Running', 'ON', 20 * MINUTE),
    deviceRow('LATEST', 'Stop', 'OFF', MINUTE),
    deviceRow('VALID', 'Running', 'ON', 0, { LastFixTime: 'invalid' }),
    deviceRow('VALID', 'Stop', 'OFF', 90 * MINUTE),
    deviceRow('FUTURE', 'Running', 'ON', -MINUTE),
    deviceRow('FUTURE', 'Stop', 'OFF', MINUTE),
    deviceRow('TIE', 'Stop', 'OFF', MINUTE),
    deviceRow('TIE', 'Running', 'ON', MINUTE),
  ], { companySlug: 'dhl', now: NOW });
  assert.equal(vehicles.length, 4);
  const byPlate = new Map(vehicles.map((v) => [v.plateNumber, v]));
  assert.equal(byPlate.get('LATEST').gpsStatus, 'stopped');
  assert.equal(byPlate.get('LATEST').lastFixTime, isoAge(MINUTE));
  assert.equal(byPlate.get('VALID').lastFixTime, isoAge(90 * MINUTE));
  assert.equal(byPlate.get('FUTURE').lastFixTime, isoAge(MINUTE));
  assert.equal(byPlate.get('TIE').gpsStatus, 'running');
});

test('other tenants and omitted tenant options retain legacy status and duplicate priority', async () => {
  const rows = [deviceRow('LEGACY', 'Running', 'ON', 120 * MINUTE),
    deviceRow('LEGACY', 'Stop', 'OFF', MINUTE), deviceRow('IDLE', 'Idle', 'ON', MINUTE)];
  for (const options of [undefined, { companySlug: 'other', now: NOW }]) {
    const vehicles = await fetchRows(rows, options);
    assert.deepEqual(vehicles.map((v) => [v.plateNumber, v.gpsStatus]), [['LEGACY', 'running'], ['IDLE', 'offline']]);
    assert.equal(vehicles[0].lastFixTime, isoAge(120 * MINUTE));
  }
});

const admin = { role: 'admin', fleetId: null, companyId: 'company-synthetic', companySlug: 'dhl' };
const companyVehicles = [
  { id: 'run', plate_number: 'RUN', fleet_id: 'fleet-alpha' },
  { id: 'boundary', plate_number: 'BOUNDARY', fleet_id: 'fleet-alpha' },
  { id: 'stale', plate_number: 'STALE', fleet_id: 'fleet-alpha' },
  { id: 'idle', plate_number: 'IDLE', fleet_id: 'fleet-alpha' },
  { id: 'premature', plate_number: 'PREMATURE', fleet_id: 'fleet-alpha' },
  { id: 'missing', plate_number: 'MISSING', fleet_id: 'fleet-alpha' },
  { id: 'complete', plate_number: 'COMPLETE', fleet_id: 'fleet-alpha' },
  { id: 'beta', plate_number: 'BETA', fleet_id: 'fleet-beta' },
].map((vehicle) => ({ ...vehicle, vehicle_type: 'car', company_id: admin.companyId }));
const foreignVehicle = { id: 'foreign', plate_number: 'FOREIGN', fleet_id: 'fleet-alpha',
  vehicle_type: 'car', company_id: 'other-company' };
const integrationCsv = csvFor([
  deviceRow('RUN', 'Running', 'ON', MINUTE, { Fleet: 'fleet-beta' }),
  deviceRow('BOUNDARY', 'Stop', 'OFF', 60 * MINUTE),
  deviceRow('STALE', 'Stop', 'OFF', 60 * MINUTE + 1),
  deviceRow('IDLE', 'Idle', 'ON', MINUTE, { Speed: 0 }),
  deviceRow('PREMATURE', 'Offline', 'ON', MINUTE, { Speed: 0 }),
  deviceRow('MISSING', 'Running', 'ON', 0, { LastFixTime: '' }),
  deviceRow('COMPLETE', 'Running', 'ON', MINUTE),
  deviceRow('BETA', 'Stop', 'OFF', MINUTE, { Fleet: 'fleet-alpha' }),
  deviceRow('FOREIGN', 'Running', 'ON', MINUTE),
]);

async function request(endpoint, user = admin, query = {}) {
  const calls = [];
  const activityPlates = [];
  const harness = sheetModule(integrationCsv);
  const selectedFleet = user?.role === 'admin' ? query.fleetId || null : user?.fleetId || null;
  const scoped = companyVehicles.filter((v) => v.company_id === user?.companyId &&
    (!selectedFleet || v.fleet_id === selectedFleet));
  const inspected = scoped.filter((v) => ['complete', 'stale'].includes(v.id));
  const sql = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    assert.ok(values.includes(user.companyId), `query must bind JWT company: ${text}`);
    if (text.includes('::text IS NULL OR')) {
      assert.deepEqual(values.slice(-2), [selectedFleet, selectedFleet], 'DB queries must bind the effective fleet');
    }
    if (text.includes('FROM app_settings')) return [{ value: SHEET_URL }];
    if (text.startsWith('INSERT INTO vehicle_activity_log')) {
      assert.match(text, /WHERE v\.company_id =/);
      const online = values.find(Array.isArray);
      assert.ok(online, 'activity write must contain the online plate set');
      const effective = [...companyVehicles, foreignVehicle]
        .filter((v) => v.company_id === user.companyId && online.includes(v.plate_number));
      activityPlates.push(...effective.map((v) => v.plate_number));
      return [];
    }
    if (text.includes('FROM vehicle_activity_log a')) return [];
    if (text.includes('FROM issue_reports ir')) return text.includes('COUNT(') ? [{ total: 0, today: 0 }] : [];
    if (text.includes('FROM inspection_logs il')) return [{ total: 0, today: 0 }];
    if (text.includes('FROM inspection_logs i')) {
      if (text.includes('GROUP BY v.fleet_id')) return [];
      const weekly = text.includes("i.frequency = 'weekly'");
      const byPlate = text.includes('SELECT DISTINCT v.plate_number');
      return inspected.flatMap((v) => {
        const ref = byPlate ? { plate_number: v.plate_number } : { vehicle_id: v.id, vehicle_type: v.vehicle_type };
        return weekly ? [ref] : ['daily', 'post_route'].map((frequency) => ({ ...ref, frequency }));
      });
    }
    if (text.includes('FROM vehicle_master')) {
      if (text.includes('GROUP BY fleet_id')) {
        const groups = new Map();
        for (const v of scoped) groups.set(v.fleet_id, (groups.get(v.fleet_id) ?? 0) + 1);
        return [...groups].map(([fleet_id, total]) => ({ fleet_id, total }));
      }
      return scoped;
    }
    throw new Error(`Unexpected SQL: ${text}`);
  };
  const handler = loadModule(endpoint === 'dashboard' ? dashboardSource : unitStatusSource, {
    '@neondatabase/serverless': { neon: () => sql },
    '../lib/api-auth': { verifyAuth: async () => user },
    '../lib/thai-date': { getTodayThai: () => '2026-10-09', getMondayOfWeekThai: () => '2026-10-05' },
    '../lib/unit-status-sheet': harness.sheet,
  }, { process: { env: { DATABASE_URL: 'synthetic-do-not-connect' } } }).default;
  const res = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: 'GET', query }, res);
  return { res, calls, activityPlates, downloads: harness.downloads };
}

test('dashboard and Unit Status share DHL counters, Active membership and needsAttention', async () => {
  const dashboard = await request('dashboard');
  const unit = await request('unit-status');
  assert.equal(dashboard.res.statusCode, 200);
  assert.equal(unit.res.statusCode, 200);
  const dashboardUnits = dashboard.res.body.unitStatus;
  assert.deepEqual(dashboardUnits, unit.res.body);
  assert.deepEqual(dashboardUnits.summary, { total: 8, running: 2, stopped: 4, offline: 2, needsAttention: 5 });
  assert.equal(dashboard.res.body.active.checked, 6);
  assert.equal(dashboard.res.body.active.total, 8);
  assert.equal(dashboard.res.body.preDeparture.checked, 1, 'completed offline units must not enter Active completion');
  assert.equal(dashboard.res.body.preDeparture.total, 6);
  assert.equal(dashboard.res.body.weekly.checked, 1);
  assert.equal(dashboard.res.body.weekly.total, 6);
  const byPlate = new Map(unit.res.body.vehicles.map((v) => [v.plateNumber, v]));
  assert.equal(byPlate.get('BOUNDARY').needsAttention, true);
  assert.equal(byPlate.get('IDLE').needsAttention, true);
  assert.equal(byPlate.get('STALE').needsAttention, false);
  assert.equal(byPlate.get('MISSING').needsAttention, false);
  assert.equal(byPlate.get('COMPLETE').needsAttention, false);
  assert.equal(byPlate.get('RUN').fleet, 'fleet-alpha', 'DB membership must override incorrect sheet fleet');
  assert.equal(byPlate.has('FOREIGN'), false);
  for (const result of [dashboard, unit]) {
    assert.equal(result.downloads.length, 1, 'each handler must use one shared snapshot');
    assert.deepEqual(result.activityPlates.sort(), ['BETA', 'BOUNDARY', 'COMPLETE', 'IDLE', 'PREMATURE', 'RUN']);
  }
});

test('admin selection and a supervisor JWT fleet constrain both endpoints using database membership', async () => {
  const supervisor = { ...admin, role: 'supervisor', fleetId: 'fleet-alpha' };
  for (const [user, query] of [[admin, { fleetId: 'fleet-alpha' }], [supervisor, { fleetId: 'fleet-beta' }]]) {
    const dashboard = await request('dashboard', user, query);
    const unit = await request('unit-status', user, query);
    assert.equal(dashboard.res.statusCode, 200);
    assert.equal(unit.res.statusCode, 200);
    assert.deepEqual(dashboard.res.body.unitStatus, unit.res.body);
    assert.deepEqual(unit.res.body.summary, { total: 7, running: 2, stopped: 3, offline: 2, needsAttention: 4 });
    assert.equal(dashboard.res.body.fleetId, 'fleet-alpha');
    assert.equal(dashboard.res.body.active.checked, 5);
    assert.equal(dashboard.res.body.active.total, 7);
    assert.ok(unit.res.body.vehicles.every((v) => v.fleet === 'fleet-alpha'));
    assert.ok(unit.res.body.vehicles.some((v) => v.plateNumber === 'RUN'));
    assert.ok(unit.res.body.vehicles.every((v) => !['BETA', 'FOREIGN'].includes(v.plateNumber)));
  }
});

test('both handlers preserve legacy classification when the JWT belongs to another tenant', async () => {
  const user = { ...admin, companySlug: 'other' };
  const dashboard = await request('dashboard', user);
  const unit = await request('unit-status', user);
  assert.equal(dashboard.res.statusCode, 200);
  assert.equal(unit.res.statusCode, 200);
  assert.deepEqual(dashboard.res.body.unitStatus, unit.res.body);
  assert.deepEqual(unit.res.body.summary, { total: 8, running: 3, stopped: 3, offline: 2, needsAttention: 4 });
  assert.equal(dashboard.res.body.active.checked, 6);
  const byPlate = new Map(unit.res.body.vehicles.map((v) => [v.plateNumber, v.gpsStatus]));
  assert.equal(byPlate.get('STALE'), 'stopped');
  assert.equal(byPlate.get('MISSING'), 'running');
  assert.equal(byPlate.get('IDLE'), 'offline');
  assert.equal(byPlate.get('PREMATURE'), 'offline');
});

test('missing supervisor fleet fails closed in both endpoints before any SQL or sheet fetch', async () => {
  for (const endpoint of ['dashboard', 'unit-status']) {
    const result = await request(endpoint, { ...admin, role: 'supervisor', fleetId: null });
    assert.equal(result.res.statusCode, 403);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.downloads, []);
  }
});
