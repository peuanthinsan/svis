const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Keep transaction and cloud-routing tests entirely offline. The fake pool
// records the actual SQL/control sequence sent by the production adapter.
function adapter({ failOn, commitCommand = 'COMMIT' } = {}) {
  const calls = [];
  const poolOptions = [];
  const cloud = { query: 'cloud-query-client' };
  const query = async (text, values) => {
    calls.push({ text, values });
    if (text === failOn) throw new Error('query failed');
    return { rows: [{ text }], command: text === 'COMMIT' ? commitCommand : text };
  };
  class Pool {
    constructor(options) { poolOptions.push(options); }
    on() {}
    query(...args) { return query(...args); }
    async connect() {
      calls.push({ text: 'CONNECT' });
      return { query, release: () => calls.push({ text: 'RELEASE' }) };
    }
    async end() { calls.push({ text: 'END' }); }
  }
  const context = {
    module: { exports: {} }, URL, console: { error() {} },
    require(name) {
      if (name === 'pg') return { Pool };
      if (name === '@neondatabase/serverless') return { neon: url => {
        calls.push({ text: 'NEON_HTTP', url });
        return cloud;
      } };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pg-neon.cjs'), 'utf8'), context);
  return { ...context.module.exports, calls, poolOptions, cloud };
}

const local = 'postgresql://dummy:dummy@127.0.0.1:54329/build_only';

test('Neon URLs retain the cloud HTTP client and skip local transactions', async () => {
  const a = adapter();
  const url = 'postgresql://dummy:dummy@ep-test.us-east-1.aws.neon.tech/build_only';
  assert.equal(a.neon(url), a.cloud);
  assert.equal(await a.withRequestTransaction(url, async () => 'cloud-result'), 'cloud-result');
  assert.equal(a.poolOptions.length, 0);
  assert.deepEqual(a.calls.map(c => c.text), ['NEON_HTTP']);
});

test('the TCP adapter allows loopback including IPv6 and refuses other database hosts', () => {
  const a = adapter();
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    a.neon(`postgresql://dummy:dummy@${host}:54329/build_only`);
  }
  for (const host of ['192.0.2.1', 'example.com', 'neon.tech.example.com']) {
    assert.throws(() => a.neon(`postgresql://dummy:dummy@${host}/build_only`), /Unapproved database host/);
  }
  assert.equal(a.poolOptions.length, 3);
});

test('tagged queries are parameterized and execute once when awaited repeatedly', async () => {
  const a = adapter();
  const sql = a.neon(local);
  const pending = sql`SELECT ${'untrusted value'}::text, ${42}::int`;
  assert.equal(a.calls.length, 0);
  await pending;
  await pending;
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].text, 'SELECT $1::text, $2::int');
  assert.equal(JSON.stringify(a.calls[0].values), JSON.stringify(['untrusted value', 42]));
  assert.throws(() => sql('SELECT 1'), /tagged template/);
});

test('request transactions use savepoints for SQL batches and notify only after commit', async () => {
  const a = adapter();
  const sql = a.neon(local);
  const result = await a.withRequestTransaction(local, async () => {
    await sql.query('SAVE_INSPECTION');
    await sql.transaction([sql.query('SET_RLS'), sql.query('SAVE_RESULTS')]);
    await a.afterCommit(() => a.calls.push({ text: 'NOTIFY' }));
    assert.equal(a.calls.some(c => c.text === 'NOTIFY'), false);
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual(a.calls.map(c => c.text), [
    'CONNECT', 'BEGIN', 'SAVE_INSPECTION', 'SAVEPOINT svis_batch_1', 'SET_RLS',
    'SAVE_RESULTS', 'RELEASE SAVEPOINT svis_batch_1', 'COMMIT', 'RELEASE', 'NOTIFY',
  ]);
});

test('unsuccessful responses roll back and discard queued notifications', async () => {
  const a = adapter();
  await a.withRequestTransaction(local, async () => {
    await a.afterCommit(() => a.calls.push({ text: 'NOTIFY' }));
  }, () => false);
  assert.deepEqual(a.calls.map(c => c.text), ['CONNECT', 'BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('query errors and silently aborted commits fail the request and release the client', async () => {
  for (const options of [{ failOn: 'SAVE' }, { commitCommand: 'ROLLBACK' }]) {
    const a = adapter(options);
    const sql = a.neon(local);
    await assert.rejects(a.withRequestTransaction(local, async () => {
      await a.afterCommit(() => a.calls.push({ text: 'NOTIFY' }));
      await sql.query('SAVE');
    }), /query failed|did not commit/);
    assert.deepEqual(a.calls.slice(-2).map(c => c.text), ['ROLLBACK', 'RELEASE']);
    assert.equal(a.calls.some(c => c.text === 'NOTIFY'), false);
  }
});

test('a notification failure after commit does not fail an already saved response', async () => {
  const a = adapter();
  assert.equal(await a.withRequestTransaction(local, async () => {
    await a.afterCommit(async () => { throw new Error('mail unavailable'); });
    return 'saved';
  }), 'saved');
  assert.deepEqual(a.calls.map(c => c.text), ['CONNECT', 'BEGIN', 'COMMIT', 'RELEASE']);
});
