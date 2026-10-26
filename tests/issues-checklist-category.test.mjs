import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import {
  localizedFailedChecklistItemLabel,
  localizedFailedChecklistItemLabels,
  partitionFailedChecklistPhotos,
} from '../web/src/issue-checklist.ts';

const issuesApiSource = await readFile(new URL('../api/issues.ts', import.meta.url), 'utf8');

function loadIssuesHandler(sqlCalls) {
  const output = ts.transpileModule(issuesApiSource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    sqlCalls.push({ text, values });
    if (text.includes('FROM issue_reports ir')) {
      return [{
        id: 'issue-1',
        inspection_id: 'inspection-1',
        status: 'open',
        defect_photo_urls: ['stored.jpg'],
      }];
    }
    if (text.includes('WITH failed_items AS')) {
      return [{
        inspection_id: 'inspection-1',
        defect_photo_urls: ['headlights.jpg', 'mirror.jpg'],
        failed_checklist_items: [
          { checklist_item_id: 'headlights', item_name_th: 'ไฟหน้า', item_name_en: 'Headlights', section: 'front', notes: '', photo_urls: ['headlights.jpg'] },
          { checklist_item_id: 'mirror', item_name_th: 'กระจกมองข้าง', item_name_en: 'Side mirror', section: 'sides', notes: '', photo_urls: ['mirror.jpg'] },
        ],
      }];
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };
  const fakeRequire = (specifier) => {
    if (specifier === '../lib/vehicle-access') return { getOwnerVehicleIds: async () => null };
    if (specifier === '@neondatabase/serverless') return { neon: () => sql };
    if (specifier === '../lib/api-auth') {
      return {
        verifyAuth: async () => ({
          companyId: 'company-1',
          fleetId: null,
          role: 'admin',
          userId: 'admin-1',
          username: 'admin',
        }),
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

test('issue checklist labels use the active language, fall back, and stay unique', () => {
  const items = [
    { checklist_item_id: 'lights', item_name_th: 'ไฟหน้า', item_name_en: 'Headlights' },
    { checklist_item_id: 'lights-copy', item_name_th: 'ไฟหน้า', item_name_en: 'Headlights' },
    { checklist_item_id: 'mirror', item_name_th: '   ', item_name_en: 'Side mirror' },
  ];

  assert.deepEqual(localizedFailedChecklistItemLabels(items, 'th'), ['ไฟหน้า', 'Side mirror']);
  assert.deepEqual(localizedFailedChecklistItemLabels(items, 'en'), ['Headlights', 'Side mirror']);
  assert.equal(localizedFailedChecklistItemLabel(items[2], 'th'), 'Side mirror');
  assert.deepEqual(localizedFailedChecklistItemLabels(undefined, 'en'), []);
});

test('issue photos stay grouped while legacy photos remain available', () => {
  const items = [
    { checklist_item_id: 'lights', item_name_th: 'ไฟหน้า', item_name_en: 'Headlights', photo_urls: ['lights.jpg'] },
    { checklist_item_id: 'mirror', item_name_th: 'กระจก', item_name_en: 'Mirror', photo_urls: ['mirror.jpg'] },
    { checklist_item_id: 'door', item_name_th: 'ประตู', item_name_en: 'Door', photo_urls: [] },
  ];

  const partitioned = partitionFailedChecklistPhotos(
    items,
    ['lights.jpg', 'legacy.jpg', 'mirror.jpg', 'legacy-2.jpg'],
  );
  assert.deepEqual(partitioned.mappedItems.map((item) => item.checklist_item_id), ['lights', 'mirror']);
  assert.deepEqual(partitioned.unassociatedUrls, ['legacy.jpg', 'legacy-2.jpg']);
  assert.deepEqual(
    partitionFailedChecklistPhotos(undefined, ['legacy.jpg']),
    { mappedItems: [], unassociatedUrls: ['legacy.jpg'] },
  );
});

test('issues API returns ordered failed checklist items with their own photos', async () => {
  const sqlCalls = [];
  const handler = loadIssuesHandler(sqlCalls);
  const res = responseRecorder();

  await handler({ method: 'GET', query: { status: 'open' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.issues[0].defect_photo_urls, ['headlights.jpg', 'mirror.jpg']);
  assert.deepEqual(
    res.body.issues[0].failed_checklist_items.map((item) => [item.item_name_en, item.photo_urls]),
    [['Headlights', ['headlights.jpg']], ['Side mirror', ['mirror.jpg']]],
  );
  const evidenceQuery = sqlCalls.find(({ text }) => text.includes('WITH failed_items AS'));
  assert.ok(evidenceQuery);
  assert.match(evidenceQuery.text, /JOIN checklist_items ci ON ci\.id = ir\.checklist_item_id/);
  assert.match(evidenceQuery.text, /ir\.result = 'fail'/);
  assert.match(evidenceQuery.text, /ci\.company_id =/);
  assert.match(evidenceQuery.text, /ORDER BY ir\.sort_order, ir\.checklist_item_id/);
  assert.deepEqual(evidenceQuery.values.find(Array.isArray), ['inspection-1']);
  assert.ok(evidenceQuery.values.includes('company-1'));
});

test('Issues table places every failed checklist item immediately after Fleet', async () => {
  const source = await readFile(new URL('../web/src/pages/IssuesPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  const fleetHeader = source.indexOf("<th>{t('fleet')}</th>");
  const checklistHeader = source.indexOf("<th>{t('failedChecklistItems')}</th>");
  const statusHeader = source.indexOf("<th>{t('status')}</th>");
  const fleetCell = source.indexOf("<td>{issue.vehicle_fleet || issue.fleet_id || '—'}</td>");
  const checklistCell = source.indexOf('<td className="issue-checklist-cell">');
  const statusCell = source.indexOf('<td><span className={`badge badge--${issue.status}`}');

  assert.ok(fleetHeader >= 0);
  assert.ok(checklistHeader > fleetHeader);
  assert.ok(statusHeader > checklistHeader);
  assert.ok(fleetCell >= 0);
  assert.ok(checklistCell > fleetCell);
  assert.ok(statusCell > checklistCell);
  assert.match(source, /localizedFailedChecklistItemLabels\(issue\.failed_checklist_items, getLang\(\)\)/);
  assert.match(source, /const checklistSummary = checklistLabels\.join\(' • '\)/);
  assert.match(source, /\{checklistSummary \|\| '—'\}/);
  assert.doesNotMatch(source, /checklistLabels\.slice\(/);
  assert.doesNotMatch(source, /moreItems/);
  assert.doesNotMatch(styles, /issue-checklist-summary/);
  assert.doesNotMatch(styles, /line-clamp/);
});

test('Issue modal groups defect photos by failed checklist item', async () => {
  const source = await readFile(new URL('../web/src/pages/IssuesPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /partitionFailedChecklistPhotos\(/);
  assert.match(source, /mappedDefectItems\.map\(\(item\) =>/);
  assert.match(source, /urls=\{item\.photo_urls!\}/);
  assert.match(source, /localizedFailedChecklistItemLabel\(item, lang\)/);
  assert.match(source, /unassociatedDefectUrls\.length > 0/);
});
