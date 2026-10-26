import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const apiSource = readFileSync(new URL('../api/inspections.ts', import.meta.url), 'utf8');
const editorSource = readFileSync(
  new URL('../app/(app)/vehicles/[id]/inspect.tsx', import.meta.url),
  'utf8',
);
const detailSource = readFileSync(
  new URL('../app/(app)/vehicles/[id]/index.tsx', import.meta.url),
  'utf8',
);
const vehicleMapSource = readFileSync(
  new URL('../components/VehicleMap.tsx', import.meta.url),
  'utf8',
);

function loadInspectionHandler(sqlCalls) {
  const output = ts.transpileModule(apiSource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    sqlCalls.push({ text, values });
    if (text.includes('SELECT fleet_id FROM vehicle_master')) {
      return [{ fleet_id: 'FLEET-1' }];
    }
    if (text.includes('SELECT il.*')) return [];
    throw new Error(`Unexpected SQL in test: ${text}`);
  };
  const fakeRequire = (specifier) => {
    if (specifier === '../lib/vehicle-access') return { getOwnerVehicleIds: async () => null };
    if (specifier === '@neondatabase/serverless') return { neon: () => sql };
    if (specifier === '../lib/api-auth') {
      return {
        verifyAuth: async () => ({
          companyId: 'company-1',
          fleetId: 'FLEET-1',
          role: 'driver',
          userId: 'user-1',
          username: 'driver',
        }),
      };
    }
    if (specifier === '../lib/email') return { sendInspectionFailEmail: async () => {} };
    if (specifier === '../lib/audit') return { logAudit: async () => {} };
    if (specifier === '../lib/inspection-validation') {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return {
        validateInspectionDate: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
        validateInspectionFrequency: (value) => ['daily', 'weekly', 'post_route'].includes(value),
        validateInspectionResults: (results) => {
          if (!Array.isArray(results) || results.length === 0) return 'At least one checklist result is required';
          const ids = new Set();
          for (const result of results) {
            if (!result || typeof result.checklistItemId !== 'string' || !uuid.test(result.checklistItemId)) return 'Invalid checklist result';
            if (ids.has(result.checklistItemId)) return 'Duplicate checklist item';
            ids.add(result.checklistItemId);
            if (result.result !== 'pass' && result.result !== 'fail') return 'Invalid checklist result';
            if (result.result === 'fail' && (!Array.isArray(result.photoUrls) || result.photoUrls.length === 0)) return 'A photo is required for every failed checklist item';
          }
          return null;
        },
        validateMileage: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
        validatePhotoUrls: (value) => value === undefined || (Array.isArray(value) && value.every((url) => typeof url === 'string')),
      };
    }
    throw new Error(`Unexpected import in test: ${specifier}`);
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', output)(
    fakeRequire,
    module,
    module.exports,
    process,
  );
  return module.exports.default;
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('GET inspections validates frequency and filters date, since, and latest queries', async (t) => {
  for (const invalidFrequency of ['monthly', '', ['daily', 'weekly']]) {
    const sqlCalls = [];
    const handler = loadInspectionHandler(sqlCalls);
    const res = responseRecorder();
    await handler(
      { method: 'GET', query: { vehicleId: 'vehicle-1', frequency: invalidFrequency } },
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Invalid frequency' });
    assert.equal(sqlCalls.length, 0);
  }

  const queryCases = [
    { frequency: 'daily', date: '2026-08-11' },
    { frequency: 'weekly', since: '2026-08-10' },
    { frequency: 'post_route' },
  ];
  for (const query of queryCases) {
    await t.test(`filters ${query.frequency}`, async () => {
      const sqlCalls = [];
      const handler = loadInspectionHandler(sqlCalls);
      const res = responseRecorder();
      await handler(
        { method: 'GET', query: { vehicleId: 'vehicle-1', ...query } },
        res,
      );

      assert.equal(res.statusCode, 200);
      const logQuery = sqlCalls.find(({ text }) => text.includes('SELECT il.*'));
      assert.ok(logQuery, 'inspection log query was not issued');
      assert.match(logQuery.text, /AND il\.frequency =/);
      assert.ok(logQuery.values.includes(query.frequency));
    });
  }
});

test('GET inspections remains backward compatible when frequency is omitted', async () => {
  const sqlCalls = [];
  const handler = loadInspectionHandler(sqlCalls);
  const res = responseRecorder();
  await handler(
    { method: 'GET', query: { vehicleId: 'vehicle-1', date: '2026-08-11' } },
    res,
  );

  assert.equal(res.statusCode, 200);
  const logQuery = sqlCalls.find(({ text }) => text.includes('SELECT il.*'));
  assert.ok(logQuery);
  assert.doesNotMatch(logQuery.text, /il\.frequency/);
});

test('inspection screens keep records isolated and rehydrate saved answers by item ID', () => {
  assert.match(editorSource, /&frequency=\$\{frequency\}/);
  assert.match(editorSource, /ci\.id === r\.checklist_item_id/);
  assert.doesNotMatch(editorSource, /ci\.item_name_(?:th|en) === r\.item_name_/);
  assert.match(editorSource, /requestId !== checklistRequestRef\.current/);
  assert.match(editorSource, /setActiveZone\(null\)/);
  assert.match(editorSource, /frequency !== 'post_route'/);
  assert.doesNotMatch(editorSource, /styles\.allPassRow/);
  assert.match(detailSource, /&frequency=daily/);
});

test('vehicle diagram controls render filtered checklist tabs instead of section jumps', () => {
  assert.match(editorSource, /activeZoneSections[\s\S]*checklistItems\.filter/);
  assert.match(editorSource, /onZonePress=\{\(zone\) => selectZone\(zone\)\}/);
  assert.match(editorSource, /onAllZonesPress=\{\(\) => selectZone\(null\)\}/);
  assert.match(editorSource, /scrollTo\(\{ y: 0, animated: false \}\)/);
  assert.match(editorSource, /ref=\{checklistScrollRef\}/);
  assert.match(vehicleMapSource, /accessibilityRole="tab"/);
  assert.match(vehicleMapSource, /accessibilityState=\{\{ selected:/);
  assert.match(vehicleMapSource, /allZonesLabel/);
  assert.doesNotMatch(editorSource, /current === zone \? null : zone/);
});
