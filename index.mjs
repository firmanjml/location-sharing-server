// Standalone location receiver. Put it behind trusted HTTPS before pointing a phone at it.
import http from 'node:http';
import https from 'node:https';
import {mkdirSync, readFileSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const validInterval = value => Number.isInteger(value) && value >= 15 && value <= 86400;

// Small development store: one JSON record per line, with UUID deduplication across restarts.
export function createLocationFileStore(filename) {
  filename = resolve(filename);
  mkdirSync(dirname(filename), {recursive: true, mode: 0o700});
  const ids = new Set();
  const recent = [];
  const remember = record => { recent.push(record); if (recent.length > 500) recent.shift(); };
  try {
    for (const line of readFileSync(filename, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (typeof record.id !== 'string') throw new Error('Invalid location file record');
      ids.add(record.id);
      remember(record);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let pending = Promise.resolve();
  const save = record => {
    const write = pending.then(async () => {
      if (ids.has(record.id)) return false;
      const stored = {...record, receivedAt: new Date().toISOString()};
      await appendFile(filename, `${JSON.stringify(stored)}\n`, {mode: 0o600});
      ids.add(record.id);
      remember(stored);
      return true;
    });
    pending = write.catch(() => {});
    return write;
  };
  return {save, async getRecent(limit) { await pending; return recent.slice(-limit).reverse(); }};
}

// strict:false is for testing: any JSON body is stored as received, with an id from uuid/id, else the Idempotency-Key.
export function createReceiver({token, adminToken, intervalSeconds = 60, rootProperty = 'location', strict = true, onLocation = () => {}, getLogs = async () => []} = {}) {
  if (!token) throw new Error('Set a nonempty DEMO_TOKEN');
  if (!validInterval(intervalSeconds)) throw new Error('RESPONSE_INTERVAL_SECONDS must be an integer from 15 to 86400');
  // Demo only: bounded in-memory deduplication. Use a durable table with a unique id in production.
  const seen = new Set();
  const inFlight = new Map();
  return async (request, response) => {
    const respond = (status, body) => {
      response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url, 'http://receiver.local');
    if (url.pathname === '/health' && request.method === 'GET') return respond(200, {ok: true});
    const isAdmin = url.pathname === '/interval' || url.pathname === '/logs';
    const secret = isAdmin ? adminToken : token;
    if (!secret || request.headers.authorization !== `Bearer ${secret}`) return respond(401, {error: 'unauthorized'});
    if (url.pathname === '/logs' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return respond(400, {error: 'limit must be an integer from 1 to 500'});
      try { const locations = await getLogs(limit); return respond(200, {count: locations.length, locations}); }
      catch { return respond(503, {error: 'storage unavailable'}); }
    }
    if ((url.pathname !== '/locations' || !['POST', 'PUT', 'PATCH'].includes(request.method)) && (url.pathname !== '/interval' || request.method !== 'PUT'))
      return respond(404, {error: 'not found'});
    let body;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return respond(413, {error: 'body too large'});
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return respond(400, {error: 'invalid JSON'}); }
    if (isAdmin) {
      if (!validInterval(body?.intervalSeconds)) return respond(400, {error: 'invalid intervalSeconds'});
      intervalSeconds = body.intervalSeconds;
      return respond(200, {intervalSeconds});
    }
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const nullable = value => value === null || finite(value);
    const payload = rootProperty && Object.hasOwn(body ?? {}, rootProperty) ? body[rootProperty] : body?.locations ?? body;
    const batch = Array.isArray(payload);
    const key = request.headers['idempotency-key'];
    const records = (batch ? payload : [payload]).map((record, index) => {
      if (!strict) {
        const fields = record && typeof record === 'object' && !Array.isArray(record) ? record : {value: record};
        const own = [fields.uuid, fields.id].find(value => typeof value === 'string' && value);
        const id = own ?? (typeof key === 'string' && key ? (batch ? `${key}:${index}` : key) : randomUUID());
        return {...fields, id, recordedAt: fields.timestamp ?? fields.recordedAt ?? fields.ts};
      }
      return {...record, id: record?.uuid ?? record?.id, recordedAt: record?.timestamp ?? record?.recordedAt};
    });
    const validRecord = record => {
      const coords = record?.coords;
      return typeof record?.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)
        && (typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt))
          || typeof record.recordedAt === 'number' && Number.isFinite(record.recordedAt)) && coords
        && finite(coords.latitude) && Math.abs(coords.latitude) <= 90
        && finite(coords.longitude) && Math.abs(coords.longitude) <= 180
        && finite(coords.accuracy) && coords.accuracy >= 0
        && nullable(coords.altitude) && nullable(coords.speed) && nullable(coords.heading)
        && record.extras && typeof record.extras === 'object' && !Array.isArray(record.extras);
    };
    if (strict && (!records.length || !records.every(validRecord)
        || typeof request.headers['idempotency-key'] !== 'string' || !request.headers['idempotency-key']
        || (!batch && request.headers['idempotency-key'] !== records[0].id)))
      return respond(400, {error: 'invalid location record'});
    for (const record of records) {
      if (seen.has(record.id)) continue;
      let write = inFlight.get(record.id);
      if (!write) {
        write = Promise.resolve().then(() => onLocation(record)).then(() => {
          seen.add(record.id);
          if (seen.size > 10000) seen.delete(seen.values().next().value);
        });
        inFlight.set(record.id, write);
      }
      try { await write; } catch { return respond(503, {error: 'storage unavailable'}); }
      finally { if (inFlight.get(record.id) === write) inFlight.delete(record.id); }
    }
    return respond(200, {intervalSeconds});
  };
}

export function startServer() {
  const filename = resolve(process.env.LOCATIONS_FILE ?? 'data/locations.jsonl');
  const store = createLocationFileStore(filename);
  const handler = createReceiver({token: process.env.DEMO_TOKEN, adminToken: process.env.ADMIN_TOKEN,
    intervalSeconds: Number(process.env.RESPONSE_INTERVAL_SECONDS ?? 60),
    strict: process.env.STRICT_VALIDATION === '1',
    getLogs: limit => store.getRecent(limit),
    onLocation: async record => {
      if (await store.save(record)) console.log(JSON.stringify({receivedAt: new Date().toISOString(), id: record.id,
        latitude: record.coords?.latitude ?? record.lat ?? record.latitude, longitude: record.coords?.longitude ?? record.lng ?? record.longitude,
        recordedAt: record.recordedAt}));
    }});
  const tls = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE;
  const server = tls ? https.createServer({cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE)}, handler)
    : http.createServer(handler);
  server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '0.0.0.0', () => {
    console.log(`Reference receiver on ${tls ? 'https' : 'http'}://${process.env.HOST ?? '0.0.0.0'}:${server.address().port}`);
    console.log(`Locations are saved to ${filename}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
