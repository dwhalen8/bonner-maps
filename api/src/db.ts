import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Db = Database.Database;

export const metrics = {
  puts_total: 0,
  logins_total: 0,
  login_fail_total: 0,
};

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "migrations");
  if (existsSync(bundled)) return bundled;
  return join(here, "../migrations");
}

function appliedNames(db: Db): Set<string> {
  const exists = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!exists) return new Set();
  const rows = db.prepare("SELECT name FROM schema_migrations").all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

export function migrate(db: Db): void {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const done = appliedNames(db);
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      ).run(name, new Date().toISOString());
    });
    apply();
  }
}
