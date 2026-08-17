import type { SearchHit } from "./types";

let index: SearchHit[] = [];

export async function loadSearchIndex() {
  const res = await fetch("/data/search-index.json");
  if (!res.ok) throw new Error("Search index missing. Run npm run data.");
  index = (await res.json()) as SearchHit[];
  return index.length;
}

function norm(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function searchParcels(query: string, limit = 12): SearchHit[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const compact = q.replace(/\s+/g, "");
  const out: SearchHit[] = [];
  for (const row of index) {
    const hay = norm(`${row.addr ?? ""} ${row.o} ${row.o2} ${row.pin}`);
    const pin = (row.pin || "").toLowerCase().replace(/\s+/g, "");
    if (hay.includes(q) || (compact.length > 3 && pin.includes(compact))) {
      out.push(row);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function findByPin(pin: string) {
  return index.find((row) => row.pin === pin) ?? null;
}
