import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const [dashboardSource, i18nSource] = await Promise.all([
  readFile(new URL('../web/src/pages/DashboardPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../web/src/i18n.ts', import.meta.url), 'utf8'),
]);

function loadModule(source, imports = {}, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
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

const unitData = {
  configured: true,
  summary: { total: 3, running: 0, stopped: 0, offline: 1, uninstall: 2, needsAttention: 1 },
  vehicles: [
    { plateNumber: 'NO-UNIT-PARTIAL', fleet: 'alpha', gpsStatus: 'uninstall', needsAttention: true,
      inspections: { preRoute: true, postRoute: false, weekly: true } },
    { plateNumber: 'NO-UNIT-COMPLETE', fleet: 'alpha', gpsStatus: 'uninstall', needsAttention: false,
      inspections: { preRoute: true, postRoute: true, weekly: true } },
    { plateNumber: 'INSTALLED-OFFLINE', fleet: 'alpha', gpsStatus: 'offline', needsAttention: false,
      inspections: { preRoute: false, postRoute: false, weekly: false } },
  ],
};

function renderUnitStatus(filter, lang = 'en', data = unitData) {
  const i18n = loadModule(i18nSource, {}, {
    localStorage: { getItem: () => lang },
  });
  i18n.initLang();
  const dashboard = loadModule(`${dashboardSource}\nexport { UnitStatusSection };`, {
    react: { ...React, useState: () => [filter, () => {}] },
    'react/jsx-runtime': webRequire('react/jsx-runtime'),
    'react-router-dom': {},
    '../api': {},
    '../AuthContext': {},
    '../components/DonutChart': {},
    '../i18n': i18n,
    '../lib/format-date': {},
  });
  return renderToStaticMarkup(React.createElement(dashboard.UnitStatusSection, { unitData: data }));
}

test('All Vehicles renders Uninstall with checked and pending cells independently in both languages', () => {
  for (const lang of ['en', 'th']) {
    const html = renderUnitStatus('all', lang);
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
    const partial = rows.find((row) => row.includes('NO-UNIT-PARTIAL'));
    const complete = rows.find((row) => row.includes('NO-UNIT-COMPLETE'));
    const offline = rows.find((row) => row.includes('INSTALLED-OFFLINE'));
    assert.match(partial, /class="status-badge"[^>]*>Uninstall<\/span>/);
    assert.equal((partial.match(/inspection-state--done/g) ?? []).length, 2);
    assert.equal((partial.match(/inspection-state--pending/g) ?? []).length, 1);
    assert.match(complete, />Uninstall<\/span>/);
    assert.equal((complete.match(/inspection-state--done/g) ?? []).length, 3);
    assert.doesNotMatch(offline, /Uninstall/);
    assert.match(html, /Uninstall<\/span><strong[^>]*>2<\/strong>/);
  }
});

test('Pending Inspection includes pending Uninstall vehicles and hides completed vehicles', () => {
  const html = renderUnitStatus('attention');
  assert.match(html, /NO-UNIT-PARTIAL/);
  assert.match(html, />Uninstall<\/span>/);
  assert.doesNotMatch(html, /NO-UNIT-COMPLETE/);
  assert.doesNotMatch(html, /INSTALLED-OFFLINE/);
});

test('an unconfigured sheet keeps its setup message without an Uninstall badge', () => {
  const html = renderUnitStatus('all', 'en', { configured: false, vehicles: [] });
  assert.match(html, /Google Sheets not configured/);
  assert.doesNotMatch(html, /Uninstall/);
});
