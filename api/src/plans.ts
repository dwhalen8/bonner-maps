import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  PLAN_DOC_VERSION,
  ParcelSnapshotSchema,
  PlanDocSchema,
  PolygonOrMultiSchema,
  toParcelSnapshot,
  type PlanDoc,
} from "../../shared/plan";
import { userFromRequest } from "./auth";
import { metrics, type Db } from "./db";

const GEOM_MAX_BYTES = 1_000_000;

const ClaimBody = z.object({
  pin: z.string().optional(),
  parcel: z.object({
    props: ParcelSnapshotSchema,
    geom: PolygonOrMultiSchema,
  }),
  doc: PlanDocSchema.optional(),
});

const PutBody = z.object({
  doc: PlanDocSchema,
  baseServerRev: z.number().int().optional(),
  force: z.boolean().optional(),
});

type PlanRow = {
  id: string;
  user_id: string;
  pin: string;
  title: string;
  doc: string;
  server_rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function fail(
  c: Context,
  status: 400 | 401 | 404 | 409 | 413,
  error: string,
  code: string,
) {
  return c.json({ error, code }, status);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function pinError(pin: string): string | null {
  if (!pin || pin.length === 0) return "PIN required";
  if (pin.length > 32) return "PIN too long";
  if (pin === "ROW") return "ROW is not a claimable parcel";
  return null;
}

function geomTooLarge(geom: unknown): boolean {
  try {
    return JSON.stringify(geom).length > GEOM_MAX_BYTES;
  } catch {
    return true;
  }
}

function parseRowDoc(raw: string): PlanDoc {
  return JSON.parse(raw) as PlanDoc;
}

function payload(row: PlanRow) {
  return { id: row.id, serverRev: row.server_rev, doc: parseRowDoc(row.doc) };
}

function getLive(db: Db, userId: string, id: string): PlanRow | undefined {
  return db
    .prepare(
      `SELECT id, user_id, pin, title, doc, server_rev, created_at, updated_at, deleted_at
       FROM plans WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as PlanRow | undefined;
}

function defaultDoc(
  pin: string,
  props: PlanDoc["parcel"]["props"],
  geom: PlanDoc["parcel"]["geom"],
): PlanDoc {
  const now = new Date().toISOString();
  return {
    version: PLAN_DOC_VERSION,
    pin,
    title: props.addr || props.o1 || pin,
    use: "Single-family dwelling",
    notes: "",
    lineFt: 25,
    accessory: false,
    parcel: {
      props: toParcelSnapshot(props),
      geom,
      snapshotAt: now,
    },
    features: [],
    constraints: null,
    checklist: [],
    clientEditedAt: now,
  };
}

function logPut(
  result: "ok" | "conflict" | "forced",
  planId: string,
  pin: string,
  bytes: number,
  serverRev: number,
) {
  console.log(
    JSON.stringify({ msg: "plan.put", planId, pin, bytes, serverRev, result }),
  );
}

export function mountPlans(api: Hono, db: Db): void {
  api.get("/plans", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const rows = db
      .prepare(
        `SELECT id, pin, title, updated_at, server_rev
         FROM plans
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
      )
      .all(user.id) as {
      id: string;
      pin: string;
      title: string;
      updated_at: string;
      server_rev: number;
    }[];
    return c.json(
      rows.map((row) => ({
        id: row.id,
        pin: row.pin,
        title: row.title,
        updatedAt: row.updated_at,
        serverRev: row.server_rev,
      })),
    );
  });

  api.post("/plans", async (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const parsed = ClaimBody.safeParse(await readJson(c));
    if (!parsed.success) {
      return fail(c, 400, "Invalid request", "bad_request");
    }
    const pin = parsed.data.parcel.props.pin;
    if (parsed.data.pin != null && parsed.data.pin !== pin) {
      return fail(c, 400, "PIN does not match parcel", "bad_request");
    }
    const badPin = pinError(pin);
    if (badPin) return fail(c, 400, badPin, "bad_request");
    if (geomTooLarge(parsed.data.parcel.geom)) {
      return fail(c, 413, "Geometry too large", "payload_too_large");
    }

    const snapshot = toParcelSnapshot(parsed.data.parcel.props);
    let doc: PlanDoc;
    if (parsed.data.doc) {
      doc = {
        ...parsed.data.doc,
        pin,
        parcel: {
          props: snapshot,
          geom: parsed.data.parcel.geom,
          snapshotAt: parsed.data.doc.parcel.snapshotAt || new Date().toISOString(),
        },
        constraints: parsed.data.doc.constraints ?? null,
      };
    } else {
      doc = defaultDoc(pin, snapshot, parsed.data.parcel.geom);
    }

    const now = new Date().toISOString();
    const title = doc.title || snapshot.addr || snapshot.o1 || pin;
    const docJson = JSON.stringify(doc);

    try {
      const result = db.transaction(() => {
        const existing = db
          .prepare(
            `SELECT id, user_id, pin, title, doc, server_rev, created_at, updated_at, deleted_at
             FROM plans WHERE user_id = ? AND pin = ?`,
          )
          .get(user.id, pin) as PlanRow | undefined;
        if (existing && !existing.deleted_at) {
          return { kind: "exists" as const, row: existing };
        }
        if (existing) {
          const nextRev = existing.server_rev + 1;
          db.prepare(
            `UPDATE plans
             SET title = ?, doc = ?, server_rev = ?, updated_at = ?, deleted_at = NULL
             WHERE id = ?`,
          ).run(title, docJson, nextRev, now, existing.id);
          return {
            kind: "ok" as const,
            row: getLive(db, user.id, existing.id)!,
          };
        }
        const id = randomUUID();
        db.prepare(
          `INSERT INTO plans
             (id, user_id, pin, title, doc, server_rev, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        ).run(id, user.id, pin, title, docJson, now, now);
        return { kind: "ok" as const, row: getLive(db, user.id, id)! };
      })();

      if (result.kind === "exists") {
        return fail(c, 409, "PIN already claimed", "already_claimed");
      }
      return c.json(payload(result.row));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code.startsWith("SQLITE_CONSTRAINT")) {
        return fail(c, 409, "PIN already claimed", "already_claimed");
      }
      throw err;
    }
  });

  api.get("/plans/:id", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const row = getLive(db, user.id, c.req.param("id"));
    if (!row || row.deleted_at) return fail(c, 404, "Plan not found", "not_found");
    return c.json(payload(row));
  });

  api.put("/plans/:id", async (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const parsed = PutBody.safeParse(await readJson(c));
    if (!parsed.success) {
      return fail(c, 400, "Invalid request", "bad_request");
    }
    const force = parsed.data.force === true;
    if (!force && parsed.data.baseServerRev == null) {
      return fail(c, 400, "baseServerRev required", "bad_request");
    }
    if (geomTooLarge(parsed.data.doc.parcel.geom)) {
      return fail(c, 413, "Geometry too large", "payload_too_large");
    }

    const id = c.req.param("id");
    const now = new Date().toISOString();

    const result = db.transaction(() => {
      const row = getLive(db, user.id, id);
      if (!row || row.deleted_at) return { kind: "missing" as const };
      const bytes = JSON.stringify(parsed.data.doc).length;
      if (!force && parsed.data.baseServerRev !== row.server_rev) {
        return { kind: "conflict" as const, row, bytes };
      }
      const doc: PlanDoc = {
        ...parsed.data.doc,
        pin: row.pin,
        constraints: parsed.data.doc.constraints ?? null,
      };
      const docJson = JSON.stringify(doc);
      const nextRev = row.server_rev + 1;
      const title = doc.title || row.title;
      db.prepare(
        `UPDATE plans SET title = ?, doc = ?, server_rev = ?, updated_at = ? WHERE id = ?`,
      ).run(title, docJson, nextRev, now, id);
      metrics.puts_total += 1;
      return {
        kind: "ok" as const,
        row: getLive(db, user.id, id)!,
        bytes: docJson.length,
        forced: force,
      };
    })();

    if (result.kind === "missing") {
      return fail(c, 404, "Plan not found", "not_found");
    }
    if (result.kind === "conflict") {
      logPut("conflict", result.row.id, result.row.pin, result.bytes, result.row.server_rev);
      return c.json(payload(result.row), 409);
    }
    logPut(
      result.forced ? "forced" : "ok",
      result.row.id,
      result.row.pin,
      result.bytes,
      result.row.server_rev,
    );
    return c.json(payload(result.row));
  });

  api.delete("/plans/:id", (c) => {
    const user = userFromRequest(db, c);
    if (!user) return fail(c, 401, "Not signed in", "unauthorized");
    const id = c.req.param("id");
    const now = new Date().toISOString();
    const row = getLive(db, user.id, id);
    if (!row || row.deleted_at) return fail(c, 404, "Plan not found", "not_found");
    db.prepare(
      `UPDATE plans SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(now, now, id, user.id);
    return c.body(null, 204);
  });
}
