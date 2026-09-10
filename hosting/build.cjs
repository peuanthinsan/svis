'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function publicBuildSettings(filename) {
  const settings = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Build settings must be a JSON object');
  }
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!/^NEXT_PUBLIC_[A-Z0-9_]+$/.test(key)) {
      throw new Error('Build settings may contain only NEXT_PUBLIC_ values; never pass runtime secrets');
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) || String(value).includes('\0')) {
      throw new Error('Build setting values must be finite numbers, booleans or strings without NUL');
    }
    result[key] = String(value);
  }
  return result;
}

function assertNoEnvFiles(directory) {
  if (!fs.existsSync(directory)) return;
  const active = fs.readdirSync(directory).filter(name =>
    /^\.env(?:\.|$)/i.test(name) && !/^\.env\.(example|sample|template)$/i.test(name));
  if (active.length) throw new Error('Build from a clean checkout without .env files: ' + directory);
}

function findNpmCli(executable = process.execPath, inherited = process.env) {
  const nodeDir = path.dirname(fs.realpathSync(executable));
  const searchPath = Object.entries(inherited).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const candidates = [
    path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), // Windows Node installer
    path.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'), // Unix installations
    path.join(nodeDir, 'npm'),
    ...searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'npm')),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (path.basename(resolved) === 'npm-cli.js' && fs.statSync(resolved).isFile()) return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('Cannot locate npm-cli.js beside Node or on PATH; install npm for this Node installation');
}

function buildEnvironment(inherited, publicSettings, scratch) {
  const environment = {};
  // Do not carry credentials, NODE_OPTIONS or arbitrary npm configuration into lifecycle scripts.
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ']);
  for (const [key, value] of Object.entries(inherited)) {
    if (allowed.has(key.toUpperCase())) environment[key] = value;
  }
  return {
    ...environment, ...publicSettings,
    NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', SONGDEE_WINDOWS_HOSTING: '1',
    DATABASE_URL: 'postgresql://build_only:dummy@127.0.0.1:54329/build_only',
    POSTGRES_URL: 'postgresql://build_only:dummy@127.0.0.1:54329/build_only',
    SONGDEE_ADMIN_TOKEN_SECRET: 'build-validation-only-not-a-production-secret',
    AUTH_SECRET: 'build-validation-only-not-a-production-secret',
    // Ignore the user's npm credentials/configuration, including for dependency installation.
    NPM_CONFIG_USERCONFIG: path.join(scratch, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(scratch, 'global.npmrc'),
  };
}

function physicalPath(filename) {
  if (fs.existsSync(filename)) return fs.realpathSync(filename);
  return path.join(physicalPath(path.dirname(filename)), path.basename(filename));
}

function build(configFile, output, options = {}) {
  const root = fs.realpathSync(options.root || path.resolve(__dirname, '..'));
  const run = options.spawnSync || spawnSync;
  const inherited = options.environment || process.env;
  const executable = options.execPath || process.execPath;
  if (!configFile || !output) throw new Error('Usage: node hosting/build.cjs PUBLIC_BUILD_SETTINGS_JSON OUTPUT_DIRECTORY');
  const publicSettings = publicBuildSettings(configFile);
  const { app } = JSON.parse(fs.readFileSync(path.join(root, 'hosting/app.json'), 'utf8'));
  if (!['dashboard', 'ops', 'svis'].includes(app)) throw new Error('Unknown application');
  const destination = physicalPath(path.resolve(output));
  if (fs.existsSync(destination)) throw new Error('Output directory must not already exist');
  const relative = path.relative(root, destination);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Output must be outside the source checkout');
  }
  assertNoEnvFiles(root);
  assertNoEnvFiles(path.join(root, 'web'));
  const npm = findNpmCli(executable, inherited);
  // All validation above precedes subprocesses and filesystem writes.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songdee-build-'));
  const env = buildEnvironment(inherited, publicSettings, scratch);
  function node(args, cwd = root, variables = env) {
    const result = run(executable, args, { cwd, env: variables, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Build command failed; exit code ' + result.status);
  }
  function install(cwd) {
    node([npm, 'ci', '--include=dev', '--no-audit', '--no-fund'], cwd, { ...env, NODE_ENV: 'development' });
  }
  function copy(from, to) { fs.cpSync(from, to, { recursive: true, errorOnExist: true }); }
  try {
    if (app === 'dashboard') {
      install(root);
      node([path.join(root, 'node_modules/vitest/vitest.mjs'), 'run']);
      node([path.join(root, 'node_modules/next/dist/bin/next'), 'build']);
      copy(path.join(root, '.next/standalone'), destination);
      if (fs.existsSync(path.join(root, 'public'))) copy(path.join(root, 'public'), path.join(destination, 'public'));
      copy(path.join(root, '.next/static'), path.join(destination, '.next/static'));
    } else if (app === 'ops') {
      const web = path.join(root, 'web');
      install(web);
      node(['--experimental-vm-modules', '--test', 'tests/windows-hosting.test.mjs',
        'tests/admin-auth.test.ts', 'tests/database-schema.test.ts', 'tests/production-api-boundary.test.ts']);
      node([path.join(web, 'node_modules/next/dist/bin/next'), 'build'], web);
      copy(path.join(web, '.next/standalone'), destination);
      if (fs.existsSync(path.join(web, 'public'))) copy(path.join(web, 'public'), path.join(destination, 'web/public'));
      copy(path.join(web, '.next/static'), path.join(destination, 'web/.next/static'));
    } else {
      install(root);
      install(path.join(root, 'web'));
      node(['--test', 'host/host-policy.test.cjs', 'host/proxy-headers.test.cjs', 'host/pg-neon.test.cjs']);
      node([npm, 'run', 'build'], path.join(root, 'web'));
      node(['host/build.cjs']);
      fs.mkdirSync(destination, { recursive: true });
      for (const dir of ['dist', 'public']) copy(path.join(root, dir), path.join(destination, dir));
      // Use the repository lockfile for reproducible runtime dependency installation.
      for (const name of ['package.json', 'package-lock.json']) copy(path.join(root, name), path.join(destination, name));
      node([npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], destination);
    }
    fs.mkdirSync(path.join(destination, 'hosting'), { recursive: true });
    for (const name of ['launch.cjs', 'app.json']) copy(path.join(root, 'hosting', name), path.join(destination, 'hosting', name));
    console.log('Release packaged for ' + app);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { build, buildEnvironment, findNpmCli, publicBuildSettings };
if (require.main === module) build(...process.argv.slice(2));
