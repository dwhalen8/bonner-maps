# Bonner Bounds

Phone map of **Bonner County, Idaho** property lines. Looks like a one-county onX: red private parcels, tinted public land, GPS, search, and an offline pack.

Parcel geometry and owner names come from the [Bonner County GIS public cadastral service](https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Cadastral_Public/MapServer). That is the same assessor source onX uses. It is **not a survey**.

## Use it on your phone

```bash
cd bonner-map
npm install
npm run data      # downloads 45k+ parcels from the county GIS service
npm run dev       # serves on your LAN
```

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

## Deploy on Dokploy (Hostinger VPS)

This app is a static PWA. The Docker image builds it, pulls the latest county parcels if they are not already in the tree, and serves on **port 80** behind Dokploy’s HTTPS proxy.

### 1. Put the code on Git

Dokploy pulls from Git. The data files are gitignored (~36 MB), so the image runs `npm run data` during the build and talks to Bonner County GIS. The VPS needs outbound HTTPS.

If this folder lives inside a larger repo, set **Root Directory** to `bonner-map`.

### 2. Create the application

In Dokploy:

1. **Create project** → **Create application** → Git provider (or raw Git URL).
2. **Build Type:** Dockerfile
3. **Dockerfile path:** `./Dockerfile` (relative to the root directory above)
4. **Port:** `80`
5. Do **not** publish a host port. Dokploy’s Traefik/Caddy reaches the container on 80.
6. Add a domain → enable HTTPS / Let’s Encrypt.
7. Deploy.

Compose works the same: point a Compose service at `docker-compose.yml`. Still attach the domain in the UI.

### 3. After it is live

Open `https://your-domain` on the phone. iOS GPS and “Add to Home Screen” need that HTTPS. Tap **Save county for offline**, then switch the basemap to **Streets / topo**.

Rebuild the app in Dokploy whenever you want a fresh parcel snapshot (county updates daily).

### Local image check

```bash
npm run docker:build
npm run docker:run    # http://localhost:8080
```

## Refresh the data

County parcels update daily. Re-run `npm run data` whenever you want a new snapshot, or redeploy the Docker image so the build fetches a new one.

## Legal

Bonner County: maps are for reference only and are not a substitute for a legal survey or official records. Do not set a fence from this app. Do not sell the county’s Field Maps package.

Personal / non-commercial use of the public parcel download is the intended path.
