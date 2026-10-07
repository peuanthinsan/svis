import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const apiSource = await readFile(new URL('../api/maintenance.ts', import.meta.url), 'utf8');
const rootRequire = createRequire(import.meta.url);
const React = rootRequire('react');
const { renderToStaticMarkup } = rootRequire('react-dom/server');

function loadModule(source, imports, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    esModuleInterop: true, module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
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

const supervisor = { role: 'supervisor', fleetId: 'fleet-alpha', companyId: 'test-company' };
const ownVehicle = { id: 'vehicle-1', fleet_id: 'fleet-alpha', company_id: 'test-company' };
const body = {
  vehicleId: 'vehicle-1', region: 'provincial',
  lastServiceDate: '2030-01-02', lastServiceMileage: 6543,
  lastTireChangeDate: '2029-06-01', lastTireChangeMileage: 0,
  lastBatteryChangeDate: '2029-03-15', taxExpiryDate: '2031-12-31',
};

async function request(user, vehicle = ownVehicle, method = 'PUT', query = {}, options = {}) {
  const calls = [];
  const committedWrites = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('SELECT id, fleet_id FROM vehicle_master')) {
      const result = vehicle && values.includes(vehicle.company_id) ? [{ ...vehicle }] : [];
      if (options.moveBeforeWrite === 1 && vehicle) vehicle = { ...vehicle, fleet_id: 'fleet-beta' };
      return result;
    }
    if (/UPDATE vehicle_master|INSERT INTO vehicle_maintenance/.test(text)) {
      const writeNumber = calls.filter(({ text }) => /UPDATE vehicle_master|INSERT INTO vehicle_maintenance/.test(text)).length;
      if (options.moveBeforeWrite === writeNumber && vehicle) vehicle = { ...vehicle, fleet_id: 'fleet-beta' };
      assert.match(text, /fleet_id =/);
      const visible = vehicle && values.includes(vehicle.company_id)
        && (user.role === 'admin' || values.includes(vehicle.fleet_id));
      if (!visible || options.maintenanceCompanyMismatch && text.includes('INSERT INTO vehicle_maintenance')) return [];
      committedWrites.push({ text, values });
      return [{ id: vehicle.id, vehicle_id: vehicle.id }];
    }
    if (text.includes('FROM vehicle_master v')) return [];
    return [];
  };
  const handler = loadModule(apiSource, {
    '@neondatabase/serverless': { neon: () => sql },
    '../lib/api-auth': { verifyAuth: async () => user },
    '../lib/thai-date': { getTodayThai: () => '2026-10-06' },
  }, { process }).default;
  const res = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ method, body, query }, res);
  return { res, calls, writes: calls.filter(({ text }) => /UPDATE |INSERT INTO /.test(text)), committedWrites };
}

test('Supervisor saves maintenance, region and tax for an own-fleet vehicle', async () => {
  const { res, calls, writes } = await request(supervisor);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(writes.length, 3);
  for (const write of writes) {
    assert.ok(write.values.includes(supervisor.companyId));
    assert.ok(write.values.includes(supervisor.fleetId));
    assert.match(write.text, /fleet_id =/);
  }
  assert.match(writes[2].text, /FOR UPDATE OF v/);
  assert.match(writes[2].text, /existing\.company_id = EXCLUDED\.company_id/);
  assert.ok(calls[0].values.includes(body.vehicleId));
  assert.ok(writes[2].values.includes(0));
  assert.ok(writes[2].values.includes(body.lastServiceDate));
  assert.ok(writes[0].values.includes(body.region));
  assert.ok(writes[1].values.includes(body.taxExpiryDate));
});

test('Supervisor saves stop when a vehicle moves fleets between the check and any write', async () => {
  for (const writeNumber of [1, 2, 3]) {
    const result = await request(supervisor, ownVehicle, 'PUT', {}, { moveBeforeWrite: writeNumber });
    assert.equal(result.res.statusCode, 403);
    assert.equal(result.writes.length, writeNumber);
    assert.equal(result.committedWrites.length, writeNumber - 1);
    assert.ok(result.writes.every(({ values }) => values.includes(supervisor.fleetId)));
  }
});

test('Maintenance upsert does not modify a conflicting company-owned baseline', async () => {
  const result = await request(supervisor, ownVehicle, 'PUT', {}, { maintenanceCompanyMismatch: true });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.committedWrites.length, 2);
  assert.match(result.writes[2].text, /existing\.company_id = EXCLUDED\.company_id/);
});

test('Supervisor cannot mutate another fleet or another company', async () => {
  const foreignFleet = await request(supervisor, { ...ownVehicle, fleet_id: 'fleet-beta' });
  assert.equal(foreignFleet.res.statusCode, 403);
  assert.equal(foreignFleet.writes.length, 0);
  const foreignCompany = await request(supervisor, { ...ownVehicle, company_id: 'other-company' });
  assert.equal(foreignCompany.res.statusCode, 404);
  assert.equal(foreignCompany.writes.length, 0);
});

test('Missing supervisor fleet, driver and unauthenticated saves never reach the database', async () => {
  for (const [user, status] of [[{ ...supervisor, fleetId: '' }, 403], [{ ...supervisor, role: 'driver' }, 403], [null, 401]]) {
    const result = await request(user);
    assert.equal(result.res.statusCode, status);
    assert.equal(result.calls.length, 0);
  }
});

test('Admin retains company-wide editing while missing vehicles return 404', async () => {
  const admin = await request({ ...supervisor, role: 'admin', fleetId: '' }, { ...ownVehicle, fleet_id: 'fleet-beta' });
  assert.equal(admin.res.statusCode, 200);
  assert.equal(admin.writes.length, 3);
  const missing = await request(supervisor, null);
  assert.equal(missing.res.statusCode, 404);
  assert.equal(missing.writes.length, 0);
});

test('Supervisor GET ignores requested fleet overrides and DELETE remains unavailable', async () => {
  const get = await request(supervisor, ownVehicle, 'GET', { fleetId: 'fleet-beta' });
  assert.equal(get.res.statusCode, 200);
  assert.ok(get.calls[0].values.includes('fleet-alpha'));
  assert.ok(get.calls[0].values.includes('test-company'));
  assert.ok(!get.calls[0].values.includes('fleet-beta'));
  const missingFleet = await request({ ...supervisor, fleetId: '' }, ownVehicle, 'GET');
  assert.equal(missingFleet.res.statusCode, 403);
  assert.equal(missingFleet.calls.length, 0);
  const remove = await request(supervisor, ownVehicle, 'DELETE');
  assert.equal(remove.res.statusCode, 405);
  assert.equal(remove.calls.length, 0);
});

const pageSource = await readFile(new URL('../web/src/pages/AdminPage.tsx', import.meta.url), 'utf8');
function renderAdminPage(role, savedTab) {
  const mounted = [];
  const imports = {
    react: React, 'react/jsx-runtime': rootRequire('react/jsx-runtime'),
    'react-router-dom': { useNavigate: () => () => {} },
    '../AuthContext': { useAuth: () => ({ user: role ? { role } : null }) },
    '../i18n': { t: (key) => key },
  };
  for (const name of ['Settings', 'Users', 'Vehicles', 'Fleets', 'Analytics', 'Checklist', 'IssuesMgmt', 'Maintenance']) {
    imports[`./admin/${name}Tab`] = { [`${name}Tab`]: () => {
      mounted.push(name);
      return React.createElement('div', null, name);
    } };
  }
  const { AdminPage } = loadModule(pageSource, imports, {
    localStorage: { getItem: () => savedTab, setItem: () => assert.fail('SSR must not write storage') },
  });
  return { html: renderToStaticMarkup(React.createElement(AdminPage)), mounted };
}

test('Supervisor opens only Maintenance even when storage remembers a privileged tab', () => {
  for (const savedTab of ['settings', 'users', 'vehicles', 'fleets', 'analytics', 'checklist', 'issues', 'maintenance']) {
    const { html, mounted } = renderAdminPage('supervisor', savedTab);
    assert.deepEqual(mounted, ['Maintenance']);
    assert.equal((html.match(/<button/g) || []).length, 1);
    assert.match(html, /aria-pressed="true"/);
    assert.doesNotMatch(html, /adminSettings|adminUsers|adminVehicles/);
  }
});

test('Admin retains the remembered tab and driver/anonymous render no Admin content', () => {
  const admin = renderAdminPage('admin', 'users');
  assert.deepEqual(admin.mounted, ['Users']);
  assert.equal((admin.html.match(/<button/g) || []).length, 8);
  for (const role of ['driver', null]) {
    assert.deepEqual(renderAdminPage(role, 'maintenance'), { html: '', mounted: [] });
  }
});

test('Bulk import and export remain protected by the unchanged Admin guard', async () => {
  const guardSource = await readFile(new URL('../lib/admin-auth.ts', import.meta.url), 'utf8');
  const { requireAdmin } = loadModule(guardSource, {
    './api-auth': { verifyAuth: async () => supervisor },
  });
  for (const file of ['import', 'export']) {
    const source = await readFile(new URL(`../api/admin/maintenance/${file}.ts`, import.meta.url), 'utf8');
    const handler = loadModule(source, {
      '@neondatabase/serverless': { neon: () => assert.fail('Supervisor cannot reach bulk SQL') },
      '../../../lib/admin-auth': { requireAdmin },
      '../../../lib/validate': { isDateString: () => true },
      exceljs: {},
    }).default;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
    await handler({ method: file === 'import' ? 'POST' : 'GET', body: { rows: [body] } }, res);
    assert.equal(res.statusCode, 403);
  }
});

test('Maintenance renders bulk controls only for Admins', async () => {
  const source = await readFile(new URL('../web/src/pages/admin/MaintenanceTab.tsx', import.meta.url), 'utf8');
  for (const role of ['supervisor', 'admin']) {
    const { MaintenanceTab } = loadModule(source, {
      react: React, 'react/jsx-runtime': rootRequire('react/jsx-runtime'),
      '../../AuthContext': { useAuth: () => ({ user: { role } }) },
      '../../api': { fetchMaintenance: () => assert.fail('SSR must not fetch') },
      '../../i18n': { t: (key) => key },
      '../../lib/format-date': { formatDateThai: (value) => value || '' },
      '../../maintenance-import': {},
    });
    const html = renderToStaticMarkup(React.createElement(MaintenanceTab));
    if (role === 'admin') {
      assert.match(html, /importFile/);
      assert.match(html, />export</);
      assert.match(html, /supportedImportColumns/);
    } else {
      assert.doesNotMatch(html, /importFile|>export<|supportedImportColumns|type="file"/);
    }
  }
});
