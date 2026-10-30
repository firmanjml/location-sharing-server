# Location Sharing Node API

Standalone Node.js server for the Location Sharing app. It uses Node's built-in modules, so there are no packages to install. Requires Node 22.9 or newer.

## Run

```sh
cp .env.example .env
# Edit .env: set different random DEMO_TOKEN and ADMIN_TOKEN values.
npm start
```

The default port is 8787. The server listens on `0.0.0.0` for hosting platforms; set `HOST=127.0.0.1` for local-only use. Your platform can supply environment variables directly instead of using `.env`.

Publish this folder to your Node hosting provider and enable trusted HTTPS. In the iPhone app, enter:

- **HTTPS server endpoint:** `https://your-domain.example/locations`
- **Bearer token:** the value of `DEMO_TOKEN`, without the `Bearer ` prefix

Then tap **Start sharing**. The server accepts the app's default location payload. A custom template must retain the fields below or the receiver validation must be adapted to your template.

## Endpoints

| Method | Path | Authorization | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | None | Returns `{"ok":true}` |
| POST, PUT, PATCH | `/locations` | Bearer `DEMO_TOKEN` | Accept a location or batch |
| GET | `/logs?limit=50` | Bearer `ADMIN_TOKEN` | Read recent coordinate logs, newest first |
| PUT | `/interval` | Bearer `ADMIN_TOKEN` | Set the interval returned on subsequent uploads |

Example upload:

```http
POST /locations
Authorization: Bearer YOUR_UPLOAD_TOKEN
Content-Type: application/json
Idempotency-Key: 6b5c48a1-dc93-4fce-8876-825e797b21ea

{
  "location": {
    "uuid": "6b5c48a1-dc93-4fce-8876-825e797b21ea",
    "timestamp": "2026-10-30T09:00:00.000Z",
    "coords": {
      "latitude": 1.3521,
      "longitude": 103.8198,
      "accuracy": 8,
      "altitude": null,
      "speed": null,
      "heading": null
    },
    "extras": {}
  }
}
```

Successful response, with `RESPONSE_INTERVAL_SECONDS=20`:

```json
{"intervalSeconds":20}
```

A batch uses an array under `location` and a nonempty `Idempotency-Key` header. Legacy direct records and a `locations` array are also accepted. `id`/`recordedAt` aliases and numeric epoch timestamps are supported. A single upload's key must equal its UUID. The app supplies these headers automatically.

Invalid records return 400, missing/wrong tokens return 401, bodies over 8 MiB return 413, and a storage failure returns 503. Only the accepted location records are saved; authorization headers are not written to the location file.

To change pacing:

```http
PUT /interval
Authorization: Bearer YOUR_ADMIN_TOKEN
Content-Type: application/json

{"intervalSeconds":60}
```

Intervals are integers from 15 to 86400 seconds. The phone learns a change from its next successful upload. This admin setting is kept in memory; restarting restores `RESPONSE_INTERVAL_SECONDS` (default 60 when unset). It does not force a sleeping or stationary iPhone to upload on a timer.

## Stored coordinates

Each accepted record is appended to `data/locations.jsonl`, including coordinates, timestamp, extras, UUID, and server `receivedAt`. It is also logged to stdout with its coordinates. Repeated UUIDs do not append duplicate lines, including after restart.

Read logs through the API:

```sh
curl https://your-domain.example/logs?limit=50 \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN'
```

```json
{
  "count": 1,
  "locations": [{
    "id": "6b5c48a1-dc93-4fce-8876-825e797b21ea",
    "recordedAt": "2026-10-30T09:00:00.000Z",
    "coords": {"latitude": 1.3521, "longitude": 103.8198, "accuracy": 8, "altitude": null, "speed": null, "heading": null},
    "extras": {},
    "receivedAt": "2026-10-30T09:00:01.000Z"
  }]
}
```

`limit` defaults to 50 and accepts 1–500. The API exposes the latest 500 saved records; the JSON Lines file retains the full history. Log access requires the separate admin token, not the app's upload token. Responses use `Cache-Control: no-store`. Reading logs does not delete them.

To follow the file locally:

```sh
tail -f data/locations.jsonl
```

Set `LOCATIONS_FILE` to change the file path. Use a persistent disk/volume on your hosting provider to keep data across deployments. This file store is for one server process; multiple instances need a shared database with a unique constraint on UUID. Deduplication IDs are loaded into memory at startup, so use a database for long-running or high-volume deployments. Use a new UUID for each distinct location.

## Docker

```sh
docker build -t location-sharing-server .
docker run --env-file .env -p 8787:8787 -v location-data:/app/data location-sharing-server
```

Set `LOCATIONS_FILE=/app/data/locations.jsonl` in the Docker environment. Your hosting platform or reverse proxy should terminate HTTPS. Optional `TLS_CERT_FILE` and `TLS_KEY_FILE` variables enable HTTPS directly in Node.

## Check

```sh
npm test
# Optional, when Postman CLI is installed:
npm run check:http
```

Tests cover the actual HTTP receiver, authentication, valid/invalid payloads, interval updates, concurrent retry deduplication, file storage, and persistence across server restarts. They use local fixtures; the iPhone-to-published-server connection must be checked after deployment.

The optional Postman check sends six real local HTTP requests, checks upload and log permissions, and confirms a retry saves only one record. It uses generated temporary credentials and does not publish data or send request events to Postman.
