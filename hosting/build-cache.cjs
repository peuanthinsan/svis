'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 2;
const ENTRY = /^[a-f0-9]{64}-\d{13}-[a-f0-9-]{36}$/;

function within(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Refuse junctions/symlinks, including ancestors, before cache reads, writes or removal.
function plainPath(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Cache path contains a link');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

function treeBytes(directory, limit = MAX_BYTES, privateTree = false) {
  let bytes = 0;
  function visit(target) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('Cache tree contains a link');
    if (privateTree && process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022))) {
      throw new Error('Cache tree must be private to its owner');
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > limit) throw new Error('Compiler cache exceeds 256 MiB');
    } else throw new Error('Cache tree contains a special file');
  }
  visit(plainPath(directory));
  return bytes;
}

function removeChild(parent, target) {
  plainPath(parent);
  plainPath(target);
  if (path.dirname(target) !== parent) throw new Error('Cache removal must be an immediate child');
  if (!fs.existsSync(target)) return;
  treeBytes(target, Infinity);
  fs.rmSync(target, { recursive: true, force: true });
}

function cacheKey({ root, app, publicSettings }) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['compiler-cache-v1', app, process.platform, process.arch, process.version,
    Object.entries(publicSettings).sort(([a], [b]) => a.localeCompare(b))]));
  const names = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lock', 'bun.lockb', 'next.config.js', 'next.config.cjs', 'next.config.mjs', 'next.config.ts',
    'tsconfig.json', 'jsconfig.json', '.npmrc'];
  for (const prefix of ['', 'web/']) {
    for (const name of names) {
      const filename = path.join(root, prefix + name);
      hash.update('\0' + prefix + name + '\0');
      if (fs.existsSync(filename)) hash.update(fs.readFileSync(plainPath(filename)));
      else hash.update('<absent>');
    }
  }
  return hash.digest('hex');
}

function compilerCache({ root, destination, app, publicSettings, environment = process.env, cacheDirectory,
  log = console.log }) {
  const disabled = { restore: () => false, publish() {}, discard: () => false };
  if (environment.SONGDEE_BUILD_CACHE === '0' || !['ops', 'dashboard'].includes(app)) return disabled;
  let cacheRoot, appRoot, localParent, local, key;
  function skipped(error) { log('Compiler cache skipped: ' + error.message); }
  try {
    // Windows uses a per-user temp directory; the user suffix also isolates a shared Unix /tmp.
    const user = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12);
    cacheRoot = plainPath(cacheDirectory || path.join(fs.realpathSync(os.tmpdir()), 'songdee-compiler-cache-v1-' + user));
    for (const protectedPath of [root, destination]) {
      if (within(protectedPath, cacheRoot) || within(cacheRoot, protectedPath)) {
        throw new Error('Cache must be separate from checkout and release output');
      }
    }
    appRoot = path.join(cacheRoot, app);
    localParent = path.join(root, app === 'ops' ? 'web/.next/cache' : '.next/cache');
    local = path.join(localParent, 'turbopack');
    plainPath(appRoot);
    plainPath(local);
    key = cacheKey({ root, app, publicSettings });
  } catch (error) { skipped(error); return disabled; }

  function privateRoot() {
    plainPath(cacheRoot);
    if (!fs.existsSync(cacheRoot)) return;
    const stat = fs.statSync(cacheRoot);
    if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) {
      throw new Error('Cache directory must be private to its owner');
    }
  }
  function entries() {
    privateRoot();
    plainPath(appRoot);
    if (!fs.existsSync(appRoot)) return [];
    const stat = fs.statSync(appRoot);
    if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022))) {
      throw new Error('Application cache must be private to its owner');
    }
    return fs.readdirSync(appRoot).filter(name => ENTRY.test(name)).sort((a, b) =>
      b.slice(65).localeCompare(a.slice(65)));
  }
  function cleanup(parent, target) {
    if (!target) return;
    try { removeChild(parent, target); } catch (error) { skipped(error); }
  }
  return {
    restore() {
      let staging;
      try {
        plainPath(local);
        if (fs.existsSync(local)) { log('Compiler cache: using checkout cache'); return false; }
        const entry = entries().find(name => name.startsWith(key + '-'));
        if (!entry) { log('Compiler cache: miss (' + app + ')'); return false; }
        const source = path.join(appRoot, entry, 'turbopack');
        const entryStat = fs.statSync(plainPath(path.dirname(source)));
        if (process.getuid && (entryStat.uid !== process.getuid() || (entryStat.mode & 0o022))) {
          throw new Error('Cache snapshot must be private to its owner');
        }
        treeBytes(source, MAX_BYTES, true);
        fs.mkdirSync(localParent, { recursive: true });
        staging = path.join(localParent, '.songdee-restore-' + randomUUID());
        fs.cpSync(source, staging, { recursive: true, errorOnExist: true });
        treeBytes(staging);
        fs.renameSync(staging, local);
        log('Compiler cache: hit (' + app + ')');
        return true;
      } catch (error) { skipped(error); return false; }
      finally { cleanup(localParent, staging); }
    },
    discard() {
      try {
        removeChild(localParent, local);
        log('Compiler cache: retrying Next build with a cold compiler cache');
        return true;
      } catch (error) { skipped(error); return false; }
    },
    publish() {
      let staging;
      try {
        plainPath(local);
        if (!fs.existsSync(local)) { log('Compiler cache: no compiler output to save (' + app + ')'); return; }
        treeBytes(local);
        plainPath(appRoot);
        fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
        privateRoot();
        fs.mkdirSync(appRoot, { recursive: true });
        entries(); // Validate an existing app directory before writing publication staging.
        staging = path.join(appRoot, '.tmp-' + randomUUID());
        fs.mkdirSync(staging);
        fs.cpSync(local, path.join(staging, 'turbopack'), { recursive: true, errorOnExist: true });
        treeBytes(staging);
        const entry = path.join(appRoot, key + '-' + Date.now() + '-' + randomUUID());
        fs.renameSync(staging, entry);
        for (const old of entries().slice(MAX_ENTRIES)) cleanup(appRoot, path.join(appRoot, old));
        // Reap abandoned publications only after a day, without touching another active writer.
        for (const name of fs.readdirSync(appRoot)) {
          if (!/^\.tmp-[a-f0-9-]{36}$/.test(name)) continue;
          const target = path.join(appRoot, name);
          if (Date.now() - fs.lstatSync(plainPath(target)).mtimeMs > 86400000) cleanup(appRoot, target);
        }
        log('Compiler cache: saved (' + app + ')');
      } catch (error) { skipped(error); }
      finally { cleanup(appRoot, staging); }
    },
  };
}

module.exports = { compilerCache, cacheKey };
