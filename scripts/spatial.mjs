/** Lightweight spatial index + point-in-polygon for the address join. */

export function geomBBox(geom) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c) || !c.length) return;
    if (typeof c[0] === "number") {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]);
      maxY = Math.max(maxY, c[1]);
      return;
    }
    for (const n of c) walk(n);
  };
  walk(geom?.coordinates);
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, coords) {
  if (!coords?.length) return false;
  if (!pointInRing(x, y, coords[0])) return false;
  for (let i = 1; i < coords.length; i++) {
    if (pointInRing(x, y, coords[i])) return false;
  }
  return true;
}

export function pointInGeom(x, y, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInPolygon(x, y, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInPolygon(x, y, poly));
  }
  return false;
}

export class GridIndex {
  constructor(cell = 0.015) {
    this.cell = cell;
    this.cells = new Map();
  }

  key(cx, cy) {
    return `${cx}:${cy}`;
  }

  insert(id, bbox) {
    if (!bbox) return;
    const x0 = Math.floor(bbox[0] / this.cell);
    const y0 = Math.floor(bbox[1] / this.cell);
    const x1 = Math.floor(bbox[2] / this.cell);
    const y1 = Math.floor(bbox[3] / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y);
        let bucket = this.cells.get(k);
        if (!bucket) {
          bucket = [];
          this.cells.set(k, bucket);
        }
        bucket.push(id);
      }
    }
  }

  query(x, y) {
    return this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))) ?? [];
  }
}
