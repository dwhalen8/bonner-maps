# Bonner Bounds — static PWA for Dokploy / any Docker host.
# Build fetches Bonner County GIS data unless public/data/parcels.geojson
# is already in the build context.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# County files are gitignored. On a fresh Dokploy git deploy they are
# missing, so pull them here. Local builds with data already on disk skip this.
RUN mkdir -p public/data raw \
    && if [ ! -s public/data/parcels.geojson ]; then npm run data; fi \
    && npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Precompress the big data files so phones download ~1/4 the bytes.
RUN find /usr/share/nginx/html -type f \( \
        -name '*.geojson' -o -name '*.json' -o -name '*.js' -o -name '*.css' \
        -o -name '*.html' -o -name '*.svg' -o -name '*.webmanifest' \
    \) -exec gzip -9 -k {} \;

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
