import type { PlanDoc } from "@shared/plan";

const DB_NAME = "bonner-plans";
const DB_VERSION = 1;
const PUT_DEBOUNCE_MS = 1500;

export type StoredPlan = {
  id: string;
  pin: string;
  serverRev: number;
  doc: PlanDoc;
};

export type PlanListItem = {
  id: string;
  pin: string;
  title: string;
  updatedAt: string;
  serverRev: number;
};

export type RevConflict = {
  id: string;
  serverRev: number;
  doc: PlanDoc;
};

type OutboxRow = { planId: string; baseServerRev: number };

export type ConflictChoice = "keep" | "take";

export type PlanStoreHooks = {
  onStatus?: (msg: string) => void;
  onConflict?: (conflict: RevConflict) => Promise<ConflictChoice>;
  onReplace?: (plan: StoredPlan) => void;
  onAck?: (id: string, serverRev: number) => void;
  onUnauthorized?: () => void;
};

let hooks: PlanStoreHooks = {};

export function setPlanStoreHooks(next: PlanStoreHooks) {
  hooks = next;
}

type ApiErrorBody = { error?: string; code?: string };

function errorMessage(body: ApiErrorBody | undefined, fallback: string) {
  return body && typeof body.error === "string" ? body.error : fallback;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    credentials: "include",
    keepalive: init?.method === "PUT" || init?.method === "POST",
    ...init,
  });
  let body = null as T;
  if (res.status !== 204) {
    try {
      body = (await res.json()) as T;
    } catch {
      body = null as T;
    }
  }
  if (res.status === 401) hooks.onUnauthorized?.();
  return { status: res.status, body };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openPlansDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("plans")) {
        const plans = db.createObjectStore("plans", { keyPath: "id" });
        plans.createIndex("pin", "pin", { unique: false });
      }
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "planId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  name: "plans" | "outbox",
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openPlansDb();
  const tx = db.transaction(name, mode);
  return idbReq(run(tx.objectStore(name)));
}

async function getStored(id: string): Promise<StoredPlan | null> {
  try {
    return (await withStore("plans", "readonly", (s) => s.get(id))) ?? null;
  } catch {
    return null;
  }
}

async function putStored(plan: StoredPlan): Promise<void> {
  try {
    await withStore("plans", "readwrite", (s) => s.put(plan));
  } catch {
    /* private mode / quota */
  }
}

async function getOutbox(id: string): Promise<OutboxRow | null> {
  try {
    return (await withStore("outbox", "readonly", (s) => s.get(id))) ?? null;
  } catch {
    return null;
  }
}

async function putOutbox(row: OutboxRow): Promise<void> {
  try {
    await withStore("outbox", "readwrite", (s) => s.put(row));
  } catch {
    /* private mode / quota */
  }
}

async function deleteOutbox(id: string): Promise<void> {
  try {
    await withStore("outbox", "readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

async function allOutbox(): Promise<OutboxRow[]> {
  try {
    return (await withStore("outbox", "readonly", (s) => s.getAll())) ?? [];
  } catch {
    return [];
  }
}

export async function planByPin(pin: string): Promise<StoredPlan | null> {
  if (!pin) return null;
  try {
    const db = await openPlansDb();
    const tx = db.transaction("plans", "readonly");
    const row = await idbReq<StoredPlan | undefined>(tx.objectStore("plans").index("pin").get(pin));
    return row ?? null;
  } catch {
    return null;
  }
}

export async function rememberPlan(plan: StoredPlan): Promise<void> {
  await putStored(plan);
  await deleteOutbox(plan.id);
}

const pushTimers = new Map<string, number>();

export async function saveClaimedLocal(id: string, doc: PlanDoc): Promise<void> {
  const existing = await getStored(id);
  const pending = await getOutbox(id);
  const serverRev = existing?.serverRev ?? 0;
  const baseServerRev = pending?.baseServerRev ?? serverRev;
  await putStored({ id, pin: doc.pin, serverRev, doc });
  await putOutbox({ planId: id, baseServerRev });
  schedulePush(id);
}

function schedulePush(id: string) {
  window.clearTimeout(pushTimers.get(id) ?? 0);
  const t = window.setTimeout(() => {
    pushTimers.delete(id);
    void pushPlan(id);
  }, PUT_DEBOUNCE_MS);
  pushTimers.set(id, t);
}

export function flushClaimedSync() {
  for (const [id, timer] of pushTimers) {
    window.clearTimeout(timer);
    pushTimers.delete(id);
    void pushPlan(id);
  }
  void flushOutbox();
}

async function resolveConflict(server: RevConflict): Promise<void> {
  hooks.onStatus?.("Newer copy on server — Keep mine / Take server");
  const choice = hooks.onConflict ? await hooks.onConflict(server) : "take";
  if (choice === "take") {
    const plan: StoredPlan = {
      id: server.id,
      pin: server.doc.pin,
      serverRev: server.serverRev,
      doc: server.doc,
    };
    await putStored(plan);
    await deleteOutbox(server.id);
    hooks.onReplace?.(plan);
    hooks.onStatus?.("Loaded server copy");
    return;
  }
  await pushPlan(server.id, true);
}

async function pushPlan(id: string, force = false): Promise<void> {
  const stored = await getStored(id);
  const outbox = await getOutbox(id);
  if (!stored) return;
  if (!force && !outbox) return;
  const baseServerRev = outbox?.baseServerRev ?? stored.serverRev;
  const sentAt = stored.doc.clientEditedAt;
  try {
    const { status, body } = await apiJson<RevConflict & ApiErrorBody>(`/api/plans/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        doc: stored.doc,
        baseServerRev,
        ...(force ? { force: true } : {}),
      }),
    });
    if (status === 200 && body && body.doc) {
      const latest = await getStored(id);
      const nextRev = body.serverRev;
      const localDoc = latest?.doc ?? stored.doc;
      await putStored({
        id: body.id,
        pin: localDoc.pin,
        serverRev: nextRev,
        doc: localDoc,
      });
      const stillDirty = latest && latest.doc.clientEditedAt && latest.doc.clientEditedAt !== sentAt;
      if (stillDirty) {
        await putOutbox({ planId: id, baseServerRev: nextRev });
        schedulePush(id);
      } else {
        await deleteOutbox(id);
      }
      hooks.onAck?.(body.id, nextRev);
      hooks.onStatus?.("Saved just now");
      return;
    }
    if (status === 409 && body && body.doc) {
      await resolveConflict({ id: body.id, serverRev: body.serverRev, doc: body.doc });
      return;
    }
    if (status === 401) {
      hooks.onStatus?.("Sign in again to sync");
      return;
    }
    hooks.onStatus?.("Offline — will sync");
  } catch {
    hooks.onStatus?.("Offline — will sync");
  }
}

async function fetchPlan(id: string): Promise<StoredPlan | null> {
  try {
    const { status, body } = await apiJson<RevConflict & ApiErrorBody>(`/api/plans/${id}`);
    if (status !== 200 || !body?.doc) return null;
    return { id: body.id, pin: body.doc.pin, serverRev: body.serverRev, doc: body.doc };
  } catch {
    return null;
  }
}

async function flushOutbox(): Promise<void> {
  const rows = await allOutbox();
  for (const row of rows) {
    await pushPlan(row.planId);
  }
}

export async function claimPlan(input: {
  pin: string;
  parcel: { props: PlanDoc["parcel"]["props"]; geom: PlanDoc["parcel"]["geom"] };
  doc?: PlanDoc;
}): Promise<StoredPlan> {
  const { status, body } = await apiJson<RevConflict & ApiErrorBody>("/api/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if ((status === 200 || status === 201) && body?.doc) {
    const plan: StoredPlan = {
      id: body.id,
      pin: body.doc.pin,
      serverRev: body.serverRev,
      doc: body.doc,
    };
    await rememberPlan(plan);
    return plan;
  }
  if (status === 409) {
    const listed = await listPlans();
    const hit = listed.find((row) => row.pin === input.pin);
    if (hit) {
      const full = await fetchPlan(hit.id);
      if (full) {
        await rememberPlan(full);
        return full;
      }
    }
  }
  throw Object.assign(new Error(errorMessage(body, "Could not claim parcel")), {
    status,
    code: body?.code,
  });
}

export async function listPlans(): Promise<PlanListItem[]> {
  try {
    const { status, body } = await apiJson<PlanListItem[] | ApiErrorBody>("/api/plans");
    if (status !== 200 || !Array.isArray(body)) return [];
    return body;
  } catch {
    return [];
  }
}

export async function pullPlans(): Promise<void> {
  let list: PlanListItem[] = [];
  try {
    const { status, body } = await apiJson<PlanListItem[] | ApiErrorBody>("/api/plans");
    if (status === 401) return;
    if (status !== 200 || !Array.isArray(body)) return;
    list = body;
  } catch {
    return;
  }
  for (const item of list) {
    const local = await getStored(item.id);
    const dirty = await getOutbox(item.id);
    if (!local) {
      const full = await fetchPlan(item.id);
      if (full) {
        await putStored(full);
        hooks.onReplace?.(full);
      }
      continue;
    }
    if (local.serverRev < item.serverRev) {
      const full = await fetchPlan(item.id);
      if (!full) continue;
      if (dirty) {
        await resolveConflict({ id: full.id, serverRev: full.serverRev, doc: full.doc });
      } else {
        await putStored(full);
        hooks.onReplace?.(full);
      }
    }
  }
  await flushOutbox();
}
