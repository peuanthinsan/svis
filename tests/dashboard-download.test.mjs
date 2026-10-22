import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const compiled = buildSync({
  entryPoints: [new URL('../web/src/api.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;

function client(response, token = 'fixture-session-token') {
  const requests = [];
  const navigations = [];
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    Headers, FormData, URL, URLSearchParams,
    localStorage: { getItem: () => token },
    window: {
      location: {
        origin: 'https://svis.songdeegps.com',
        assign: (url) => navigations.push(url),
      },
    },
    fetch: async (path, init) => {
      requests.push({ path, init });
      if (response instanceof Error) throw response;
      return response;
    },
  };
  vm.runInNewContext(compiled, sandbox);
  return { api: module.exports, requests, navigations };
}

function ticketResponse(downloadUrl = '/api/dashboard/export?downloadTicket=report-only-ticket') {
  return Response.json({ downloadUrl, expiresAt: '2026-10-22T10:05:00Z' });
}

test('dashboard export authenticates one JSON POST then navigates without fetching report bytes', async () => {
  const { api, requests, navigations } = client(ticketResponse());
  const params = new URLSearchParams({
    fleetId: 'FIXTURE-A', dateStart: '2026-10-01', dateEnd: '2026-10-22',
    companyId: 'not-client-controlled', token: 'must-not-be-forwarded',
  });
  await api.downloadDashboardExport(params);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/dashboard/export-ticket');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.get('Authorization'), 'Bearer fixture-session-token');
  assert.equal(requests[0].init.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    fleetId: 'FIXTURE-A', dateStart: '2026-10-01', dateEnd: '2026-10-22',
  });
  assert.deepEqual(navigations, ['/api/dashboard/export?downloadTicket=report-only-ticket']);
  assert.ok(!navigations[0].includes('fixture-session-token'));
});

test('all-time/all-fleets selection sends an empty filter object', async () => {
  const { api, requests } = client(ticketResponse());
  await api.downloadDashboardExport(new URLSearchParams());
  assert.deepEqual(JSON.parse(requests[0].init.body), {});
});

test('ticket creation failures never initiate a download', async () => {
  const { api, navigations } = client(Response.json({ error: 'Unauthorized' }, { status: 401 }));
  await assert.rejects(api.downloadDashboardExport(new URLSearchParams()), { status: 401 });
  assert.deepEqual(navigations, []);
});

test('a blocked ticket POST is exposed as a network failure without navigating', async () => {
  const error = new TypeError('Failed to fetch');
  const { api, navigations } = client(error);
  await assert.rejects(api.downloadDashboardExport(new URLSearchParams()), (caught) => caught === error);
  assert.deepEqual(navigations, []);
});

test('HTML proxy responses cannot become download links', async () => {
  const { api, navigations } = client(new Response('<html>Proxy authentication required</html>'));
  await assert.rejects(api.downloadDashboardExport(new URLSearchParams()), { status: 502 });
  assert.deepEqual(navigations, []);
});

test('only a same-origin export URL containing exactly one ticket is navigable', async () => {
  const invalidLinks = [
    'https://outside.invalid/api/dashboard/export?downloadTicket=x',
    '//outside.invalid/api/dashboard/export?downloadTicket=x',
    'https://user:password@svis.songdeegps.com/api/dashboard/export?downloadTicket=x',
    '/api/admin/users/export?downloadTicket=x',
    '/api/dashboard/export?downloadTicket=x&token=ordinary-session',
    '/api/dashboard/export?downloadTicket=x&fleetId=OTHER',
    '/api/dashboard/export?downloadTicket=x&downloadTicket=y',
    '/api/dashboard/export?downloadTicket=',
    '/api/dashboard/export?downloadTicket=x#fragment',
    'javascript:alert(1)',
    'https://[invalid',
    null,
  ];
  for (const link of invalidLinks) {
    const { api, navigations } = client(ticketResponse(link));
    await assert.rejects(api.downloadDashboardExport(new URLSearchParams()), { status: 502 }, String(link));
    assert.deepEqual(navigations, [], String(link));
  }
});
