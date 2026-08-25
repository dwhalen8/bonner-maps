import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { mountAttachments } from "./attachments";
import { assertMailerForProduction, mountAuth } from "./auth";
import { migrate, metrics, openDatabase } from "./db";
import { mountGis } from "./gis";
import { mountPlans } from "./plans";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/bonner.sqlite";
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./data/uploads";
const PORT = Number(process.env.PORT ?? 3000) || 3000;

assertMailerForProduction();

mkdirSync(UPLOAD_DIR, { recursive: true });

const db = openDatabase(DATABASE_PATH);
migrate(db);

const api = new Hono();

api.get("/healthz", (c) => {
  try {
    const ping = db.prepare("SELECT 1 AS db").get() as { db: number };
    const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number })
      .n;
    const plans = (db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number })
      .n;
    return c.json({
      ok: true,
      db: ping.db,
      users,
      plans,
      puts_total: metrics.puts_total,
      logins_total: metrics.logins_total,
      login_fail_total: metrics.login_fail_total,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ msg: "healthz failed", err: String(err) }),
    );
    return c.json(
      {
        ok: false,
        db: 0,
        users: 0,
        plans: 0,
        puts_total: metrics.puts_total,
        logins_total: metrics.logins_total,
        login_fail_total: metrics.login_fail_total,
      },
      503,
    );
  }
});

mountAuth(api, db);
mountPlans(api, db);
mountAttachments(api, db, UPLOAD_DIR);
mountGis(api, db);

const app = new Hono();
app.route("/api", api);

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(
    JSON.stringify({ msg: "api listening", port: info.port, db: DATABASE_PATH }),
  );
});
