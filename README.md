# Bonner Bounds

Phone map of **Bonner County, Idaho** property lines. Looks like a one-county onX: red private parcels, tinted public land, GPS, search, and an offline pack.

Parcel geometry and owner names come from the [Bonner County GIS public cadastral service](https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Cadastral_Public/MapServer). That is the same assessor source onX uses. It is **not a survey**.

## Use it on your phone

```bash
cd bonner-map
npm install
npm run data      # downloads 45k+ parcels from the county GIS service
npm run dev       # serves on your LAN (proxies /api to :3000)
```

The public map does not need the API. To run it locally too:

```bash
cd api
npm install
npm run dev       # Hono on :3000, SQLite at ./data/bonner.sqlite
```

Or `DATABASE_PATH=/tmp/bonner.sqlite node dist/index.js` after `npm run build`. Vite’s `/api` proxy targets `http://127.0.0.1:3000`.

On the same Wi‑Fi, open the printed URL (something like `http://192.168.x.x:5173`). On iPhone, Share → **Add to Home Screen**. Open Layers and tap **Save county for offline** before you leave cell coverage, then switch the basemap to **Streets / topo**.

For a home-screen icon that still works after a restart with no cell, use `npm run build && npm run preview` so the service worker can cache the app shell.

iOS only allows GPS in a home-screen web app or over HTTPS. If the blue dot is blocked, use Safari’s Add to Home Screen, or put the `dist/` folder on any HTTPS host.

## What it shows

- Parcel outlines from the county assessor
- Street address from the county 911 structure layer, plus owner, PIN, acres, class, assessed value, deed
- Public-land tint from the owner name (`U S Forest Service`, `United States Government`, `State Of Idaho Department Of Lands`, county, city)
- Satellite (Esri), USGS topo, or a dark offline-friendly canvas
- Search by street address, owner, or PIN
- Follow-me GPS and “who owns the dirt under me”
- Offline pack: parcels, addresses, and USGS topo tiles for the whole county (satellite still needs cell)
- **BLP site map:** select a parcel → **Make BLP site map** → place the proposed structure, well, and septic → print or save PDF

Bonner County Building Location Permits (BCRC 11-105) need a site plan showing the structure and distances from its greatest projections to every property line, plus environmental features. This draft map is a starting point for that drawing — not a survey and not the official application.

## Deploy on Dokploy (Hostinger VPS)

This is a Compose app: nginx serves the static PWA on **port 80**, a Node API holds SQLite on a named volume, and a sidecar writes backups. Dokploy’s HTTPS proxy still terminates TLS in front of the web container.

### 1. Put the code on Git

Dokploy pulls from Git. The data files are gitignored (~36 MB), so the **web** image runs `npm run data` during the build and talks to Bonner County GIS. The VPS needs outbound HTTPS.

If this folder lives inside a larger repo, set **Root Directory** to `bonner-map`.

### 2. Create the application (Compose, not Dockerfile)

In Dokploy:

1. **Create project** → **Create application** → Git provider (or raw Git URL).
2. **Build Type:** Compose — **not** Dockerfile.
3. **Compose file:** `docker-compose.yml` (relative to the root directory above).
4. **Port:** `80` (the `web` service). Do **not** publish a host port. Dokploy’s Traefik/Caddy reaches the web container on 80.
5. Add a domain → enable HTTPS / Let’s Encrypt.
6. Optional env on the Compose service: `APP_ORIGIN=https://your-domain` (full origin).
7. Deploy.

Named volumes:

- **`plan-data`** — live SQLite (`/data/bonner.sqlite`) and uploads. This is the app volume.
- **`plan-backups`** — nightly `sqlite3 .backup` plus a tar of uploads. A different volume so a `plan-data` recreate does not wipe every copy.

Same-volume `.backup` on `plan-data` (`/data/backups/`) is only a **SQLite corruption hedge**. It dies if `plan-data` is dropped. Two Docker volumes on one VPS also die together on a disk wipe. **Off-box copy is required** for VPS-rebuild recovery: weekly `docker cp` of `plan-backups`, or a Hostinger/Dokploy snapshot (snapshot behavior is unverified).

If the API container is down, nginx still serves `/` and `/data/`. `/api/` is 502. The public county map keeps working.

### 3. After it is live

Open `https://your-domain` on the phone. iOS GPS and “Add to Home Screen” need that HTTPS. Tap **Save county for offline**, then switch the basemap to **Streets / topo**.

Rebuild the app in Dokploy whenever you want a fresh parcel snapshot (county updates daily). Claimed plans live on `plan-data` and are not replaced by a web image rebuild.

### Local image check

Web-only (no API):

```bash
npm run docker:build
npm run docker:run    # http://localhost:8080
```

Full stack (Dokploy-shaped; still no host port 80 — use `docker compose run` / exec, or add a temporary port mapping yourself):

```bash
docker compose up --build
```

## Refresh the data

County parcels update daily. Re-run `npm run data` whenever you want a new snapshot, or redeploy the Docker image so the build fetches a new one.

## Legal

Bonner County: maps are for reference only and are not a substitute for a legal survey or official records. Do not set a fence from this app. Do not sell the county’s Field Maps package.

Personal / non-commercial use of the public parcel download is the intended path.
