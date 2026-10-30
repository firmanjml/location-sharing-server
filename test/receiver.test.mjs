import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReceiver, createLocationFileStore} from '../index.mjs';

const fix = {
  id: '6b5c48a1-dc93-4fce-8876-825e797b21ea', recordedAt: '2026-10-30T09:00:00.000Z',
  coords: {latitude: 1.3521, longitude: 103.8198, accuracy: 8, altitude: null, speed: null, heading: null}, extras: {},
};
async function fixture(t, options = {}) {
  const server = http.createServer(createReceiver({token: 'test-only', adminToken: 'admin-test-only', ...options}));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (path, body, token = 'test-only', method = path === '/interval' ? 'PUT' : 'POST') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': fix.id},
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}
test('server interval changes reach the phone in the next upload response', async t => {
  const request = await fixture(t);
  assert.deepEqual(await (await request('/locations', fix)).json(), {intervalSeconds: 60});
  assert.equal((await request('/interval', {intervalSeconds: 120}, 'admin-test-only')).status, 200);
  assert.deepEqual(await (await request('/locations', fix)).json(), {intervalSeconds: 120});
  assert.equal((await request('/interval', {intervalSeconds: 0}, 'admin-test-only')).status, 400);
  assert.equal((await request('/interval', {intervalSeconds: 30}, 'test-only')).status, 401);
});
test('PUT batch retries deduplicate individual fixes and reject invalid batches before writes', async t => {
  const stored = [];
  const request = await fixture(t, {onLocation: record => stored.push(record.id)});
  const second = {...fix, id: '6b5c48a1-dc93-4fce-8876-825e797b21eb'};
  const body = {locations: [fix, second], fleet: 'test'};
  assert.equal((await request('/locations', body, 'test-only', 'PUT')).status, 200);
  assert.equal((await request('/locations', body, 'test-only', 'PUT')).status, 200);
  assert.deepEqual(stored, [fix.id, second.id]);
  assert.equal((await request('/locations', {locations: []})).status, 400);
  assert.equal((await request('/locations', {locations: [fix, {...second, coords: {}}]})).status, 400);
  assert.equal(stored.length, 2);
});
test('SDK rootProperty, PATCH, uuid/timestamp and epoch payloads are accepted', async t => {
  const stored = [];
  const request = await fixture(t,{onLocation: record => stored.push(record.id)});
  const sdk = {uuid:fix.id,timestamp:Date.parse(fix.recordedAt),coords:fix.coords,extras:{}};
  assert.equal((await request('/locations',{location:sdk},'test-only','PATCH')).status,200);
  assert.equal((await request('/locations',{location:[sdk]},'test-only','PUT')).status,200);
  assert.deepEqual(stored,[fix.id]);
});
test('repeated and concurrent retries create one side effect for one id', async t => {
  let writes = 0;
  const request = await fixture(t, {onLocation: async () => { writes++; await new Promise(resolve => setTimeout(resolve, 10)); }});
  const responses = await Promise.all([request('/locations', fix), request('/locations', fix)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal((await request('/locations', fix)).status, 200);
  assert.equal(writes, 1);
});
test('authentication, invalid fix, and transient storage error have distinct results', async t => {
  const request = await fixture(t, {onLocation: async () => { throw new Error('storage down'); }});
  assert.equal((await request('/locations', fix, 'wrong')).status, 401);
  assert.equal((await request('/locations', {...fix, coords: {...fix.coords, latitude: 100}})).status, 400);
  assert.equal((await request('/locations', fix)).status, 503);
});
test('health is public but upload still requires authentication', async t => {
  const request = await fixture(t);
  const response = await request('/health', undefined, '', 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});
  assert.equal((await request('/locations', fix, '')).status, 401);
});
test('file receiver stores coordinates and deduplicates retries across server restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'location-receiver-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = join(directory, 'locations.jsonl');
  const store = createLocationFileStore(filename);
  const request = await fixture(t, {onLocation: store.save});
  assert.equal((await request('/locations', {location: fix})).status, 200);
  const restarted = await fixture(t, {onLocation: createLocationFileStore(filename).save});
  assert.equal((await restarted('/locations', {location: fix})).status, 200);
  const lines = (await readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].coords, fix.coords);
  assert.ok(Number.isFinite(Date.parse(lines[0].receivedAt)));
});
test('coordinate logs require admin credentials and return newest first with a bounded limit after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'location-log-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = join(directory, 'locations.jsonl');
  const store = createLocationFileStore(filename);
  const request = await fixture(t, {onLocation: store.save, getLogs: store.getRecent});
  assert.equal((await request('/logs', undefined, '', 'GET')).status, 401);
  assert.equal((await request('/logs', undefined, 'test-only', 'GET')).status, 401);
  assert.deepEqual(await (await request('/logs', undefined, 'admin-test-only', 'GET')).json(), {count: 0, locations: []});
  const second = {...fix, id: '6b5c48a1-dc93-4fce-8876-825e797b21eb', coords: {...fix.coords, latitude: 2}};
  assert.equal((await request('/locations', {locations: [fix, second]})).status, 200);
  const response = await request('/logs?limit=1', undefined, 'admin-test-only', 'GET');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.locations[0].id, second.id);
  assert.equal(body.locations[0].coords.latitude, 2);
  const restored = createLocationFileStore(filename);
  assert.deepEqual((await restored.getRecent(50)).map(record => record.id), [second.id, fix.id]);
  for (const limit of ['0','-1','501','nope','1.5']) assert.equal((await request(`/logs?limit=${limit}`, undefined, 'admin-test-only', 'GET')).status, 400);
});
test('strict:false accepts any JSON shape, such as a flat custom template, and still deduplicates', async t => {
  const stored = [];
  const request = await fixture(t, {strict: false, onLocation: record => stored.push(record)});
  const flat = {device: 'x', lat: 1.3, lng: 103.8, ts: '2026-10-30T09:00:00Z', moving: true, battery: 0.9};
  assert.equal((await request('/locations', flat)).status, 200);
  assert.equal((await request('/locations', flat)).status, 200);
  assert.equal((await request('/locations', {location: flat})).status, 200);
  assert.equal((await request('/locations', {anything: [1, 2]})).status, 200);
  assert.equal((await request('/locations', [flat, 'text', 7])).status, 200);
  assert.equal((await request('/locations', fix, 'wrong')).status, 401);
  assert.equal(stored[0].id, fix.id);
  assert.equal(stored[0].lat, 1.3);
  assert.equal(stored[0].recordedAt, flat.ts);
  assert.equal(stored.filter(record => record.id === fix.id).length, 1);
  assert.equal(stored.at(-1).value, 7);
});
