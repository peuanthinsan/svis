import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../api/history.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

const supervisor = { role: 'supervisor', fleetId: 'fleet-alpha', companyId: 'company-one' };
const admin = { ...supervisor, role: 'admin' };
const today = '2026-10-09';
const older = '2026-10-08';

function vehicle(id, overrides = {}) {
  return { id, company_id: supervisor.companyId, fleet_id: supervisor.fleetId,
    plate_number: `PLATE-${id}`, vehicle_type: 'car', is_active: true, ...overrides };
}

function inspection(id, vehicleId, usable, overrides = {}) {
  return { id, vehicle_id: vehicleId, company_id: supervisor.companyId,
    fleet_id: supervisor.fleetId, inspection_date: older,
    created_at: `${older}T08:00:00Z`, vehicle_usable: usable,
    overall_status: 'fail', inspector_name: 'Inspector', ...overrides };
}

// This fixture double models PostgreSQL membership; it does not execute SQL.
// Structural assertions below independently constrain the emitted query to put
// latest-answer selection before false/date/search/pagination and to share counts.
function fixtureResult(text, values, fixtures) {
  const latest = text.match(/WITH latest_answered AS \(([\s\S]*?)\), filtered AS/)[1];
  const filtered = text.match(/\), filtered AS \(([\s\S]*?)\), paged AS/)[1];
  assert.match(latest, /SELECT DISTINCT ON \(il\.vehicle_id\)/);
  assert.match(latest, /il\.vehicle_usable IS NOT NULL/);
  assert.match(latest, /il\.company_id = \?/);
  assert.match(latest, /vm\.company_id = \?/);
  assert.match(latest, /vm\.is_active/);
  assert.match(latest, /\?::text IS NULL OR vm\.fleet_id = \?/);
  assert.match(latest, /ORDER BY il\.vehicle_id, il\.inspection_date DESC, il\.created_at DESC\s*$/);
  assert.doesNotMatch(latest, /vehicle_usable = false|inspection_date >=|inspection_date <=|ILIKE|LIMIT|OFFSET/);
  assert.match(filtered, /FROM latest_answered\s+WHERE vehicle_usable = false/);
  assert.match(filtered, /inspection_date >= \?::date/);
  assert.match(filtered, /inspection_date <= \?::date/);
  assert.match(filtered, /plate_number ILIKE \?/);
  assert.match(text, /SELECT \* FROM filtered\s+ORDER BY inspection_date DESC, created_at DESC, id DESC\s+LIMIT \? OFFSET \?/);
  assert.match(text, /COUNT\(\*\)::int AS total/);
  assert.match(text, /COUNT\(\*\) FILTER \(WHERE overall_status = 'pass'\)::int AS passed/);
  assert.match(text, /COUNT\(\*\) FILTER \(WHERE overall_status = 'fail'\)::int AS failed/);
  assert.match(text, /json_agg\(paged ORDER BY inspection_date DESC, created_at DESC, id DESC\)/);
  assert.match(text, /FROM paged\), '\[\]'::json\) AS inspections\s+FROM filtered/);
  assert.equal(values.length, 12);
  const [company, vehicleCompany, fleet, fleetMatch, from, fromMatch, to, toMatch, search, pattern, limit, offset] = values;
  assert.equal(company, vehicleCompany);
  assert.equal(fleet, fleetMatch);
  assert.equal(from, fromMatch);
  assert.equal(to, toMatch);
  assert.equal(pattern, `%${search || ''}%`);
  const vehicles = new Map(fixtures.vehicles
    .filter((v) => v.is_active && v.company_id === vehicleCompany && (!fleet || v.fleet_id === fleet))
    .map((v) => [v.id, v]));
  const byLatestAnswer = (a, b) => b.inspection_date.localeCompare(a.inspection_date)
    || b.created_at.localeCompare(a.created_at);
  const byNewest = (a, b) => byLatestAnswer(a, b) || b.id.localeCompare(a.id);
  const latestAnswers = new Map();
  for (const row of [...fixtures.inspections].sort(byLatestAnswer)) {
    if (row.company_id !== company || row.vehicle_usable == null || !vehicles.has(row.vehicle_id)) continue;
    if (!latestAnswers.has(row.vehicle_id)) latestAnswers.set(row.vehicle_id, row);
  }
  const members = [...latestAnswers.values()].filter((row) => row.vehicle_usable === false
    && (!from || row.inspection_date >= from) && (!to || row.inspection_date <= to)
    && (!search || vehicles.get(row.vehicle_id).plate_number.toLowerCase().includes(search.toLowerCase())))
    .sort(byNewest);
  return [{ total: members.length,
    passed: members.filter((row) => row.overall_status === 'pass').length,
    failed: members.filter((row) => row.overall_status === 'fail').length,
    inspections: members.slice(offset, offset + limit).map((row) => ({ ...row,
      plate_number: vehicles.get(row.vehicle_id).plate_number,
      vehicle_type: vehicles.get(row.vehicle_id).vehicle_type,
      current_fleet_id: vehicles.get(row.vehicle_id).fleet_id,
    })),
  }];
}

async function request(query = {}, { user = supervisor, method = 'GET', fixtures = {
  vehicles: [vehicle('old-oos')], inspections: [inspection('old-no', 'old-oos', false)],
}, databaseError = false } = {}) {
  const calls = [];
  let connections = 0;
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (databaseError) throw new Error('Synthetic query failure');
    if (text.includes('WITH latest_answered')) return fixtureResult(text, values, fixtures);
    if (text.includes('COUNT(*)::int as total')) return [{ total: 3, passed: 2, failed: 1 }];
    return [{ id: 'ordinary-history', fleet_id: 'historical-fleet' }];
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', 'console', compiled)(
    (name) => {
      if (name === '@neondatabase/serverless') return { neon: () => { connections += 1; return sql; } };
      if (name === '../lib/api-auth') return { verifyAuth: async () => user };
      throw new Error(`Unexpected import: ${name}`);
    }, module, module.exports, { env: { DATABASE_URL: 'synthetic://local-fixture' } }, { error() {} },
  );
  const res = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await module.exports.default({ method, query }, res);
  return { res, calls, connections };
}

test('Total includes an older current No while Today has no records, matching the screenshot', async () => {
  const total = await request({ outOfService: 'true' });
  assert.equal(total.res.statusCode, 200);
  assert.equal(total.res.body.total, 1);
  assert.equal(total.res.body.failed, 1);
  assert.equal(total.res.body.passed, 0);
  assert.equal(total.res.body.inspections[0].id, 'old-no');
  assert.equal(total.calls.length, 1);
  assert.deepEqual(total.calls[0].values.slice(4, 8), [null, null, null, null]);
  const daily = await request({ outOfService: 'true', startDate: today, endDate: today });
  assert.equal(daily.res.statusCode, 200);
  assert.deepEqual(daily.res.body, { total: 0, passed: 0, failed: 0, inspections: [] });
});

test('Latest answered No survives null answers; repaired and inactive vehicles disappear', async () => {
  const fixtures = {
    vehicles: [vehicle('unanswered'), vehicle('repaired'), vehicle('inactive', { is_active: false })],
    inspections: [inspection('null-new', 'unanswered', null, { inspection_date: today }),
      inspection('unanswered-no', 'unanswered', false),
      inspection('repaired-no', 'repaired', false),
      inspection('repaired-yes', 'repaired', true, { inspection_date: today }),
      inspection('inactive-no', 'inactive', false)],
  };
  const total = await request({ outOfService: 'true' }, { fixtures });
  assert.equal(total.res.statusCode, 200);
  assert.equal(total.res.body.total, 1);
  assert.deepEqual(total.res.body.inspections.map((row) => row.id), ['unanswered-no']);
  const oldRange = await request({ outOfService: 'true', startDate: older, endDate: older }, { fixtures });
  assert.deepEqual(oldRange.res.body.inspections.map((row) => row.id), ['unanswered-no']);
});

test('JWT company and current fleet constrain membership, regardless of historic inspection fleet', async () => {
  const fixtures = {
    vehicles: [vehicle('moved-in'), vehicle('moved-out', { fleet_id: 'fleet-beta' }),
      vehicle('foreign', { company_id: 'company-two' }), vehicle('foreign-log')],
    inspections: [inspection('in-no', 'moved-in', false, { fleet_id: 'fleet-beta' }),
      inspection('out-no', 'moved-out', false), inspection('foreign-no', 'foreign', false),
      inspection('foreign-log-no', 'foreign-log', false, { company_id: 'company-two' })],
  };
  const result = await request({ outOfService: 'true', fleetId: 'fleet-beta' }, { fixtures });
  assert.equal(result.res.body.total, 1);
  assert.deepEqual(result.res.body.inspections.map((row) => row.id), ['in-no']);
  assert.equal(result.res.body.inspections[0].fleet_id, 'fleet-alpha');
  assert.equal(result.res.body.inspections[0].plate_number, 'PLATE-moved-in');
  assert.equal(result.res.body.inspections[0].vehicle_type, 'car');
  assert.ok(!('current_fleet_id' in result.res.body.inspections[0]));
  assert.deepEqual(result.calls[0].values.slice(0, 4), ['company-one', 'company-one', 'fleet-alpha', 'fleet-alpha']);
});

test('Admins can view all current fleets or explicitly select one within their company', async () => {
  const fixtures = { vehicles: [vehicle('alpha'), vehicle('beta', { fleet_id: 'fleet-beta' })],
    inspections: [inspection('alpha-no', 'alpha', false), inspection('beta-no', 'beta', false)] };
  const all = await request({ outOfService: 'true' }, { user: admin, fixtures });
  assert.equal(all.res.body.total, 2);
  assert.deepEqual(all.calls[0].values.slice(2, 4), [null, null]);
  const beta = await request({ outOfService: 'true', fleetId: 'fleet-beta' }, { user: admin, fixtures });
  assert.equal(beta.res.body.total, 1);
  assert.equal(beta.res.body.inspections[0].id, 'beta-no');
  assert.equal(beta.res.body.inspections[0].fleet_id, 'fleet-beta');
});

test('Latest answer uses inspection date before created time, matching the dashboard', async () => {
  const fixtures = { vehicles: [vehicle('date-order'), vehicle('time-order'), vehicle('current-no')],
    inspections: [
      inspection('date-yes', 'date-order', true, { inspection_date: today, created_at: `${older}T00:00:00Z` }),
      inspection('date-no', 'date-order', false, { created_at: `${today}T23:59:00Z` }),
      inspection('time-no', 'time-order', false),
      inspection('time-yes', 'time-order', true, { created_at: `${older}T09:00:00Z` }),
      inspection('current-no', 'current-no', false),
    ] };
  const result = await request({ outOfService: 'true' }, { fixtures });
  assert.equal(result.res.body.total, 1);
  assert.equal(result.res.body.inspections[0].id, 'current-no');
});

test('Search and pagination preserve filtered counts and stable ordering across pages', async () => {
  const fixtures = {
    vehicles: [vehicle('a', { plate_number: '70-VAN-A' }), vehicle('b', { plate_number: '70-VAN-B' }),
      vehicle('c', { plate_number: '70-VAN-C' }), vehicle('other', { plate_number: 'OTHER' })],
    inspections: [inspection('a-no', 'a', false, { overall_status: 'pass' }),
      inspection('b-no', 'b', false), inspection('c-no', 'c', false), inspection('other-no', 'other', false)],
  };
  const first = await request({ outOfService: 'true', search: '  van  ', limit: '1', offset: '0' }, { fixtures });
  const next = await request({ outOfService: 'true', search: 'van', limit: '1', offset: '1' }, { fixtures });
  assert.equal(first.res.body.total, 3);
  assert.equal(first.res.body.passed, 1);
  assert.equal(first.res.body.failed, 2);
  assert.equal(first.res.body.inspections[0].id, 'c-no');
  assert.equal(next.res.body.total, 3);
  assert.equal(next.res.body.inspections[0].id, 'b-no');
  assert.deepEqual(first.calls[0].values.slice(8), ['van', '%van%', 1, 0]);
  const beyond = await request({ outOfService: 'true', search: 'van', limit: '1', offset: '10' }, { fixtures });
  assert.equal(beyond.res.body.total, 3);
  assert.deepEqual(beyond.res.body.inspections, []);
});

test('Search remains a bound parameter, and limit/offset retain existing bounds', async () => {
  const search = "PLATE' OR 1=1 --";
  const result = await request({ outOfService: 'true', search, limit: '9999', offset: '-2' });
  assert.equal(result.res.statusCode, 200);
  assert.ok(!result.calls[0].text.includes(search));
  assert.deepEqual(result.calls[0].values.slice(8), [search, `%${search}%`, 500, 0]);
  assert.equal(result.res.body.total, 0);
  const minimum = await request({ outOfService: 'true', limit: '-1', offset: 'bad' });
  assert.deepEqual(minimum.calls[0].values.slice(10), [1, 0]);
});

test('Partial, malformed, impossible and inverted ranges fail before opening SQL', async () => {
  const invalidRanges = [
    { startDate: today }, { endDate: today }, { startDate: '', endDate: '' },
    { startDate: '10/09/2026', endDate: today }, { startDate: [today], endDate: today },
    { startDate: '2026-02-30', endDate: today }, { startDate: '0000-01-01', endDate: today },
    { startDate: today, endDate: older },
  ];
  for (const range of invalidRanges) {
    for (const outOfService of [undefined, 'true']) {
      const result = await request({ ...range, outOfService });
      assert.equal(result.res.statusCode, 400, JSON.stringify({ ...range, outOfService }));
      assert.deepEqual(result.res.body, { error: 'Valid startDate and endDate required (YYYY-MM-DD)' });
      assert.equal(result.calls.length, 0);
      assert.equal(result.connections, 0);
    }
  }
  const leapDay = await request({ outOfService: 'true', startDate: '2024-02-29', endDate: today });
  assert.equal(leapDay.res.statusCode, 200);
});

test('Only the exact OOS flag permits both dates to be omitted', async () => {
  for (const outOfService of [undefined, 'false', 'TRUE', ['true']]) {
    const result = await request({ outOfService });
    assert.equal(result.res.statusCode, 400);
    assert.equal(result.connections, 0);
  }
});

test('Normal history retains its two queries, historical fleet scope and response shape', async () => {
  for (const user of [supervisor, admin]) {
    const result = await request({ startDate: older, endDate: today, search: ' ABC ',
      fleetId: 'fleet-beta', limit: '20', offset: '2' }, { user });
    assert.equal(result.res.statusCode, 200);
    assert.deepEqual(result.res.body, { total: 3, passed: 2, failed: 1,
      inspections: [{ id: 'ordinary-history', fleet_id: 'historical-fleet' }] });
    assert.equal(result.calls.length, 2);
    const fleet = user.role === 'admin' ? 'fleet-beta' : 'fleet-alpha';
    assert.match(result.calls[0].text, /AND il\.fleet_id = \?/);
    assert.match(result.calls[1].text, /AND fleet_id = \?/);
    assert.deepEqual(result.calls[0].values, [older, today, 'company-one', fleet, 'ABC', '%ABC%', 20, 2]);
    assert.deepEqual(result.calls[1].values, [older, today, 'company-one', fleet, 'ABC', '%ABC%']);
    assert.ok(result.calls.every(({ text }) => !text.includes('latest_answered')));
  }
  const companyWide = await request({ startDate: older, endDate: today }, { user: admin });
  assert.deepEqual(companyWide.calls[0].values, [older, today, 'company-one', null, '%%', 100, 0]);
  assert.deepEqual(companyWide.calls[1].values, [older, today, 'company-one', null, '%%']);
});

test('Authentication, fleet fail-closed, method and query failures retain API safeguards', async () => {
  for (const [options, status] of [
    [{ user: null }, 401], [{ user: { ...supervisor, fleetId: '' } }, 403], [{ method: 'POST' }, 405],
  ]) {
    const result = await request({ outOfService: 'true' }, options);
    assert.equal(result.res.statusCode, status);
    assert.equal(result.connections, 0);
    assert.equal(result.calls.length, 0);
  }
  const failure = await request({ outOfService: 'true' }, { databaseError: true });
  assert.equal(failure.res.statusCode, 500);
  assert.deepEqual(failure.res.body, { error: 'Internal server error' });
});
