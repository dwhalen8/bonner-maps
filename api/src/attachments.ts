import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Context, Hono } from "hono";
import { userFromRequest } from "./auth";
import type { Db } from "./db";
import { zipStore } from "./zip";

const MAX_FILE = 10_000_000;
const MAX_USER = 50_000_000;
const KINDS = new Set(["floor_plan", "elevation", "deed", "fire_signoff", "other"]);
const MIMES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
};

type AttRow = {
  id: string;
  plan_id: string;
  kind: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  disk_path: string;
  created_at: string;
  deleted_at: string | null;
};

function fail(c: Context, status: 400 | 401 | 404 | 413, error: string, code: string) {
  return c.json({ error, code }, status);
}

function livePlan(db: Db, userId: string, planId: string) {
  return db
    .prepare(
      `SELECT id FROM plans WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(planId, userId) as { id: string } | undefined;
}

function quotaUsed(db: Db, userId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS n
       FROM attachments
       WHERE deleted_at IS NULL
         AND plan_id IN (SELECT id FROM plans WHERE user_id = ?)`,
    )
    .get(userId) as { n: number };
  return Number(row.n);
}

function sniffMime(file: File, declared: string): string | null {
  const raw = (declared || file.type || "").toLowerCase();
  if (MIMES[raw]) return raw;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return null;
}

function safeName(name: string) {
  const base = basename(name).replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120);
  return base || "upload.bin";
}

export function mountAttachments(api: Hono, db: Db, uploadDir: string): void {
  mkdirSync(uploadDir, { recursive: true });

  api.get("/plans/:id/attachments", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const planId = c.req.param("id");
    if (!livePlan(db, user.id, planId)) return fail(c, 404, "Plan not found", "not_found");
    const rows = db
      .prepare(
        `SELECT id, kind, filename, mime, bytes, created_at
         FROM attachments WHERE plan_id = ? AND deleted_at IS NULL
         ORDER BY created_at`,
      )
      .all(planId) as {
      id: string;
      kind: string;
      filename: string;
      mime: string;
      bytes: number;
      created_at: string;
    }[];
    return c.json(rows);
  });

  api.post("/plans/:id/attachments", async (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const planId = c.req.param("id");
    if (!livePlan(db, user.id, planId)) return fail(c, 404, "Plan not found", "not_found");

    const body = await c.req.parseBody();
    const file = body.file;
    const kind = String(body.kind ?? "other");
    if (!(file instanceof File)) return fail(c, 400, "file field required", "bad_request");
    if (!KINDS.has(kind)) return fail(c, 400, "Unknown attachment kind", "bad_request");
    if (file.size > MAX_FILE) return fail(c, 413, "File exceeds 10 MB", "payload_too_large");
    const mime = sniffMime(file, file.type);
    if (!mime) return fail(c, 400, "Use PDF, JPEG, PNG, or HEIC", "unsupported_type");
    if (quotaUsed(db, user.id) + file.size > MAX_USER) {
      return fail(c, 413, "Account attachment quota is 50 MB", "quota");
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const id = randomUUID();
    const dir = join(uploadDir, user.id);
    mkdirSync(dir, { recursive: true });
    const disk = join(dir, id);
    writeFileSync(disk, buf);
    const sha = createHash("sha256").update(buf).digest("hex");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO attachments
        (id, plan_id, kind, filename, mime, bytes, sha256, disk_path, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, planId, kind, safeName(file.name), mime, buf.length, sha, disk, now);
    return c.json({ id, kind, filename: safeName(file.name), mime, bytes: buf.length, created_at: now }, 201);
  });

  api.get("/plans/:id/attachments/:attId", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const planId = c.req.param("id");
    if (!livePlan(db, user.id, planId)) return fail(c, 404, "Plan not found", "not_found");
    const row = db
      .prepare(
        `SELECT * FROM attachments WHERE id = ? AND plan_id = ? AND deleted_at IS NULL`,
      )
      .get(c.req.param("attId"), planId) as AttRow | undefined;
    if (!row) return fail(c, 404, "Attachment not found", "not_found");
    const data = readFileSync(row.disk_path);
    return new Response(data, {
      headers: {
        "content-type": row.mime,
        "content-disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
        "cache-control": "no-store",
      },
    });
  });

  api.delete("/plans/:id/attachments/:attId", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const planId = c.req.param("id");
    if (!livePlan(db, user.id, planId)) return fail(c, 404, "Plan not found", "not_found");
    const row = db
      .prepare(
        `SELECT * FROM attachments WHERE id = ? AND plan_id = ? AND deleted_at IS NULL`,
      )
      .get(c.req.param("attId"), planId) as AttRow | undefined;
    if (!row) return fail(c, 404, "Attachment not found", "not_found");
    db.prepare(`UPDATE attachments SET deleted_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      row.id,
    );
    return c.body(null, 204);
  });

  api.get("/plans/:id/attachments.zip", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const planId = c.req.param("id");
    const plan = db
      .prepare(
        `SELECT id, pin, doc FROM plans WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(planId, user.id) as { id: string; pin: string; doc: string } | undefined;
    if (!plan) return fail(c, 404, "Plan not found", "not_found");
    const rows = db
      .prepare(
        `SELECT * FROM attachments WHERE plan_id = ? AND deleted_at IS NULL ORDER BY created_at`,
      )
      .all(planId) as AttRow[];
    const files = [
      {
        name: "README.txt",
        data: Buffer.from(
          "Print the site plan from Bonner Bounds; this ZIP is not the drawing.\n" +
            "Official filing: https://www.bonnercountyid.gov/building-location-permit\n",
          "utf8",
        ),
      },
      {
        name: "checklist.json",
        data: Buffer.from(
          JSON.stringify(
            {
              pin: plan.pin,
              attachments: rows.map((row) => ({
                id: row.id,
                kind: row.kind,
                filename: row.filename,
                bytes: row.bytes,
              })),
              note: "Print the site plan from Bonner Bounds. This ZIP is not the drawing.",
            },
            null,
            2,
          ),
          "utf8",
        ),
      },
    ];
    for (const row of rows) {
      try {
        files.push({ name: `${row.kind}-${row.filename}`, data: readFileSync(row.disk_path) });
      } catch {
        /* skip missing disk files */
      }
    }
    const zip = zipStore(files);
    return new Response(zip, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="blp-attachments-${plan.pin}.zip"`,
        "cache-control": "no-store",
      },
    });
  });
}

