import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const source = await readFile(new URL('../web/src/components/Layout.tsx', import.meta.url), 'utf8');
// Vite injects this value in the app; supply it only for this CommonJS harness.
const output = ts.transpileModule(source.replace(/\bimport\.meta\.env\.BASE_URL\b/g, JSON.stringify('/')), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function renderLayout(user) {
  const redirects = [];
  const links = [];
  let outletRenders = 0;
  const imports = {
    'react/jsx-runtime': webRequire('react/jsx-runtime'),
    'react-router-dom': {
      Navigate: ({ to, replace }) => {
        redirects.push({ to, replace });
        return null;
      },
      NavLink: ({ to, children, className }) => {
        links.push(to);
        return React.createElement('a', {
          href: to, className: typeof className === 'function' ? className({ isActive: false }) : className,
        }, children);
      },
      Outlet: () => {
        outletRenders += 1;
        return React.createElement('div', { 'data-testid': 'protected-page' }, 'Protected page content');
      },
    },
    '../branding': { brand: { appName: 'Songdee', productName: 'VIS' } },
    '../AuthContext': { useAuth: () => ({
      user, isDashboardUser: user?.role === 'admin' || user?.role === 'supervisor', signOut: () => {},
    }) },
    '../i18n': { getLang: () => 'en', setLang: () => {}, t: (key) => key },
  };
  const componentModule = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    if (name in imports) return imports[name];
    throw new Error(`Unexpected import: ${name}`);
  }, componentModule, componentModule.exports);
  const html = renderToStaticMarkup(React.createElement(componentModule.exports.Layout));
  return { html, redirects, links, outletRenders };
}

const dashboardUser = (role) => ({ role, firstName: 'Sample', companyName: 'Example company' });

test('An anonymous dashboard session redirects to login without rendering the menu or protected page', () => {
  const rendered = renderLayout(null);
  assert.deepEqual(rendered.redirects, [{ to: '/login', replace: true }]);
  assert.equal(rendered.html, '');
  assert.deepEqual(rendered.links, []);
  assert.equal(rendered.outletRenders, 0);
});

test('A driver session redirects to login without rendering dashboard content', () => {
  const rendered = renderLayout(dashboardUser('driver'));
  assert.deepEqual(rendered.redirects, [{ to: '/login', replace: true }]);
  assert.equal(rendered.html, '');
  assert.deepEqual(rendered.links, []);
  assert.equal(rendered.outletRenders, 0);
});

for (const role of ['admin', 'supervisor']) {
  test(`${role} retains the dashboard shell, protected page and permitted menu links`, () => {
    const rendered = renderLayout(dashboardUser(role));
    assert.deepEqual(rendered.redirects, []);
    assert.equal(rendered.outletRenders, 1);
    assert.match(rendered.html, /class="app-shell"/);
    assert.match(rendered.html, /<nav\b/);
    assert.match(rendered.html, /data-testid="protected-page">Protected page content/);
    assert.match(rendered.html, /Example company/);
    assert.match(rendered.html, />logout<\/button>/);
    assert.deepEqual(rendered.links, [
      '/', '/export', '/inspections', '/issues', '/history',
      ...(role === 'admin' ? ['/checklist'] : []), '/admin',
    ]);
  });
}
