import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { canAccessDashboard } from '../web/src/auth.ts';
import * as selection from '../web/src/owner-vehicle-selection.ts';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

test('owner plate preview matches exact records across fleets without changing vehicle data', () => {
  const vehicles = [
    { id: 'one', plate_number: 'ABC-101', fleet_id: 'NORTH' },
    { id: 'two', plate_number: 'กข-102', fleet_id: 'SOUTH' },
    { id: 'other', plate_number: 'ABC-1010', fleet_id: 'NORTH' },
  ];
  const before = structuredClone(vehicles);
  const preview = selection.previewOwnerPlates([' abc-101 ', 'กข-102', 'ABC-101'], vehicles);
  assert.deepEqual(preview.matches.map((match) => match.vehicleId), ['one', 'two']);
  assert.equal(preview.canApply, true);
  assert.deepEqual(preview.duplicates, ['ABC-101']);
  assert.deepEqual(vehicles, before);
});

test('unmatched, ambiguous, empty and partial plates cannot be silently applied', () => {
  const vehicles = [
    { id: 'a', plate_number: 'ALPHA-1' },
    { id: 'b', plate_number: ' alpha-1 ' },
    { id: 'c', plate_number: 'BETA-2' },
  ];
  const preview = selection.previewOwnerPlates(['ALPHA-1', 'BETA-2', 'MISSING', 'BETA'], vehicles);
  assert.equal(preview.canApply, false);
  assert.deepEqual(preview.ambiguous, ['ALPHA-1']);
  assert.deepEqual(preview.unmatched, ['MISSING', 'BETA']);
  assert.deepEqual(preview.matches, [{ plate: 'BETA-2', vehicleId: 'c' }]);
  assert.equal(selection.previewOwnerPlates([' ', ''], vehicles).canApply, false);
});

test('separate spreadsheet columns stay separate despite unequal lengths and blank cells', () => {
  const columns = selection.ownerPlateColumns([
    [],
    ['Customer A', 'Customer B', null],
    ['A-1', ' B-1 ', null],
    ['A-2', '', null],
    ['A-3', 'B-2', null],
  ]);
  assert.deepEqual(columns, [
    { label: 'Customer A', index: 0, plates: ['A-1', 'A-2', 'A-3'] },
    { label: 'Customer B', index: 1, plates: ['B-1', 'B-2'] },
  ]);
  assert.deepEqual(selection.parsePastedOwnerPlates(' A-1\r\nA-2\tA-3, A-4;; '), ['A-1', 'A-2', 'A-3', 'A-4']);
});

test('new-owner checklist fetches every vehicle page and fails rather than silently truncating repeated pages', async () => {
  const rows = Array.from({ length: 1042 }, (_, index) => ({ id: `vehicle-${index}` }));
  const calls = [];
  const loaded = await selection.loadCompleteVehicleCatalog(async ({ limit, offset }) => {
    calls.push({ limit, offset });
    return rows.slice(offset, offset + limit);
  });
  assert.equal(loaded.length, 1042);
  assert.deepEqual(loaded, rows);
  assert.deepEqual(calls, [{ limit: 500, offset: 0 }, { limit: 500, offset: 500 }, { limit: 500, offset: 1000 }]);
  await assert.rejects(selection.loadCompleteVehicleCatalog(async () => rows.slice(0, 500)), /Please retry/);
});

async function loadComponent(path, imports, extraExports = '') {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source.replace(/\bimport\.meta\.env\.BASE_URL\b/g, JSON.stringify('/')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const componentModule = { exports: {} };
  const shared = { react: React, 'react/jsx-runtime': webRequire('react/jsx-runtime') };
  new Function('require', 'module', 'exports', `${output}\n${extraExports}`)((name) => {
    if (name in imports) return imports[name];
    if (name in shared) return shared[name];
    throw new Error(`Unexpected import: ${name}`);
  }, componentModule, componentModule.exports);
  return componentModule.exports;
}

const language = { getLang: () => 'en', setLang: () => {}, t: (key, vars) => `${key}${vars ? ` ${Object.values(vars).join(' ')}` : ''}` };

test('owner gets dashboard, exports, issues and history navigation without write or administration links', async () => {
  const user = { role: 'vehicle_owner', firstName: 'Owner', companyName: 'Company' };
  const links = [];
  const redirects = [];
  const { Layout } = await loadComponent('../web/src/components/Layout.tsx', {
    'react-router-dom': {
      Navigate: ({ to }) => { redirects.push(to); return null; },
      NavLink: ({ to, children }) => { links.push(to); return React.createElement('a', { href: to }, children); },
      Outlet: () => React.createElement('p', {}, 'Owner content'),
    },
    '../AuthContext': { useAuth: () => ({ user, isDashboardUser: canAccessDashboard(user.role), signOut() {} }) },
    '../branding': { brand: { appName: 'App', productName: 'Vehicles' } },
    '../i18n': language,
  });
  const html = renderToStaticMarkup(React.createElement(Layout));
  assert.equal(canAccessDashboard('vehicle_owner'), true);
  assert.equal(canAccessDashboard('driver'), false);
  assert.deepEqual(redirects, []);
  assert.deepEqual(links, ['/', '/export', '/vehicles', '/issues', '/history']);
  assert.match(html, /Owner content/);
  assert.match(html, /vehicle_owner/);
});

test('owner issue detail renders evidence and status without repair buttons or upload controls', async () => {
  const { IssueModal } = await loadComponent('../web/src/pages/IssuesPage.tsx', {
    'react-router-dom': {}, '../api': {}, '../AuthContext': {}, '../i18n': language,
    '../issue-checklist': { partitionFailedChecklistPhotos: () => ({ mappedItems: [], unassociatedUrls: [] }) },
    '../components/PhotoGrid': { PhotoGrid: () => null },
    '../lib/format-date': { formatDateThai: (value) => value, formatDateTimeThai: (value) => value },
  }, 'exports.IssueModal = IssueModal;');
  const issue = { id: 'issue', plate_number: 'TEST-1', fleet_id: 'NORTH', status: 'open', created_at: '2026-01-01' };
  const props = { issue, onClose() {}, onStartRepair() {}, onCompleteRepair() {}, updating: false };
  const ownerHtml = renderToStaticMarkup(React.createElement(IssueModal, { ...props, readOnly: true }));
  const staffHtml = renderToStaticMarkup(React.createElement(IssueModal, { ...props, readOnly: false }));
  assert.match(ownerHtml, /TEST-1/);
  assert.doesNotMatch(ownerHtml, /inProgress|type="file"/);
  assert.match(staffHtml, /inProgress/);
});

test('vehicle checklist shows selections across fleets and explicit no-access empty state', async () => {
  const { OwnerVehicleSelector } = await loadComponent('../web/src/pages/admin/OwnerVehicleSelector.tsx', {
    '../../i18n': language,
    '../../checklist-import': {},
    '../../owner-vehicle-selection': selection,
  });
  const props = {
    vehicles: [
      { id: 'one', plate_number: 'TEST-1', vehicle_type: 'van', fleet_id: 'NORTH' },
      { id: 'two', plate_number: 'TEST-2', vehicle_type: 'van', fleet_id: 'SOUTH' },
    ],
    onChange() {},
  };
  const selectedHtml = renderToStaticMarkup(React.createElement(OwnerVehicleSelector, { ...props, selectedIds: ['one', 'two'] }));
  assert.match(selectedHtml, /ownerSelectedCount 2/);
  assert.match(selectedHtml, /NORTH/);
  assert.match(selectedHtml, /SOUTH/);
  assert.equal((selectedHtml.match(/ checked=""/g) ?? []).length, 2);
  const emptyHtml = renderToStaticMarkup(React.createElement(OwnerVehicleSelector, { ...props, selectedIds: [] }));
  assert.match(emptyHtml, /ownerEmptySelection/);
});
