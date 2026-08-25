export type Me = { id: string; email: string; createdAt: string };

type ApiError = { error: string; code: string };

async function readApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiError;
    if (body && typeof body.error === "string") {
      return { error: body.error, code: typeof body.code === "string" ? body.code : "http_error" };
    }
  } catch {
    /* ignore */
  }
  return { error: res.statusText || "Request failed", code: "http_error" };
}

async function postAuth(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 204 || res.ok) return;
  const err = await readApiError(res);
  throw Object.assign(new Error(err.error), { code: err.code, status: res.status });
}

export async function requestOtp(email: string, includeLink?: boolean): Promise<void> {
  const body: { email: string; includeLink?: boolean } = { email };
  if (includeLink) body.includeLink = true;
  await postAuth("/api/auth/otp", body);
}

export async function verifyOtp(email: string, code: string): Promise<void> {
  await postAuth("/api/auth/otp/verify", { email, code });
}

export async function me(): Promise<Me | null> {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* API down — chrome still signs out locally */
  }
}
