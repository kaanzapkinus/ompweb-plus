import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agyFailover from '../agy-failover.ts';

const CHAIN = ['provider-a/model-a', 'provider-b/model-b'];
const QUOTA_ERROR = 'The usage limit has been reached (code=usage_limit_reached)';

function executionJob(sessionId, patch = {}) {
  return {
    id: 'synthetic-job', sessionId, provider: 'provider-a', modelId: 'model-a',
    prompt: 'Synthetic scheduled prompt', createdAt: 1, runAt: null,
    kind: 'prompt', status: 'completed', ...patch,
  };
}

async function fixture(run, { chain = JSON.stringify(CHAIN), unavailable = [], rejected = [], throwing = [], aliases = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-failover-test-'));
  const previous = new Map(['PI_CODING_AGENT_DIR', 'OMP_AGY_FAILOVER_CHAIN'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (chain === undefined) delete process.env.OMP_AGY_FAILOVER_CHAIN;
  else process.env.OMP_AGY_FAILOVER_CHAIN = chain;
  let stop;
  let current = { provider: 'selected-provider', id: 'selected-model' };
  let message = { role: 'assistant', stopReason: 'error', errorMessage: QUOTA_ERROR };
  const switched = [];
  const attempted = [];
  agyFailover({
    on(name, handler) { if (name === 'session_stop') stop = handler; },
    async setModel(model) {
      const key = `${model.provider}/${model.id}`;
      attempted.push(key);
      if (throwing.includes(key)) throw new Error('Model switch unavailable');
      if (rejected.includes(key)) return false;
      current = model;
      switched.push(model);
      return true;
    },
  });
  const ctx = {
    sessionManager: {
      getSessionId: () => dir,
      getBranch: () => [{ type: 'message', message }, { type: 'message', message: { role: 'toolResult' } }],
    },
    models: {
      current: () => current,
      resolve(spec) {
        if (unavailable.includes(spec)) return undefined;
        const [provider, ...id] = (aliases[spec] || spec).split('/');
        return { provider, id: id.join('/') };
      },
    },
  };
  const policy = (mode, jobs = []) => writeFileSync(join(dir, 'web-session-execution.json'), JSON.stringify({
    version: 1,
    policies: { [dir]: { mode } },
    jobs: jobs.map(job => executionJob(job.sessionId ?? dir, job)),
  }));
  try {
    await run({
      stop: () => stop({}, ctx), switched, attempted, policy, dir,
      setMessage: value => { message = value; },
      setCurrent: value => { current = value; },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('quota waiting blocks configured fallback and continuation', () => fixture(async ({ stop, switched, policy }) => {
  policy('wait');
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, []);
}));

test('a scheduled running job blocks configured fallback even with fallback policy', () => fixture(async ({ stop, switched, policy }) => {
  policy('fallback', [{ status: 'running' }]);
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, []);
}));

test('an explicit fallback policy permits the configured continuation', () => fixture(async ({ stop, switched, policy }) => {
  policy('fallback');
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-a', id: 'model-a' }]);
}));

test('policy changes on an already-loaded hook take effect before quota fallback', () => fixture(async ({ stop, switched, policy }) => {
  policy('fallback');
  policy('wait');
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, []);
}));

for (const metadata of ['{broken', 'null', '{"version":2,"policies":{},"jobs":[]}', '{"version":1,"policies":[],"jobs":[]}']) {
  test(`invalid execution metadata cannot authorize a model change: ${metadata}`, () => fixture(async ({ stop, switched, dir }) => {
    writeFileSync(join(dir, 'web-session-execution.json'), metadata);
    assert.equal(await stop(), undefined);
    assert.deepEqual(switched, []);
  }));
}

for (const policyValue of [null, false, 0, '', [], {}, { mode: null }, { mode: 'unknown' }]) {
  test(`a present invalid session policy blocks fallback: ${JSON.stringify(policyValue)}`, () => fixture(async ({ stop, switched, dir }) => {
    writeFileSync(join(dir, 'web-session-execution.json'), JSON.stringify({
      version: 1, policies: { [dir]: policyValue }, jobs: [],
    }));
    assert.equal(await stop(), undefined);
    assert.deepEqual(switched, []);
  }));
}

test('an absent own session policy permits configured native fallback', () => fixture(async ({ stop, switched, dir }) => {
  writeFileSync(join(dir, 'web-session-execution.json'), JSON.stringify({
    version: 1, policies: {}, jobs: [],
  }));
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-a', id: 'model-a' }]);
}));

for (const patch of [
  { status: null }, { status: 'unknown' }, { sessionId: null },
  { id: null }, { provider: false }, { modelId: 0 }, { prompt: [] },
  { createdAt: null }, { runAt: 'later' }, { kind: 'unknown' },
]) {
  test(`malformed job fields cannot authorize fallback: ${JSON.stringify(patch)}`, () => fixture(async ({ stop, switched, dir }) => {
    writeFileSync(join(dir, 'web-session-execution.json'), JSON.stringify({
      version: 1, policies: { [dir]: { mode: 'fallback' } },
      jobs: [executionJob(dir, patch)],
    }));
    assert.equal(await stop(), undefined);
    assert.deepEqual(switched, []);
  }));
}

for (const job of [null, false, 0, [], {}]) {
  test(`malformed job records cannot authorize fallback: ${JSON.stringify(job)}`, () => fixture(async ({ stop, switched, dir }) => {
    writeFileSync(join(dir, 'web-session-execution.json'), JSON.stringify({
      version: 1, policies: { [dir]: { mode: 'fallback' } }, jobs: [job],
    }));
    assert.equal(await stop(), undefined);
    assert.deepEqual(switched, []);
  }));
}

test('unreadable execution metadata cannot authorize a model change', () => fixture(async ({ stop, switched, dir }) => {
  mkdirSync(join(dir, 'web-session-execution.json'));
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, []);
}));

test('a native-only chat without web metadata retains configured fallback', () => fixture(async ({ stop, switched }) => {
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-a', id: 'model-a' }]);
}));

test('another session running and completed jobs do not block this session', () => fixture(async ({ stop, policy, switched }) => {
  policy('fallback', [{ status: 'running', sessionId: 'another-session' }, { status: 'completed' }]);
  assert.equal((await stop()).continue, true);
  assert.equal(switched.length, 1);
}));

test('installing without an explicitly configured chain never switches models', () => fixture(async ({ stop, switched }) => {
  delete process.env.OMP_AGY_FAILOVER_CHAIN;
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, []);
}));

for (const chain of ['', '{broken', '{}', '[]', '["provider-a/model-a",null]', '["model-without-provider"]']) {
  test(`invalid or empty chain never switches models: ${chain}`, () => fixture(async ({ stop, switched }) => {
    assert.equal(await stop(), undefined);
    assert.deepEqual(switched, []);
  }, { chain }));
}

test('the configured chain order replaces model-family defaults', () => fixture(async ({ stop, switched, setCurrent }) => {
  setCurrent({ provider: 'selected-provider', id: 'claude-synthetic' });
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-b', id: 'model-b' }]);
}, { chain: JSON.stringify([...CHAIN].reverse()) }));

test('the next terminal hook rereads the configured chain', () => fixture(async ({ stop, switched }) => {
  process.env.OMP_AGY_FAILOVER_CHAIN = '["provider-c/model-c"]';
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-c', id: 'model-c' }]);
}));

test('a failed fallback chain never repeats a tried model', () => fixture(async ({ stop, switched }) => {
  assert.equal((await stop()).continue, true);
  assert.equal((await stop()).continue, true);
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, [{ provider: 'provider-a', id: 'model-a' }, { provider: 'provider-b', id: 'model-b' }]);
}));

test('the selected model and aliases of tried models are skipped', () => fixture(async ({ stop, switched, setCurrent }) => {
  setCurrent({ provider: 'provider-a', id: 'model-a' });
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-b', id: 'model-b' }]);
}, { chain: '["provider-a/model-a","alias/model-a","provider-b/model-b"]', aliases: { 'alias/model-a': 'provider-a/model-a' } }));

test('successful turns reset the session tried-model state', () => fixture(async ({ stop, switched, setMessage, setCurrent }) => {
  await stop();
  await stop();
  assert.equal(await stop(), undefined);
  setMessage({ role: 'assistant', stopReason: 'stop' });
  assert.equal(await stop(), undefined);
  setCurrent({ provider: 'selected-provider', id: 'selected-model' });
  setMessage({ role: 'assistant', stopReason: 'error', errorMessage: QUOTA_ERROR });
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched.at(-1), { provider: 'provider-a', id: 'model-a' });
  assert.equal(switched.length, 3);
}));

test('unresolvable models are skipped without changing the configured order', () => fixture(async ({ stop, switched }) => {
  assert.equal((await stop()).continue, true);
  assert.deepEqual(switched, [{ provider: 'provider-b', id: 'model-b' }]);
}, { unavailable: ['provider-a/model-a'] }));

for (const failure of ['rejected', 'throwing']) {
  test(`${failure} model switches advance without retrying the same model`, () => fixture(async ({ stop, attempted, switched }) => {
    assert.equal((await stop()).continue, true);
    assert.equal(await stop(), undefined);
    assert.deepEqual(attempted, ['provider-a/model-a', 'provider-b/model-b']);
    assert.deepEqual(switched, [{ provider: 'provider-b', id: 'model-b' }]);
  }, { [failure]: ['provider-a/model-a'] }));
}

test('non-quota terminal errors do not change the selected model', () => fixture(async ({ stop, switched, setMessage }) => {
  setMessage({ role: 'assistant', stopReason: 'error', errorMessage: 'Authentication failed' });
  assert.equal(await stop(), undefined);
  assert.deepEqual(switched, []);
}));
