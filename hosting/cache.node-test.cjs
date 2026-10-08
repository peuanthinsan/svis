'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { compilerCache, cacheKey } = require('./build-cache.cjs');
const { build } = require('./build.cjs');

function fixture(t, app = 'dashboard') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'songdee-cache-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  const cacheDirectory = path.join(base, 'cache');
  const destination = path.join(base, 'release');
  const next = path.join(root, app === 'ops' ? 'web/.next' : '.next');
  function write(name, content = '') {
    const filename = path.join(base, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    return filename;
  }
  write('source/hosting/app.json', JSON.stringify({ app }));
  write('source/hosting/launch.cjs', '// launcher');
  write('source/package.json', '{}');
  write('source/package-lock.json', '{"lockfileVersion":3}');
  const config = write('public.json', '{}');
  const executable = write('node-install/node');
  write('node-install/node_modules/npm/bin/npm-cli.js');
  const messages = [];
  const settings = { root, destination, app, publicSettings: {}, cacheDirectory, environment: {},
    log: message => messages.push(message) };
  const compiler = path.join(next, 'cache/turbopack');
  function output(content = 'fresh server') {
    fs.mkdirSync(path.join(next, 'standalone', app === 'ops' ? 'web' : ''), { recursive: true });
    fs.writeFileSync(path.join(next, 'standalone', app === 'ops' ? 'web/server.js' : 'server.js'), content);
    fs.mkdirSync(path.join(next, 'static'), { recursive: true });
    fs.writeFileSync(path.join(next, 'static/chunk.js'), content);
  }
  function compile(content = 'compiler') {
    fs.mkdirSync(compiler, { recursive: true });
    fs.writeFileSync(path.join(compiler, 'data'), content);
  }
  function removeNext() {
    assert.ok(next.startsWith(base + path.sep));
    fs.rmSync(next, { recursive: true, force: true });
  }
  function snapshots() {
    const dir = path.join(cacheDirectory, app);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => !name.startsWith('.')) : [];
  }
  function seed() {
    compile('cached');
    compilerCache(settings).publish();
    assert.equal(snapshots().length, 1);
    removeNext();
  }
  const buildOptions = { root, execPath: executable, cacheDirectory, environment: {} };
  return { base, root, cacheDirectory, destination, next, compiler, write, config, executable, settings,
    messages, output, compile, removeNext, snapshots, seed, buildOptions };
}

for (const app of ['ops', 'dashboard']) {
  test('cold miss and warm restore copy only compiler data for ' + app, t => {
    const f = fixture(t, app);
    assert.equal(compilerCache(f.settings).restore(), false);
    f.compile('compiled bytes');
    fs.mkdirSync(path.join(f.next, 'cache/fetch-cache'), { recursive: true });
    fs.writeFileSync(path.join(f.next, 'cache/fetch-cache/private'), 'never cache runtime data');
    f.output('never cache standalone');
    compilerCache(f.settings).publish();
    const snapshot = path.join(f.cacheDirectory, app, f.snapshots()[0]);
    assert.deepEqual(fs.readdirSync(snapshot), ['turbopack']);
    f.removeNext();
    assert.equal(compilerCache(f.settings).restore(), true);
    assert.equal(fs.readFileSync(path.join(f.compiler, 'data'), 'utf8'), 'compiled bytes');
    assert.deepEqual(fs.readdirSync(path.join(f.next, 'cache')), ['turbopack']);
    assert.equal(fs.existsSync(path.join(f.next, 'standalone')), false);
    assert.match(f.messages.join('\n'), /miss[\s\S]*saved[\s\S]*hit/);
  });
}

test('keys isolate app, public settings, package locks and framework configuration', t => {
  const f = fixture(t);
  const initial = cacheKey(f.settings);
  assert.notEqual(cacheKey({ ...f.settings, app: 'ops' }), initial);
  assert.notEqual(cacheKey({ ...f.settings, publicSettings: { NEXT_PUBLIC_FLAG: '1' } }), initial);
  assert.equal(cacheKey({ ...f.settings, publicSettings: { NEXT_PUBLIC_A: 'a', NEXT_PUBLIC_B: 'b' } }),
    cacheKey({ ...f.settings, publicSettings: { NEXT_PUBLIC_B: 'b', NEXT_PUBLIC_A: 'a' } }));
  for (const file of ['package-lock.json', 'web/package-lock.json', 'next.config.mjs', 'web/next.config.mjs',
    'tsconfig.json', 'web/tsconfig.json']) {
    const old = cacheKey(f.settings);
    f.write('source/' + file, 'changed');
    assert.notEqual(cacheKey(f.settings), old, file);
  }
});

test('changed lockfile misses an existing snapshot', t => {
  const f = fixture(t);
  f.seed();
  f.write('source/package-lock.json', '{"lockfileVersion":3,"changed":true}');
  assert.equal(compilerCache(f.settings).restore(), false);
  assert.equal(fs.existsSync(f.compiler), false);
});

test('disabled cache and absent compiler output create no persistent files', t => {
  const f = fixture(t);
  compilerCache(f.settings).publish();
  assert.equal(fs.existsSync(f.cacheDirectory), false);
  f.compile();
  const disabled = compilerCache({ ...f.settings, environment: { SONGDEE_BUILD_CACHE: '0' } });
  assert.equal(disabled.restore(), false);
  disabled.publish();
  assert.equal(fs.existsSync(f.cacheDirectory), false);
  compilerCache({ ...f.settings, app: 'svis' }).publish();
  assert.equal(fs.existsSync(f.cacheDirectory), false);
});

test('cache restore preserves an existing local compiler cache', t => {
  const f = fixture(t);
  f.seed();
  f.compile('local');
  assert.equal(compilerCache(f.settings).restore(), false);
  assert.equal(fs.readFileSync(path.join(f.compiler, 'data'), 'utf8'), 'local');
});

test('cache paths overlapping source or output fail open without writes', t => {
  const f = fixture(t);
  f.compile();
  for (const cacheDirectory of [f.root, path.join(f.root, 'cache'), f.destination,
    path.join(f.destination, 'cache'), f.base]) {
    const cache = compilerCache({ ...f.settings, cacheDirectory });
    assert.equal(cache.restore(), false);
    cache.publish();
  }
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(path.join(f.root, 'cache')), false);
  assert.equal(fs.existsSync(path.join(f.base, 'dashboard')), false);
  assert.match(f.messages.join('\n'), /separate from checkout and release/);
});

test('symlink cache roots and compiler descendants are rejected without following links', t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  const alias = path.join(f.base, 'alias');
  fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.compile();
  compilerCache({ ...f.settings, cacheDirectory: alias }).publish();
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.symlinkSync(outside, path.join(f.compiler, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  compilerCache(f.settings).publish();
  assert.equal(fs.existsSync(f.cacheDirectory), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('symlink snapshot and checkout cache ancestors are rejected on restore', t => {
  const f = fixture(t);
  f.seed();
  const snapshot = path.join(f.cacheDirectory, 'dashboard', f.snapshots()[0]);
  fs.renameSync(path.join(snapshot, 'turbopack'), path.join(f.base, 'moved-compiler'));
  fs.symlinkSync(path.join(f.base, 'moved-compiler'), path.join(snapshot, 'turbopack'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(compilerCache(f.settings).restore(), false);
  assert.equal(fs.existsSync(f.compiler), false);
  fs.mkdirSync(path.join(f.base, 'outside-next'));
  fs.symlinkSync(path.join(f.base, 'outside-next'), f.next, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(compilerCache(f.settings).restore(), false);
  assert.deepEqual(fs.readdirSync(path.join(f.base, 'outside-next')), []);
});

test('read failure falls back to a cold cache and removes partial restoration', t => {
  const f = fixture(t);
  f.seed();
  const original = fs.cpSync;
  t.mock.method(fs, 'cpSync', (source, destination, options) => {
    if (source.startsWith(f.cacheDirectory)) {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'partial'), 'partial');
      throw Object.assign(new Error('simulated cache read error'), { code: 'EACCES' });
    }
    return original(source, destination, options);
  });
  assert.equal(compilerCache(f.settings).restore(), false);
  assert.equal(fs.existsSync(f.compiler), false);
  assert.deepEqual(fs.readdirSync(path.join(f.next, 'cache')), []);
  assert.equal(f.snapshots().length, 1);
});

for (const failure of ['copy', 'rename']) {
  test('publication ' + failure + ' failure leaves no visible or temporary cache entry', t => {
    const f = fixture(t);
    f.compile();
    const method = failure === 'copy' ? 'cpSync' : 'renameSync';
    t.mock.method(fs, method, () => { throw new Error('simulated publication failure'); });
    assert.doesNotThrow(() => compilerCache(f.settings).publish());
    assert.deepEqual(fs.readdirSync(path.join(f.cacheDirectory, 'dashboard')), []);
  });
}

test('oversized compiler cache is skipped before copying', t => {
  const f = fixture(t);
  f.compile();
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (filename, ...args) => {
    const stat = original(filename, ...args);
    if (filename === path.join(f.compiler, 'data')) stat.size = 256 * 1024 * 1024 + 1;
    return stat;
  });
  compilerCache(f.settings).publish();
  assert.equal(fs.existsSync(f.cacheDirectory), false);
  assert.match(f.messages.join('\n'), /exceeds 256 MiB/);
});

test('concurrent publishers retain complete snapshots within the two-entry bound', async t => {
  const f = fixture(t);
  f.compile('complete');
  const script = 'require(' + JSON.stringify(require.resolve('./build-cache.cjs')) + ').compilerCache(' +
    JSON.stringify({ ...f.settings, log: undefined }) + ').publish()';
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['-e', script], { windowsHide: true })));
  const snapshots = f.snapshots();
  assert.ok(snapshots.length >= 1 && snapshots.length <= 2);
  assert.equal(fs.readdirSync(path.join(f.cacheDirectory, 'dashboard')).length, snapshots.length);
  for (const snapshot of snapshots) {
    assert.equal(fs.readFileSync(path.join(f.cacheDirectory, 'dashboard', snapshot, 'turbopack/data'), 'utf8'), 'complete');
  }
});

test('abandoned publication directories older than one day are reaped', t => {
  const f = fixture(t);
  f.compile();
  const stale = path.join(f.cacheDirectory, 'dashboard', '.tmp-00000000-0000-0000-0000-000000000000');
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(stale, old, old);
  compilerCache(f.settings).publish();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(f.snapshots().length, 1);
});

test('full successful packaging publishes compiler cache after all commands', t => {
  const f = fixture(t);
  const calls = [];
  build(f.config, f.destination, { ...f.buildOptions, spawnSync: (command, args) => {
    calls.push(args);
    assert.equal(f.snapshots().length, 0);
    if (args.at(-1) === 'build') { f.compile('new'); f.output(); }
    return { status: 0 };
  } });
  assert.equal(calls.length, 3);
  assert.equal(f.snapshots().length, 1);
  assert.equal(fs.readFileSync(path.join(f.destination, 'server.js'), 'utf8'), 'fresh server');
});

test('regression failure prevents restoration, building and cache publication', t => {
  const f = fixture(t);
  f.seed();
  const before = f.snapshots();
  const calls = [];
  assert.throws(() => build(f.config, f.destination, { ...f.buildOptions, spawnSync: (command, args) => {
    calls.push(args);
    return { status: args.at(-1) === 'run' ? 1 : 0 };
  } }), /Build command failed/);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(f.compiler), false);
  assert.equal(fs.existsSync(f.destination), false);
  assert.deepEqual(f.snapshots(), before);
});

test('failed cold build never packages or publishes its compiler output', t => {
  const f = fixture(t);
  assert.throws(() => build(f.config, f.destination, { ...f.buildOptions, spawnSync: (command, args) => {
    if (args.at(-1) === 'build') { f.compile('failed'); return { status: 1 }; }
    return { status: 0 };
  } }), /Build command failed/);
  assert.equal(fs.existsSync(f.destination), false);
  assert.deepEqual(f.snapshots(), []);
});

for (const retrySucceeds of [true, false]) {
  test('warm failure retries once cold; retry succeeds=' + retrySucceeds, t => {
    const f = fixture(t);
    f.seed();
    const before = f.snapshots();
    let nextCalls = 0;
    let testCalls = 0;
    const options = { ...f.buildOptions, spawnSync: (command, args) => {
      if (args.at(-1) === 'run') testCalls++;
      if (args.at(-1) === 'build') {
        nextCalls++;
        if (nextCalls === 1) {
          assert.equal(fs.readFileSync(path.join(f.compiler, 'data'), 'utf8'), 'cached');
          f.output('partial old output');
          return { status: 1 };
        }
        assert.equal(fs.existsSync(f.compiler), false, 'retry must start with a cold compiler');
        f.compile('retry');
        if (retrySucceeds) f.output('fresh retry output');
        return { status: retrySucceeds ? 0 : 1 };
      }
      return { status: 0 };
    } };
    if (retrySucceeds) {
      build(f.config, f.destination, options);
      assert.equal(fs.readFileSync(path.join(f.destination, 'server.js'), 'utf8'), 'fresh retry output');
    } else {
      assert.throws(() => build(f.config, f.destination, options), /Build command failed/);
      assert.equal(fs.existsSync(f.destination), false);
    }
    assert.equal(nextCalls, 2);
    assert.equal(testCalls, 1);
    if (retrySucceeds) {
      assert.equal(f.snapshots().length, 2, 'successful cold recovery publishes fresh compiler output');
      assert.ok(f.snapshots().some(name => !before.includes(name)));
    } else assert.deepEqual(f.snapshots(), before, 'failed invocation must preserve last successful snapshot');
  });
}

test('packaging failure prevents cache publication', t => {
  const f = fixture(t);
  assert.throws(() => build(f.config, f.destination, { ...f.buildOptions, spawnSync: (command, args) => {
    if (args.at(-1) === 'build') f.compile('successful compiler but missing standalone output');
    return { status: 0 };
  } }));
  assert.equal(f.snapshots().length, 0);
});

test('Unix cache ownership and permissions reject unsafe reads and publication before copying',
  { skip: !process.getuid }, t => {
    const f = fixture(t);
    f.seed();
    const appRoot = path.join(f.cacheDirectory, 'dashboard');
    const entry = path.join(appRoot, f.snapshots()[0]);
    const compiler = path.join(entry, 'turbopack');
    const data = path.join(compiler, 'data');
    const before = f.snapshots();
    const copyMock = t.mock.method(fs, 'cpSync', () => assert.fail('unsafe cache must be rejected before copying'));
    for (const target of [f.cacheDirectory, appRoot, entry, compiler, data]) {
      const original = fs.statSync(target).mode & 0o777;
      try {
        fs.chmodSync(target, original | 0o022);
        assert.equal(compilerCache(f.settings).restore(), false, target);
        assert.equal(fs.existsSync(f.compiler), false);
      } finally { fs.chmodSync(target, original); }
    }
    const originalStat = fs.statSync;
    const statMock = t.mock.method(fs, 'statSync', (filename, ...args) => {
      const stat = originalStat(filename, ...args);
      if (filename === f.cacheDirectory) stat.uid = process.getuid() + 1;
      return stat;
    });
    assert.equal(compilerCache(f.settings).restore(), false, 'different owner must be rejected');
    statMock.mock.restore();
    f.compile('fresh local');
    const appMode = fs.statSync(appRoot).mode & 0o777;
    try {
      fs.chmodSync(appRoot, appMode | 0o022);
      compilerCache(f.settings).publish();
    } finally { fs.chmodSync(appRoot, appMode); }
    assert.deepEqual(f.snapshots(), before);
    assert.equal(fs.readFileSync(data, 'utf8'), 'cached');
    assert.equal(fs.readdirSync(appRoot).length, before.length);
    assert.equal(copyMock.mock.callCount(), 0, 'unsafe cache must be rejected before any copy');
  });
