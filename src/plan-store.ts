import type { PlanDoc } from "@shared/plan";

const DB_NAME = "bonner-plans";
const DB_VERSION = 1;
const PUT_DEBOUNCE_MS = 1500;
const KEEP_ALIVE_MAX = 64 * 1024;

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

type PushOpts = {
  keepalive?: boolean;
  doc?: PlanDoc;
};

export type PlanStoreHooks = {
  onStatus?: (msg: string) => void;
  onConflict?: (conflict: RevConflict) => Promise<ConflictChoice>;
  onReplace?: (plan: StoredPlan) => void;
  onAck?: (id: string, serverRev: number) => void;
  onBound?: (plan: StoredPlan) => void;
  onDropped?: (id: string) => void;
  onUnauthorized?: () => void;
  peekAnonDraft?: (pin: string) => PlanDoc | null;
};

let hooks: PlanStoreHooks = {};

export function setPlanStoreHooks(next: PlanStoreHooks) {
  hooks = next;
}

type ApiErrorBody = { error?: string; code?: string };

function errorMessage(body: ApiErrorBody | undefined, fallback: string) {
  return body && typeof body.error === "string" ? body.error : fallback;
}

export function draftHasWork(doc: PlanDoc | null | undefined): boolean {
  if (!doc) return false;
  if (doc.features.length > 0) return true;
  if (typeof doc.notes === "string" && doc.notes.trim()) return true;
  if (doc.accessory) return true;
  if (doc.use && doc.use !== "Single-family dwelling") return true;
  return false;
}

async function apiJson<T>(
  path: string,
  init?: RequestInit,
  extra?: { keepalive?: boolean },
): Promise<{ status: number; body: T }> {
  const headers = { ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
    keepalive: extra?.keepalive === true,
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

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("idb abort"));
    tx.onerror = () => reject(tx.error);
  });
}

/** Read+write plans/outbox in one transaction so a concurrent PUT 200 cannot stash a stale serverRev. */
async function writeLocalDoc(id: string, doc: PlanDoc): Promise<void> {
  try {
    const db = await openPlansDb();
    const tx = db.transaction(["plans", "outbox"], "readwrite");
    const plans = tx.objectStore("plans");
    const outboxStore = tx.objectStore("outbox");
    const existing = ((await idbReq(plans.get(id))) as StoredPlan | undefined) ?? null;
    const pending = ((await idbReq(outboxStore.get(id))) as OutboxRow | undefined) ?? null;
    const serverRev = existing?.serverRev ?? 0;
    const baseServerRev = pending?.baseServerRev ?? serverRev;
    plans.put({ id, pin: doc.pin, serverRev, doc });
    outboxStore.put({ planId: id, baseServerRev });
    await txDone(tx);
  } catch {
    /* private mode / quota */
  }
}

async function ackPushSuccess(
  id: string,
  nextRev: number,
  sentAt: string | undefined,
  fallbackDoc: PlanDoc,
): Promise<boolean> {
  try {
    const db = await openPlansDb();
    const tx = db.transaction(["plans", "outbox"], "readwrite");
    const plans = tx.objectStore("plans");
    const outboxStore = tx.objectStore("outbox");
    const latest = ((await idbReq(plans.get(id))) as StoredPlan | undefined) ?? null;
    const localDoc = latest?.doc ?? fallbackDoc;
    plans.put({ id, pin: localDoc.pin, serverRev: nextRev, doc: localDoc });
    const stillDirty = Boolean(latest?.doc.clientEditedAt && latest.doc.clientEditedAt !== sentAt);
    if (stillDirty) outboxStore.put({ planId: id, baseServerRev: nextRev });
    else outboxStore.delete(id);
    await txDone(tx);
    return stillDirty;
  } catch {
    return false;
  }
}

async function putStored(plan: StoredPlan): Promise<void> {
  try {
    await withStore("plans", "readwrite", (s) => s.put(plan));
  } catch {
    /* private mode / quota */
  }
}

async function deleteStored(id: string): Promise<void> {
  try {
    await withStore("plans", "readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
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
const pushChain = new Map<string, Promise<void>>();
/** clientEditedAt of a 413 payload; skip retry until the doc changes. */
const blockedTooLarge = new Map<string, string | undefined>();

export async function saveClaimedLocal(
  id: string,
  doc: PlanDoc,
  opts?: { schedule?: boolean },
): Promise<void> {
  await writeLocalDoc(id, doc);
  if (opts?.schedule === false) return;
  schedulePush(id);
}

function schedulePush(id: string) {
  window.clearTimeout(pushTimers.get(id) ?? 0);
  const t = window.setTimeout(() => {
    pushTimers.delete(id);
    void enqueuePush(id);
  }, PUT_DEBOUNCE_MS);
  pushTimers.set(id, t);
}

function enqueuePush(id: string, force = false, opts?: PushOpts): Promise<void> {
  const prev = pushChain.get(id) ?? Promise.resolve();
  const next = prev.then(
    () => pushPlanNow(id, force, opts),
    () => pushPlanNow(id, force, opts),
  );
  pushChain.set(id, next);
  return next;
}

export function flushClaimedSync(opts?: {
  keepalive?: boolean;
  snapshot?: { id: string; doc: PlanDoc };
}): Promise<void> {
  for (const timer of pushTimers.values()) window.clearTimeout(timer);
  pushTimers.clear();
  if (opts?.snapshot) {
    const { id, doc } = opts.snapshot;
    return enqueuePush(id, false, { keepalive: opts.keepalive, doc });
  }
  return flushOutbox({ keepalive: opts?.keepalive });
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
    blockedTooLarge.delete(server.id);
    hooks.onReplace?.(plan);
    hooks.onStatus?.("Loaded server copy");
    return;
  }
  await pushPlanNow(server.id, true);
}

async function pushPlanNow(id: string, force = false, opts?: PushOpts): Promise<void> {
  if (opts?.doc) await writeLocalDoc(id, opts.doc);
  const stored = await getStored(id);
  const outbox = await getOutbox(id);
  const doc = opts?.doc ?? stored?.doc;
  if (!doc) return;
  if (!force && !outbox && !opts?.doc) return;
  const serverRev = stored?.serverRev ?? 0;
  const baseServerRev = outbox?.baseServerRev ?? serverRev;
  const sentAt = doc.clientEditedAt;
  if (!force && blockedTooLarge.has(id) && blockedTooLarge.get(id) === sentAt) {
    return;
  }

  const payload = JSON.stringify({
    doc,
    baseServerRev,
    ...(force ? { force: true } : {}),
  });
  const keepalive = opts?.keepalive === true && payload.length < KEEP_ALIVE_MAX;

  try {
    const { status, body } = await apiJson<RevConflict & ApiErrorBody>(
      `/api/plans/${id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: payload,
      },
      { keepalive },
    );
    if (status === 200 && body && body.doc) {
      blockedTooLarge.delete(id);
      const nextRev = body.serverRev;
      const stillDirty = await ackPushSuccess(id, nextRev, sentAt, doc);
      if (stillDirty) schedulePush(id);
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
    if (status === 404) {
      await deleteOutbox(id);
      await deleteStored(id);
      blockedTooLarge.delete(id);
      hooks.onDropped?.(id);
      hooks.onStatus?.("Plan was deleted on the server");
      return;
    }
    if (status === 413) {
      blockedTooLarge.set(id, sentAt);
      hooks.onStatus?.("Plan too large to sync");
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

async function flushOutbox(opts?: { keepalive?: boolean }): Promise<void> {
  const rows = await allOutbox();
  for (const row of rows) {
    await enqueuePush(row.planId, false, { keepalive: opts?.keepalive });
  }
}

async function attachLocalDraft(full: StoredPlan, localDoc: PlanDoc): Promise<StoredPlan> {
  const attached: StoredPlan = {
    id: full.id,
    pin: full.pin,
    serverRev: full.serverRev,
    doc: localDoc,
  };
  await putStored({
    id: full.id,
    pin: full.pin,
    serverRev: full.serverRev,
    doc: full.doc,
  });
  await saveClaimedLocal(full.id, localDoc);
  hooks.onBound?.(attached);
  return attached;
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
        if (input.doc && draftHasWork(input.doc)) {
          return attachLocalDraft(full, input.doc);
        }
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
    let local = await getStored(item.id);
    let dirty = await getOutbox(item.id);
    const anon = hooks.peekAnonDraft?.(item.pin);
    if (!local) {
      const full = await fetchPlan(item.id);
      if (!full) continue;
      if (anon && draftHasWork(anon)) {
        await attachLocalDraft(full, anon);
        continue;
      }
      await putStored(full);
      hooks.onReplace?.(full);
      continue;
    }
    if (anon && draftHasWork(anon) && !dirty) {
      await saveClaimedLocal(local.id, anon);
      hooks.onBound?.({ id: local.id, pin: local.pin, serverRev: local.serverRev, doc: anon });
      dirty = await getOutbox(local.id);
      local = (await getStored(local.id)) ?? { ...local, doc: anon };
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
