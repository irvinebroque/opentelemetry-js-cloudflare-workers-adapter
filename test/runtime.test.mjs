import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { postgresServer } from './postgres-server.ts';
import { writeReloadFixture } from './reload-fixture.mjs';

import { startRuntime, json, query } from './runtime-harness.mjs';

test('workerd: packaged adapter, libraries, async isolation, and recorded native parents', { timeout: 60000 }, async t => {
  const base = await startRuntime(t);
  // A real dev reload keeps OTel globals in the isolate while replacing modules.
  // register() must remain safe and the installed manager must still see new requests.
  const token = crypto.randomUUID();
  await writeReloadFixture(token);
  let reloaded = false;
  for (let i = 0; i < 50; i++) {
    try { reloaded = await (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).text() === token; } catch {}
    if (reloaded) break;
    await delay(100);
  }
  assert.equal(reloaded, true, 'Worker failed to reload with an existing OTel registration');
  const postgres = await postgresServer();
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const loaderErrors = manifest.devDependencies['@opentelemetry/instrumentation-pino'] === '0.69.0' ? 0 : 3;
  try {
    for (const path of ['/bundled', '/do/bundled']) {
      const bundled = await json(base, `${path}?port=${postgres.port}&errors=${loaderErrors}`);
      assert.equal(bundled.loaderErrors, loaderErrors);
      assert.deepEqual(bundled.libraries, ['pino', 'pg', 'graphql']);
    }
  } finally { await postgres.close(); }
  const integrationReports = (await Promise.all([
    json(base, '/integrations'), json(base, '/integrations'),
    json(base, '/do/integrations?id=library-tests'), json(base, '/do/integrations?id=library-tests'),
  ])).flat();
  const prisma = await Promise.all([json(base, '/prisma'), json(base, '/prisma'), json(base, '/do/prisma')]);
  let libraryRows = [];
  for (let i = 0; i < 50; i++) {
    libraryRows = await query(base, "SELECT trace_id, span_id, parent_id, name FROM spans WHERE name LIKE 'integration.%' OR name LIKE 'prisma:%'");
    if (integrationReports.every(report => report.spans.every(expected => libraryRows.some(row => row.span_id === expected.ids.spanId)))) break;
    await delay(100);
  }
  for (const report of integrationReports) for (const expected of report.spans) {
    const actual = libraryRows.find(row => row.span_id === expected.ids.spanId);
    assert.ok(actual, `Missing ${expected.name}`);
    assert.equal(actual.trace_id, report.root.traceId);
    assert.equal(actual.parent_id, expected.parent, expected.name);
  }
  assert.equal(libraryRows.some(row => row.name.includes('.unsupported')), false);
  for (const report of prisma) {
    const recorded = libraryRows.filter(row => row.trace_id === report.root.traceId && row.name.startsWith('prisma:'));
    assert.ok(recorded.length >= 4, `Missing Prisma operation spans: ${JSON.stringify(recorded)}`);
    assert.equal(recorded.some(row => row.name.startsWith('prisma:engine:')), false);
    for (const operation of report.operations) {
      const actual = recorded.find(row => row.span_id === operation.spanId);
      assert.ok(actual, `Missing Prisma ${operation.operation}`);
      assert.equal(actual.parent_id, report.root.spanId);
    }
  }
  const unsupported = {
    firestore: { name: 'EvalError', message: 'Code generation from strings disallowed for this context' },
    'openinference-openai': { name: 'TypeError', message: 'import_import_in_the_middle is not a constructor' },
    'openinference-langchain': { name: 'TypeError', message: 'import_import_in_the_middle is not a constructor' },
    fastify: { name: 'EvalError', message: 'Code generation from strings disallowed for this context' },
  };
  const wideReports = [];
  for (const name of ['langsmith', 'firestore', 'pubsub', 'bullmq', 'openinference-openai', 'openinference-langchain', 'fastify', 'inngest', 'sentry', 'mastra']) {
    await t.test(`wide: ${name} in Worker and Durable Object`, async () => {
      for (const path of ['/wide', '/do/wide']) {
        const report = await json(base, `${path}?name=${name}`);
        assert.deepEqual(report.error, unsupported[name], `${name} compatibility changed`);
        if (!report.error) wideReports.push(report);
      }
    });
  }
  for (const root of await Promise.all(Array.from({ length: 3 }, () => json(base, '/do/sentry')))) assert.equal(traceIdValid(root.traceId), true);
  for (const name of ['langsmith', 'pubsub', 'bullmq', 'inngest', 'mastra']) {
    const concurrent = await Promise.all(['/wide', '/wide', '/do/wide', '/do/wide'].map(path => json(base, `${path}?name=${name}`)));
    for (const report of concurrent) { assert.equal(report.error, undefined); wideReports.push(report); }
    assert.notEqual(concurrent[0].root.traceId, concurrent[1].root.traceId);
  }
  const expectedBundles = Object.fromEntries(['redis', 'ioredis', 'mongodb', 'knex', 'aws', 'kafkajs', 'amqplib', 'winston', 'undici'].map(name => [name, 'node-loader-unavailable']));
  if (manifest.devDependencies['@opentelemetry/api'] === '1.9.0') for (const name of Object.keys(expectedBundles)) expectedBundles[name] = 'initialized';
  for (const path of ['/wide-bundled', '/do/wide-bundled']) assert.deepEqual(await json(base, path), {
    ...expectedBundles, azure: 'initialized', fetch: 'initialized', fetchAttempts: 1,
  });
  // Successful producer reports must correspond to real exported native spans.
  let wideRows = [];
  for (let i = 0; i < 50; i++) {
    wideRows = await query(base, 'SELECT trace_id, span_id, parent_id, name FROM spans');
    if (wideReports.every(report => report.spans.every(expected => wideRows.some(row => row.span_id === expected.ids.spanId)))) break;
    await delay(100);
  }
  for (const report of wideReports) for (const expected of report.spans) {
    const actual = wideRows.find(row => row.span_id === expected.ids.spanId);
    assert.ok(actual, `Missing native span for ${report.name}`);
    assert.equal(actual.trace_id, report.root.traceId);
    assert.equal(actual.parent_id, expected.parent);
  }
  assert.equal(wideRows.some(row => row.name === 'wide.suppressed'), false);
  const requests = await Promise.all(Array.from({ length: 4 }, async () => {
    const response = await fetch(`${base}/test`);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  }));
  assert.equal(new Set(requests.map(r => r.root.traceId)).size, 4);
  for (const r of requests) {
    assert.match(r.root.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(r.root.traceId, '0'.repeat(32));
    for (const sc of Object.values(r)) assert.equal(sc.traceId, r.root.traceId);
  }

  let rows = [];
  for (let i = 0; i < 50; i++) {
    rows = await query(base, "SELECT trace_id, span_id, parent_id, name FROM spans WHERE name LIKE 'runtime.%' OR name LIKE 'ai.%'");
    if (requests.every(r => rows.filter(s => s.trace_id === r.root.traceId).length >= 9)) break;
    await delay(100);
  }
  for (const r of requests) {
    const spans = rows.filter(s => s.trace_id === r.root.traceId);
    assert.equal(spans.some(s => s.name.startsWith('runtime.unsupported')), false);
    const named = name => { const span = spans.find(s => s.name === name); assert.ok(span, `Missing ${name}: ${JSON.stringify(spans)}`); return span; };
    // Local Explorer currently indexes SpanOpen's name and does not apply
    // updateName. Identify this span by its native ID, independently of that UI.
    const parent = spans.find(s => s.span_id === r.parent.spanId);
    assert.ok(parent);
    assert.equal(parent.parent_id, r.root.spanId);
    assert.equal(named('runtime.manual').parent_id, r.parent.spanId);
    assert.equal(named('runtime.after-end').parent_id, r.parent.spanId);
    assert.equal(named('runtime.native').parent_id, r.parent.spanId);
    assert.equal(named('runtime.child').parent_id, r.native.spanId);
    assert.equal(named('ai.generateText').parent_id, r.parent.spanId);
    assert.equal(named('ai.generateText.doGenerate').parent_id, named('ai.generateText').span_id);
    assert.equal(named('ai.streamText').parent_id, r.parent.spanId);
    assert.equal(named('ai.streamText.doStream').parent_id, named('ai.streamText').span_id);
  }

  const retained = await json(base, '/retain');
  assert.deepEqual(await json(base, '/reuse'), retained);

  const background = await json(base, '/background');
  let backgroundRows = [];
  for (let i = 0; i < 50; i++) {
    backgroundRows = await query(base, "SELECT trace_id, span_id, parent_id FROM spans WHERE name = 'runtime.background.child'");
    if (backgroundRows.some(row => row.trace_id === background.traceId)) break;
    await delay(100);
  }
  assert.equal(backgroundRows.find(row => row.trace_id === background.traceId)?.parent_id, background.spanId);

  // Use the same object for interleaved calls and another object to check isolation.
  const id = crypto.randomUUID();
  const objects = await Promise.all([
    json(base, `/do?id=${id}`), json(base, `/do?id=${id}`),
    json(base, `/do/fetch?id=${id}`), json(base, `/do?id=${crypto.randomUUID()}`),
  ]);
  // Root identities belong to workerd; calls to the same DO can share a root.
  // Each operation still needs a distinct span and isolated logical context.
  assert.equal(new Set(objects.map(object => object.span.spanId)).size, objects.length);
  await fetch(`${base}/do/schedule?id=${id}`);
  let alarm;
  for (let i = 0; i < 50; i++) {
    alarm = await json(base, `/do/alarm?id=${id}`);
    if (alarm) break;
    await delay(100);
  }
  assert.ok(alarm, 'Durable Object alarm did not run');
  objects.push(alarm);
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/do/websocket?id=${id}`);
  t.after(() => socket.close());
  const websocketResult = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Durable Object WebSocket message timed out')), 5000);
    socket.addEventListener('error', reject, { once: true });
    socket.addEventListener('open', () => socket.send('probe'), { once: true });
    socket.addEventListener('message', event => {
      clearTimeout(timer);
      try { resolve(JSON.parse(event.data)); } catch (error) { reject(error); }
    }, { once: true });
  });
  if (traceIdValid(websocketResult.root.traceId)) objects.push(websocketResult);
  else {
    // The native parent is unexposed, but default span creation still records.
    assert.ok(traceIdValid(websocketResult.nativeIds.traceId));
    assert.equal(websocketResult.span.traceId, websocketResult.nativeIds.traceId);
    assert.equal(websocketResult.child.traceId, websocketResult.nativeIds.traceId);
  }
  socket.close(1000);
  let objectRows = [];
  for (let i = 0; i < 50; i++) {
    objectRows = await query(base, "SELECT trace_id, span_id, parent_id FROM spans WHERE name LIKE 'runtime.do%'");
    if (objects.every(object => objectRows.some(row => row.span_id === object.child.spanId))) break;
    await delay(100);
  }
  for (const object of objects) {
    assert.equal(traceIdValid(object.root.traceId), true);
    assert.equal(object.span.traceId, object.root.traceId);
    assert.equal(objectRows.find(row => row.span_id === object.span.spanId)?.parent_id, object.root.spanId);
    assert.equal(objectRows.find(row => row.span_id === object.child.spanId)?.parent_id, object.span.spanId);
  }
  const websocketSpan = objectRows.find(row => row.span_id === websocketResult.span.spanId);
  assert.ok(websocketSpan);
  assert.equal(objectRows.find(row => row.span_id === websocketResult.child.spanId)?.parent_id, websocketSpan.span_id);
  const nativeWebsocket = await query(base, "SELECT trace_id, span_id, parent_id FROM spans WHERE name = 'runtime.ws-native'");
  assert.equal(websocketSpan.parent_id, nativeWebsocket.find(row => row.span_id === websocketResult.nativeIds.spanId)?.parent_id);
});

function traceIdValid(id) { return /^[0-9a-f]{32}$/.test(id) && id !== '0'.repeat(32); }

for (const mode of ['test-disabled']) {
  test(`workerd: correlation with ${mode}`, { timeout: 60000 }, async t => {
    const base = await startRuntime(t, mode);
    const ids = await json(base, '/correlation');
    assert.equal(traceIdValid(ids.traceId), false);
  });
}
