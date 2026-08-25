import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { metrics, type Db } from "./db";

const COOKIE = "bonner_sid";
const COOKIE_MAX_AGE = 2592000;
const OTP_TTL_MS = 15 * 60 * 1000;
const VERIFY_EMAIL_WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OTP_EMAIL_LIMIT = 5;
const OTP_IP_LIMIT = 20;
const VERIFY_EMAIL_LIMIT = 5;
const VERIFY_IP_LIMIT = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZERO_HASH = Buffer.alloc(32);

const OtpRequestBody = z.object({
  email: z.string(),
  includeLink: z.boolean().optional(),
});

const OtpVerifyBody = z.object({
  email: z.string(),
  code: z.string(),
});

type SmtpEnv = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

export function appOrigin(): string {
  return (process.env.APP_ORIGIN ?? "http://localhost").replace(/\/$/, "");
}

function smtpFromEnv(): SmtpEnv | null {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(process.env.SMTP_PORT ?? 587) || 587;
  return {
    host,
    port,
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from,
  };
}

export function assertMailerForProduction(): void {
  if (process.env.NODE_ENV === "production" && !smtpFromEnv()) {
    throw new Error(
      "SMTP_HOST and SMTP_FROM are required when NODE_ENV=production",
    );
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sha256hex(value: string): string {
  return sha256(value).toString("hex");
}

function hashEquals(storedHex: string | null | undefined, presented: string): boolean {
  const presentedHash = sha256(presented);
  let stored = ZERO_HASH;
  let wellFormed = false;
  if (storedHex && storedHex.length === 64) {
    const buf = Buffer.from(storedHex, "hex");
    if (buf.length === 32) {
      stored = buf;
      wellFormed = true;
    }
  }
  const match = timingSafeEqual(stored, presentedHash);
  return wellFormed && match;
}

function cookieSecure(): boolean {
  return appOrigin().startsWith("https:");
}

function cookieHeader(raw: string, maxAge: number): string {
  const parts = [
    `${COOKIE}=${raw}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(c: Context, raw: string): void {
  c.header("Set-Cookie", cookieHeader(raw, COOKIE_MAX_AGE));
}

function clearSessionCookie(c: Context): void {
  c.header("Set-Cookie", cookieHeader("", 0));
}

function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  return "0.0.0.0";
}

function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function fail(c: Context, status: 400 | 401 | 429, error: string, code: string) {
  return c.json({ error, code }, status);
}

function countEvents(db: Db, kind: string, key: string, sinceIso: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM auth_events WHERE kind = ? AND key = ? AND at > ?",
    )
    .get(kind, key, sinceIso) as { n: number };
  return row.n;
}

function recordEvent(db: Db, kind: string, key: string): void {
  db.prepare("INSERT INTO auth_events (kind, key, at) VALUES (?, ?, ?)").run(
    kind,
    key,
    new Date().toISOString(),
  );
}

function consumeEmailOtps(db: Db, email: string): void {
  db.prepare(
    "UPDATE otp_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
  ).run(new Date().toISOString(), email);
}

function consumeOtpId(db: Db, id: string): void {
  db.prepare("UPDATE otp_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(
    new Date().toISOString(),
    id,
  );
}

type OtpRow = {
  id: string;
  email: string;
  code_hash: string;
  link_token_hash: string | null;
  expires_at: string;
  consumed_at: string | null;
};

function activeOtpForEmail(db: Db, email: string): OtpRow | undefined {
  return db
    .prepare(
      `SELECT id, email, code_hash, link_token_hash, expires_at, consumed_at
       FROM otp_codes
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY expires_at DESC
       LIMIT 1`,
    )
    .get(email, new Date().toISOString()) as OtpRow | undefined;
}

function upsertUser(db: Db, email: string): string {
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO users (id, email, created_at, last_login_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET last_login_at = excluded.last_login_at
       RETURNING id`,
    )
    .get(randomUUID(), email, now, now) as { id: string };
  return row.id;
}

function newSession(db: Db, userId: string, userAgent: string | undefined): string {
  const raw = randomBytes(32).toString("base64url");
  const now = new Date();
  const exp = new Date(now.getTime() + COOKIE_MAX_AGE * 1000);
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    sha256hex(raw),
    userId,
    now.toISOString(),
    exp.toISOString(),
    userAgent ?? null,
  );
  metrics.logins_total += 1;
  return raw;
}

function establishSession(
  db: Db,
  email: string,
  userAgent: string | undefined,
): string {
  const userId = upsertUser(db, email);
  return newSession(db, userId, userAgent);
}

function mailbox(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  return angle ? angle[1]! : from;
}

type SmtpIo = {
  socket: Socket;
  readReply: () => Promise<{ code: number; text: string }>;
  write: (line: string) => void;
  unbind: () => void;
};

function smtpIo(socket: Socket): SmtpIo {
  let buf = Buffer.alloc(0);
  const lines: string[] = [];
  let wake: (() => void) | null = null;
  let fail: ((err: Error) => void) | null = null;

  const onData = (data: Buffer) => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      const i = buf.indexOf(0x0a);
      if (i < 0) break;
      lines.push(buf.subarray(0, i).toString("utf8").replace(/\r$/, ""));
      buf = buf.subarray(i + 1);
      wake?.();
    }
  };
  const onErr = (err: Error) => fail?.(err);
  const onEnd = () => fail?.(new Error("smtp closed"));
  socket.on("data", onData);
  socket.on("error", onErr);
  socket.on("end", onEnd);

  return {
    socket,
    unbind() {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("end", onEnd);
    },
    write(line: string) {
      socket.write(line + "\r\n");
    },
    async readReply() {
      const collected: string[] = [];
      for (;;) {
        if (!lines.length) {
          await new Promise<void>((resolve, reject) => {
            wake = resolve;
            fail = reject;
          });
          wake = null;
          fail = null;
        }
        const line = lines.shift();
        if (line == null) continue;
        collected.push(line);
        if (line[3] === " ") {
          return { code: Number(line.slice(0, 3)), text: collected.join("\n") };
        }
      }
    },
  };
}

function connectSmtp(host: string, port: number, implicitTls: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    if (implicitTls) {
      const s = tlsConnect(port, host, { servername: host }, () => {
        s.off("error", onErr);
        resolve(s);
      });
      s.once("error", onErr);
      return;
    }
    const s = netConnect(port, host, () => {
      s.off("error", onErr);
      resolve(s);
    });
    s.once("error", onErr);
  });
}

async function smtpSend(
  smtp: SmtpEnv,
  msg: { to: string; subject: string; text: string },
): Promise<void> {
  const implicitTls = smtp.port === 465;
  let io = smtpIo(await connectSmtp(smtp.host, smtp.port, implicitTls));

  const expect = async (ok: number[], step: string) => {
    const reply = await io.readReply();
    if (!ok.includes(reply.code)) {
      throw new Error(`smtp ${step}: ${reply.text}`);
    }
    return reply;
  };

  try {
    await expect([220], "banner");
    io.write("EHLO bonner-bounds");
    await expect([250], "ehlo");

    if (!implicitTls) {
      io.write("STARTTLS");
      await expect([220], "starttls");
      io.unbind();
      const upgraded = await new Promise<Socket>((resolve, reject) => {
        const s = tlsConnect(
          { socket: io.socket, servername: smtp.host },
          () => resolve(s),
        );
        s.once("error", reject);
      });
      io = smtpIo(upgraded);
      io.write("EHLO bonner-bounds");
      await expect([250], "ehlo-tls");
    }

    if (smtp.user) {
      io.write("AUTH LOGIN");
      await expect([334], "auth");
      io.write(Buffer.from(smtp.user).toString("base64"));
      await expect([334], "auth-user");
      io.write(Buffer.from(smtp.pass).toString("base64"));
      await expect([235], "auth-pass");
    }

    io.write(`MAIL FROM:<${mailbox(smtp.from)}>`);
    await expect([250], "mail");
    io.write(`RCPT TO:<${msg.to}>`);
    await expect([250, 251], "rcpt");
    io.write("DATA");
    await expect([354], "data");
    const stuffed = msg.text.replace(/^\./gm, "..");
    const payload = [
      `From: ${smtp.from}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      stuffed,
      ".",
    ].join("\r\n");
    io.socket.write(payload + "\r\n");
    await expect([250], "body");
    io.write("QUIT");
    await io.readReply().catch(() => undefined);
  } finally {
    io.socket.destroy();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function sendOtpEmail(to: string, code: string, link: string | null): Promise<void> {
  const smtp = smtpFromEnv();
  const text = link ? `${code}\n\n${link}` : code;
  if (!smtp) {
    console.log(JSON.stringify({ msg: "otp", email: to, code, ...(link ? { link } : {}) }));
    return;
  }
  await withTimeout(
    smtpSend(smtp, {
      to,
      subject: "Your Bonner Bounds sign-in code",
      text,
    }),
    15_000,
    "smtp timeout",
  );
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

type VerifyOutcome =
  | { kind: "ok"; raw: string }
  | { kind: "invalid" }
  | { kind: "rate" };

function verifyByCode(db: Db, email: string, code: string, ip: string, userAgent: string | undefined): VerifyOutcome {
  const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();
  const windowAgo = new Date(Date.now() - VERIFY_EMAIL_WINDOW_MS).toISOString();
  const emailKey = `email:${email}`;
  const ipKey = `ip:${ip}`;

  if (countEvents(db, "otp_verify", ipKey, hourAgo) >= VERIFY_IP_LIMIT) {
    return { kind: "rate" };
  }
  if (countEvents(db, "otp_verify", emailKey, windowAgo) >= VERIFY_EMAIL_LIMIT) {
    consumeEmailOtps(db, email);
    return { kind: "rate" };
  }

  const row = activeOtpForEmail(db, email);
  const match = hashEquals(row?.code_hash, code) && /^\d{6}$/.test(code);
  if (!row || !match) {
    recordEvent(db, "otp_verify", emailKey);
    recordEvent(db, "otp_verify", ipKey);
    metrics.login_fail_total += 1;
    const fails = countEvents(db, "otp_verify", emailKey, windowAgo);
    if (fails >= VERIFY_EMAIL_LIMIT) consumeEmailOtps(db, email);
    return { kind: "invalid" };
  }

  consumeOtpId(db, row.id);
  const raw = establishSession(db, email, userAgent);
  return { kind: "ok", raw };
}

function verifyByLinkToken(
  db: Db,
  token: string,
  ip: string,
  userAgent: string | undefined,
): VerifyOutcome {
  const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();
  const windowAgo = new Date(Date.now() - VERIFY_EMAIL_WINDOW_MS).toISOString();
  const ipKey = `ip:${ip}`;
  const tokenHash = sha256hex(token);

  if (countEvents(db, "otp_verify", ipKey, hourAgo) >= VERIFY_IP_LIMIT) {
    return { kind: "rate" };
  }

  const row = db
    .prepare(
      `SELECT id, email, code_hash, link_token_hash, expires_at, consumed_at
       FROM otp_codes
       WHERE link_token_hash = ? AND consumed_at IS NULL AND expires_at > ?
       LIMIT 1`,
    )
    .get(tokenHash, new Date().toISOString()) as OtpRow | undefined;

  const email = row?.email;
  const emailKey = email ? `email:${email}` : null;
  if (emailKey && countEvents(db, "otp_verify", emailKey, windowAgo) >= VERIFY_EMAIL_LIMIT) {
    consumeEmailOtps(db, email!);
    return { kind: "rate" };
  }

  const match = hashEquals(row?.link_token_hash, token);
  if (!row || !match) {
    if (emailKey) recordEvent(db, "otp_verify", emailKey);
    recordEvent(db, "otp_verify", ipKey);
    metrics.login_fail_total += 1;
    if (emailKey && email) {
      const fails = countEvents(db, "otp_verify", emailKey, windowAgo);
      if (fails >= VERIFY_EMAIL_LIMIT) consumeEmailOtps(db, email);
    }
    return { kind: "invalid" };
  }

  consumeOtpId(db, row.id);
  const raw = establishSession(db, row.email, userAgent);
  return { kind: "ok", raw };
}

function sessionUser(db: Db, raw: string | undefined) {
  if (!raw) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.created_at AS createdAt
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sha256hex(raw), new Date().toISOString()) as
    | { id: string; email: string; createdAt: string }
    | undefined;
  return row ?? null;
}

export function mountAuth(api: Hono, db: Db): void {
  api.post("/auth/otp", async (c) => {
    const json = await readJson(c);
    const parsed = OtpRequestBody.safeParse(json);
    if (!parsed.success) {
      return fail(c, 400, "Invalid request", "bad_request");
    }
    const email = normalizeEmail(parsed.data.email);
    if (!email) {
      return fail(c, 400, "Invalid email", "bad_request");
    }
    const includeLink = parsed.data.includeLink === true;
    const ip = clientIp(c);
    const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();
    const emailKey = `email:${email}`;
    const ipKey = `ip:${ip}`;

    const limited = db.transaction(() => {
      if (countEvents(db, "otp_request", ipKey, hourAgo) >= OTP_IP_LIMIT) return "ip";
      if (countEvents(db, "otp_request", emailKey, hourAgo) >= OTP_EMAIL_LIMIT) {
        return "email";
      }
      recordEvent(db, "otp_request", emailKey);
      recordEvent(db, "otp_request", ipKey);
      consumeEmailOtps(db, email);
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const linkRaw = includeLink ? randomBytes(32).toString("base64url") : null;
      const now = Date.now();
      db.prepare(
        `INSERT INTO otp_codes (id, email, code_hash, link_token_hash, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(
        randomUUID(),
        email,
        sha256hex(code),
        linkRaw ? sha256hex(linkRaw) : null,
        new Date(now + OTP_TTL_MS).toISOString(),
      );
      return { code, linkRaw };
    })();

    if (limited === "ip" || limited === "email") {
      return fail(c, 429, "Too many attempts. Try again later.", "rate_limited");
    }

    const link = limited.linkRaw
      ? `${appOrigin()}/api/auth/callback?token=${limited.linkRaw}`
      : null;
    try {
      await sendOtpEmail(email, limited.code, link);
    } catch (err) {
      console.error(JSON.stringify({ msg: "smtp failed", err: String(err) }));
    }
    return c.body(null, 204);
  });

  api.post("/auth/otp/verify", async (c) => {
    const json = await readJson(c);
    const parsed = OtpVerifyBody.safeParse(json);
    if (!parsed.success) {
      return fail(c, 400, "Invalid request", "bad_request");
    }
    const email = normalizeEmail(parsed.data.email);
    if (!email) {
      return fail(c, 400, "Invalid email", "bad_request");
    }
    const code = parsed.data.code.trim();
    const ip = clientIp(c);
    const userAgent = c.req.header("user-agent");
    const result = db.transaction(() => verifyByCode(db, email, code, ip, userAgent))();
    if (result.kind === "rate") {
      return fail(c, 429, "Too many attempts. Try again later.", "rate_limited");
    }
    if (result.kind === "invalid") {
      return fail(c, 401, "Invalid code", "invalid_otp");
    }
    setSessionCookie(c, result.raw);
    return c.body(null, 204);
  });

  api.get("/auth/callback", (c) => {
    const token = c.req.query("token") ?? "";
    if (!token) {
      return fail(c, 400, "Missing token", "bad_request");
    }
    const ip = clientIp(c);
    const userAgent = c.req.header("user-agent");
    const result = db.transaction(() => verifyByLinkToken(db, token, ip, userAgent))();
    if (result.kind === "rate") {
      return fail(c, 429, "Too many attempts. Try again later.", "rate_limited");
    }
    if (result.kind === "invalid") {
      return fail(c, 401, "Invalid code", "invalid_otp");
    }
    setSessionCookie(c, result.raw);
    return c.redirect(`${appOrigin()}/?login=ok`, 302);
  });

  api.post("/auth/logout", (c) => {
    const raw = getCookie(c, COOKIE);
    if (raw) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256hex(raw));
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  api.get("/me", (c) => {
    const user = sessionUser(db, getCookie(c, COOKIE));
    if (!user) {
      return fail(c, 401, "Not signed in", "unauthorized");
    }
    return c.json({ id: user.id, email: user.email, createdAt: user.createdAt });
  });
}
