import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReloadFixture } from './reload-fixture.mjs';

// Use the Cloudflare Vite plugin and Local Explorer, so this verifies the actual Worker
// bundle, runtime API, and recorded trace hierarchy, not our unit-test model.
// cf dev currently rejects the multiple framework dependencies in this test repo.
export async function startRuntime(t, mode = 'test') {
  await writeReloadFixture();
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', mode], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Local Explorer normally forces recording independently of production config.
    env: { ...process.env, OTEL_TEST_PORT: String(port), CI: 'true',
      X_LOCAL_OBSERVABILITY: mode === 'test-disabled' ? 'false' : 'true' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-15000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-15000); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (!child.pid || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exited, delay(2000, undefined, { ref: false })]);
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Worker dev server exited: ${output}`);
    try { ready = (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, output);
  return base;
}

export async function json(base, path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

export async function query(base, sql) {
  const response = await fetch(`${base}/cdn-cgi/local/explorer/api/local/observability/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000), body: JSON.stringify({ sql }),
  });
  const payload = await response.json();
  assert.equal(payload.success, true, JSON.stringify(payload));
  return payload.result.rows.map(row => Object.fromEntries(payload.result.columns.map((column, i) => [column, row[i]])));
}

