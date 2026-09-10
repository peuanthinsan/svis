'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { build, findNpmCli } = require('./build.cjs');
const { launch } = require('./launch.cjs');

function fixture(t, app = 'dashboard') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'songdee-helper-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  function write(name, value = '') {
    const target = path.join(base, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
    return target;
  }
  write('source/hosting/app.json', JSON.stringify({ app }));
  write('source/hosting/launch.cjs', '// packaged launcher');
  const config = write('public.json', '{}');
  const executable = write('node-install/node');
  write('node-install/node_modules/npm/bin/npm-cli.js');
  return { base, root, write, config, executable, output: path.join(base, 'release') };
}

for (const invalid of ['null', '[]', '"text"', '4', '{"DATABASE_URL":"dummy"}',
  '{"NODE_OPTIONS":"--inspect"}', '{"NEXT_PUBLIC_X":null}', '{"NEXT_PUBLIC_X":{}}',
  '{"NEXT_PUBLIC_X":[]}', '{"NEXT_PUBLIC_X":1e999}', '{"NEXT_PUBLIC_X":"a\\u0000b"}']) {
  test('invalid public settings fail before subprocesses or writes: ' + invalid, t => {
    const f = fixture(t);
    fs.writeFileSync(f.config, invalid);
    const writes = t.mock.method(fs, 'mkdtempSync', () => assert.fail('unexpected write'));
    let spawns = 0;
    assert.throws(() => build(f.config, f.output, {
      root: f.root, execPath: f.executable, spawnSync: () => { spawns++; },
    }), /Build setting/);
    assert.equal(spawns, 0);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(fs.existsSync(f.output), false);
  });
}

for (const filename of ['.env', '.env.production.local', 'web/.env', 'web/.env.production']) {
  test('active environment file fails before subprocesses or writes: ' + filename, t => {
    const f = fixture(t);
    f.write('source/' + filename, 'DUMMY_SECRET=not-a-real-secret');
    const writes = t.mock.method(fs, 'mkdtempSync', () => assert.fail('unexpected write'));
    assert.throws(() => build(f.config, f.output, {
      root: f.root, execPath: f.executable, spawnSync: () => assert.fail('unexpected subprocess'),
    }), /without .env files/);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(fs.existsSync(f.output), false);
  });
}

test('output inside source through a symlink is rejected before writes', t => {
  const f = fixture(t);
  fs.symlinkSync(f.root, path.join(f.base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const writes = t.mock.method(fs, 'mkdtempSync', () => assert.fail('unexpected write'));
  assert.throws(() => build(f.config, path.join(f.base, 'alias/release'), {
    root: f.root, execPath: f.executable, spawnSync: () => assert.fail('unexpected subprocess'),
  }), /outside the source/);
  assert.equal(writes.mock.callCount(), 0);
});

for (const app of ['dashboard', 'ops', 'svis']) {
  test('public settings, sanitized subprocesses and packaged paths for ' + app, t => {
    const f = fixture(t, app);
    f.write('source/.env.example', 'EXAMPLE_ONLY=1');
    f.write('source/web/.env.template', 'EXAMPLE_ONLY=1');
    f.write('source/.next/standalone/server.js', 'dashboard server');
    f.write('source/.next/static/chunk.js', 'dashboard static');
    f.write('source/web/.next/standalone/web/server.js', 'ops server');
    f.write('source/web/.next/static/chunk.js', 'ops static');
    f.write('source/web/public/icon.svg', 'ops public');
    f.write('source/public/index.html', 'public');
    f.write('source/dist/server.cjs', 'svis server');
    f.write('source/package.json', '{}');
    f.write('source/package-lock.json', '{"lockfileVersion":3}');
    fs.writeFileSync(f.config, '\uFEFF' + JSON.stringify({ NEXT_PUBLIC_URL: 'https://example.invalid', NEXT_PUBLIC_FLAG: true, NEXT_PUBLIC_NUMBER: 42 }));
    const inherited = {
      PATH: '/dummy/path', HOME: f.base, DATABASE_URL: 'must-not-leak', POSTGRES_URL: 'must-not-leak',
      AUTH_SECRET: 'must-not-leak', SONGDEE_ADMIN_TOKEN_SECRET: 'must-not-leak',
      SENDGRID_API_KEY: 'must-not-leak', GITHUB_TOKEN: 'must-not-leak', NODE_OPTIONS: '--inspect',
      AUTH_URL: 'https://private.invalid', NEXTAUTH_URL: 'https://private.invalid',
      NEXT_PUBLIC_INHERITED: 'must-not-leak', npm_config_userconfig: '/private/config',
    };
    const calls = [];
    build(f.config, f.output, { root: f.root, execPath: f.executable, environment: inherited,
      spawnSync: (command, args, options) => { calls.push({ command, args, ...options }); return { status: 0 }; },
    });
    assert.equal(calls.length, { dashboard: 3, ops: 3, svis: 6 }[app]);
    for (const call of calls) {
      assert.equal(call.command, f.executable);
      assert.equal(call.env.NEXT_PUBLIC_URL, 'https://example.invalid');
      assert.equal(call.env.NEXT_PUBLIC_FLAG, 'true');
      assert.equal(call.env.NEXT_PUBLIC_NUMBER, '42');
      assert.equal(call.env.SONGDEE_WINDOWS_HOSTING, '1');
      assert.match(call.env.DATABASE_URL, /127\.0\.0\.1:54329\/build_only$/);
      assert.equal(call.env.POSTGRES_URL, call.env.DATABASE_URL);
      assert.match(call.env.AUTH_SECRET, /^build-validation-only/);
      assert.equal(JSON.stringify(call.env).includes('must-not-leak'), false);
      for (const name of ['NODE_OPTIONS', 'AUTH_URL', 'NEXTAUTH_URL', 'npm_config_userconfig']) assert.equal(call.env[name], undefined);
      assert.notEqual(call.env.NPM_CONFIG_USERCONFIG, call.env.NPM_CONFIG_GLOBALCONFIG);
      assert.equal(fs.existsSync(path.dirname(call.env.NPM_CONFIG_USERCONFIG)), false, 'temporary npm config removed');
    }
    assert.equal(calls[0].env.NODE_ENV, 'development');
    assert.deepEqual(calls[0].args.slice(1), ['ci', '--include=dev', '--no-audit', '--no-fund']);
    if (app === 'ops') {
      assert.equal(calls[1].cwd, f.root);
      assert.deepEqual(calls[1].args, ['--experimental-vm-modules', '--test', 'tests/windows-hosting.test.mjs',
        'tests/admin-auth.test.ts', 'tests/database-schema.test.ts', 'tests/production-api-boundary.test.ts']);
    } else if (app === 'svis') {
      assert.equal(calls[2].cwd, f.root);
      assert.deepEqual(calls[2].args, ['--test', 'host/host-policy.test.cjs', 'host/proxy-headers.test.cjs', 'host/pg-neon.test.cjs']);
    }
    const server = { dashboard: 'server.js', ops: 'web/server.js', svis: 'dist/server.cjs' }[app];
    assert.equal(fs.existsSync(path.join(f.output, server)), true);
    assert.equal(fs.existsSync(path.join(f.output, 'hosting/launch.cjs')), true);
    assert.equal(fs.existsSync(path.join(f.output, 'public.json')), false);
    if (app === 'svis') {
      const runtime = calls.at(-1);
      assert.equal(runtime.cwd, f.output);
      assert.equal(runtime.env.NODE_ENV, 'production');
      assert.deepEqual(runtime.args.slice(1), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal(fs.readFileSync(path.join(f.output, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}');
    } else {
      assert.equal(fs.existsSync(path.join(f.output, app === 'ops' ? 'web/.next/static/chunk.js' : '.next/static/chunk.js')), true);
      assert.equal(fs.existsSync(path.join(f.output, app === 'ops' ? 'web/public/icon.svg' : 'public/index.html')), true);
    }
  });
}

test('npm discovery supports Windows and Unix Node layouts', t => {
  const f = fixture(t);
  assert.equal(findNpmCli(f.executable, {}), path.join(f.base, 'node-install/node_modules/npm/bin/npm-cli.js'));
  const unixNode = f.write('unix/bin/node');
  const unixNpm = f.write('unix/lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(findNpmCli(unixNode, {}), unixNpm);
});

for (const app of ['dashboard', 'ops', 'svis']) {
  test('launcher loads ' + app + ' on loopback with the controller candidate port', t => {
    const f = fixture(t, app);
    const config = f.write('runtime.json', JSON.stringify({ PORT: '8080', HOST: '0.0.0.0', HOSTNAME: 'external',
      SONGDEE_CANDIDATE_PORT: '18001', SONGDEE_WINDOWS_HOSTING: '0', AUTH_URL: 'https://example.invalid', NEXTAUTH_URL: 'https://example.invalid' }));
    const environment = { SONGDEE_CONFIG: config, SONGDEE_CANDIDATE_PORT: '18082' };
    const loaded = [];
    launch({ root: f.root, environment, load: value => loaded.push(value) });
    assert.deepEqual(loaded, [path.join(f.root, { dashboard: 'server.js', ops: 'web/server.js', svis: 'dist/server.cjs' }[app])]);
    assert.equal(environment.PORT, '18082');
    assert.equal(environment.HOST, '127.0.0.1');
    assert.equal(environment.HOSTNAME, '127.0.0.1');
    assert.equal(environment.SONGDEE_WINDOWS_HOSTING, '1');
    assert.equal(environment.NODE_ENV, 'production');
    if (app === 'dashboard') {
      assert.equal(environment.AUTH_URL, undefined);
      assert.equal(environment.NEXTAUTH_URL, undefined);
      assert.equal(environment.AUTH_TRUST_HOST, 'true');
    }
  });
}

test('launcher rejects invalid candidate ports and runtime settings before mutation/load', t => {
  const f = fixture(t);
  const config = f.write('runtime.json', '{}');
  for (const port of ['', '0', '1023', '65536', '99999', '18082x']) {
    const environment = { SONGDEE_CONFIG: config, SONGDEE_CANDIDATE_PORT: port };
    const before = { ...environment };
    assert.throws(() => launch({ root: f.root, environment, load: () => assert.fail('unexpected load') }), /Invalid candidate port/);
    assert.deepEqual(environment, before);
  }
  for (const invalid of ['null', '[]', '{"PORT":"8080","NODE_OPTIONS":"--inspect"}', '{"PORT":{}}']) {
    fs.writeFileSync(config, invalid);
    const environment = { SONGDEE_CONFIG: config };
    assert.throws(() => launch({ root: f.root, environment, load: () => assert.fail('unexpected load') }), /[Rr]untime/);
    assert.deepEqual(environment, { SONGDEE_CONFIG: config });
  }
});

for (const app of ['ops', 'svis']) {
  test('a failed ' + app + ' regression check prevents building or packaging', t => {
    const f = fixture(t, app);
    const calls = [];
    assert.throws(() => build(f.config, f.output, {
      root: f.root, execPath: f.executable, environment: {},
      spawnSync: (command, args) => {
        calls.push(args);
        return { status: args.includes('--test') ? 1 : 0 };
      },
    }), /Build command failed/);
    assert.equal(calls.length, app === 'ops' ? 2 : 3);
    assert.equal(calls.at(-1).includes('--test'), true);
    assert.equal(fs.existsSync(f.output), false);
  });
}
