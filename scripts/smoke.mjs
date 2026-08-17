import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyOwner } from "./classify.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const meta = JSON.parse(await readFile(join(root, "public/data/meta.json"), "utf8"));
const index = JSON.parse(await readFile(join(root, "public/data/search-index.json"), "utf8"));
const page = await fetch("http://localhost:5173/").then((r) => r.text());

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

check("parcel count", meta.count === 45723, String(meta.count));
check("addresses fetched", Number(meta.addresses) > 30000, String(meta.addresses));
check("addresses joined", Number(meta.addressesMatched) > 30000, String(meta.addressesMatched));
check("search index has addresses", index.some((r) => /circle drive/i.test(r.addr || "")));
check("search index size", index.length >= meta.count, String(index.length));
check("bbox-ish coords", index.some((r) => r.lat > 48.2 && r.lat < 48.4 && r.lng < -116.4 && r.lng > -116.7));
check("classifies USFS", classifyOwner("U S Forest Service") === "usfs");
check("classifies US gov", classifyOwner("United States Government") === "us");
check("classifies IDL", classifyOwner("State Of Idaho Department Of Lands") === "idl");
check("does not treat Foreststill as USFS", classifyOwner("Foreststill Revocable Trust") === "private");
check("app html", page.includes("Bonner Bounds") && page.includes("search-input"));

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  process.exit(1);
}
console.log(`\n${checks.length} checks passed`);
