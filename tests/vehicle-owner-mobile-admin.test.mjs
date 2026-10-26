import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(new URL('../package.json', import.meta.url));
const source = await readFile(new URL('../app/(app)/admin/users.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const native = { StyleSheet: { create: (styles) => styles } };
const colors = new Proxy({}, { get: () => '#111111' });
const imports = {
  'react-native': native,
  '@expo/vector-icons/Ionicons': () => null,
  '../../../constants/theme': { colors, spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 }, borderRadius: {}, shadows: {}, statusColors: { pass: { bg: '#eee', text: '#111' } } },
  '../../../lib/i18n-context': {},
  '../../../lib/api': { apiFetch: () => assert.fail('Tests must supply their own catalog fetcher') },
  '../../../lib/useDebounce': {},
};
const module = { exports: {} };
new Function('require', 'module', 'exports', output)((name) => Object.hasOwn(imports, name) ? imports[name] : require(name), module, module.exports);
const { loadMobileOwnerSelection, mobileOwnerSelectionCanSave, buildMobileUserPayload } = module.exports;

const vehicle = (id, changes = {}) => ({ id: String(id), plate_number: `synthetic-${id}`, fleet_id: 'Fleet A', vehicle_type: 'car', ...changes });
const form = { username: 'owner', firstName: 'Vehicle', lastName: 'Owner', role: 'vehicle_owner', fleetId: 'Old fleet', password: '' };

test('existing owner editor loads its complete catalog and preserves inactive vehicle selections', async () => {
  const catalog = [vehicle('one'), vehicle('two', { fleet_id: 'Fleet B', is_active: false })];
  const result = await loadMobileOwnerSelection({ id: 'owner-id', role: 'vehicle_owner' }, async (path) => {
    assert.equal(path, '/api/admin/users/owner-id/vehicles');
    return { vehicles: catalog, selectedVehicleIds: ['one', 'two'] };
  });
  assert.deepEqual(result, { vehicles: catalog, selectedVehicleIds: ['one', 'two'] });
});

test('new owners and role conversions fetch all 501 vehicles across page boundaries', async () => {
  for (const user of [null, { id: 'driver-id', role: 'driver' }]) {
    const requested = [];
    const catalog = Array.from({ length: 501 }, (_, index) => vehicle(index));
    const result = await loadMobileOwnerSelection(user, async (path) => {
      const url = new URL(path, 'https://synthetic.invalid');
      requested.push(path);
      assert.equal(url.pathname, '/api/admin/vehicles');
      assert.equal(url.searchParams.get('limit'), '500');
      const offset = Number(url.searchParams.get('offset'));
      return catalog.slice(offset, offset + 500);
    });
    assert.equal(result.vehicles.length, 501);
    assert.equal(requested.length, 2);
    assert.deepEqual(result.selectedVehicleIds, [], 'Conversion never grants vehicles just because they share a fleet');
  }
});

test('an exact full page is followed by an empty page instead of assuming the catalog is complete', async () => {
  let calls = 0;
  const result = await loadMobileOwnerSelection(null, async () => ++calls === 1 ? Array.from({ length: 500 }, (_, index) => vehicle(index)) : []);
  assert.equal(calls, 2);
  assert.equal(result.vehicles.length, 500);
});

test('invalid catalog responses and invisible selected IDs block the owner editor', async () => {
  for (const response of [
    null, {}, { vehicles: [], selectedVehicleIds: null },
    { vehicles: [], selectedVehicleIds: ['missing'] },
    { vehicles: [{ id: 'one' }], selectedVehicleIds: [] },
  ]) {
    await assert.rejects(loadMobileOwnerSelection({ id: 'owner-id', role: 'vehicle_owner' }, async () => response));
  }
  await assert.rejects(loadMobileOwnerSelection(null, async () => ({ error: 'Unavailable' })));
});

test('non-advancing pagination fails instead of silently truncating or looping', async () => {
  const page = Array.from({ length: 500 }, (_, index) => vehicle(index));
  let calls = 0;
  await assert.rejects(loadMobileOwnerSelection(null, async () => { calls++; return page; }), /pagination did not advance/);
  assert.equal(calls, 2);
});

test('superseded catalog loads stop after their current response and cannot return stale data', async () => {
  let current = true;
  let calls = 0;
  await assert.rejects(loadMobileOwnerSelection(null, async () => {
    calls++;
    current = false;
    return Array.from({ length: 500 }, (_, index) => vehicle(index));
  }, () => current), /superseded/);
  assert.equal(calls, 1);

  await assert.rejects(loadMobileOwnerSelection({ id: 'old-owner', role: 'vehicle_owner' }, async () => {
    current = false;
    return { vehicles: [vehicle('old')], selectedVehicleIds: ['old'] };
  }, () => current), /superseded/);
});

test('save stays unavailable until owner selection is ready and has no load error', () => {
  assert.equal(mobileOwnerSelectionCanSave('vehicle_owner', false, false, null), false);
  assert.equal(mobileOwnerSelectionCanSave('vehicle_owner', true, true, null), false);
  assert.equal(mobileOwnerSelectionCanSave('vehicle_owner', true, false, 'Load failed'), false);
  assert.equal(mobileOwnerSelectionCanSave('vehicle_owner', true, false, null), true);
  assert.equal(mobileOwnerSelectionCanSave('driver', false, false, null), true);
});

test('editing owner names preserves every loaded selection and submits fields and IDs together', () => {
  const selected = ['one', 'two'];
  const body = buildMobileUserPayload({ ...form, firstName: ' Updated ' }, selected, true);
  assert.deepEqual(body, { firstName: 'Updated', lastName: 'Owner', role: 'vehicle_owner', fleetId: '', vehicleIds: ['one', 'two'] });
  assert.notEqual(body.vehicleIds, selected, 'Payload has its own copy of the selected IDs');
  assert.ok(!Object.hasOwn(body, 'password'));
  assert.ok(!Object.hasOwn(body, 'username'));
});

test('new owners can explicitly select zero vehicles and non-owner roles never submit vehicleIds', () => {
  const created = buildMobileUserPayload({ ...form, password: 'synthetic-password' }, [], false);
  assert.deepEqual(created.vehicleIds, []);
  assert.equal(created.username, 'owner');
  assert.equal(created.password, 'synthetic-password');
  assert.equal(created.fleetId, '');
  const converted = buildMobileUserPayload({ ...form, role: 'supervisor', fleetId: ' Fleet B ' }, ['one'], true);
  assert.ok(!Object.hasOwn(converted, 'vehicleIds'));
  assert.equal(converted.fleetId, 'Fleet B');
});

test('corporate owner forms submit a customer name with an optional blank surname', () => {
  const body = buildMobileUserPayload({ ...form, firstName: ' Synthetic Leasing ', lastName: ' ', password: 'synthetic-password' }, ['one'], false);
  assert.equal(body.firstName, 'Synthetic Leasing');
  assert.equal(body.lastName, '');
  assert.equal(body.role, 'vehicle_owner');
  assert.deepEqual(body.vehicleIds, ['one']);
  assert.match(source, /role !== 'vehicle_owner' && !lastName\.trim\(\)/);
  assert.match(source, /'owner.customerName' : 'admin.users.firstName'/);
  assert.match(source, /'owner.optionalLastName' : 'admin.users.lastName'/);
});

test('screen wires checkbox accessibility, request-generation guards, localized role labels and save gating', () => {
  assert.match(source, /accessibilityRole="checkbox"/);
  assert.match(source, /accessibilityState=\{\{ checked: selected, disabled: saving \}\}/);
  assert.match(source, /ownerLoadGeneration\.current === generation/);
  assert.match(source, /if \(!isCurrent\(\)\) return/);
  assert.match(source, /disabled=\{saving \|\| !canSaveOwnerSelection\}/);
  assert.match(source, /t\('profile.vehicleOwner'\)/);
  assert.match(source, /t\('owner.noSelection'\)/);
  assert.match(source, /form\.role === 'vehicle_owner' \? \(/);
});
