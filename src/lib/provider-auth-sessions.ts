/**
 * Server-owned provider browser-auth sessions (provider-auth-v1).
 *
 * The browser receives an opaque session projection only. Provider processes, credential homes,
 * raw JSON-RPC messages, and completion validation stay on the daemon side. This module is the
 * intentionally small boundary between the console gateway and provider-specific auth flows.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readBoundedRawBody, RawBodyTooLargeError, type Route } from "./service.js";
import { sendJson } from "./panel-actions.js";

export const PROVIDER_AUTH_VERSION = "provider-auth-v1" as const;
export const PROVIDER_AUTH_TTL_MS = 10 * 60 * 1000;
const MAX_SESSION_ID_LENGTH = 96;
const MAX_REASON_LENGTH = 240;
const MAX_LABEL_LENGTH = 160;
const MAX_AUTH_URL_LENGTH = 2_048;
const CODEX_AUTH_HOSTS = new Set(["auth.openai.com", "chatgpt.com"]);

export type ProviderAuthProvider = "claude" | "codex";
export type ProviderAuthState = "unavailable" | "unsupported" | "awaiting_browser" | "complete" | "failed" | "expired" | "cancelled";

export type ProviderAuthProfile = {
  id: string;
  provider: ProviderAuthProvider;
  label: string;
  /** Server-only credential home. Never appears in a projection. */
  credentialHome?: string;
  /** Server-only executable override. Never appears in a projection. */
  codexBin?: string;
};

export type ProviderAuthProjection = {
  version: typeof PROVIDER_AUTH_VERSION;
  sessionId: string;
  provider: ProviderAuthProvider;
  profileId: string | null;
  label: string | null;
  state: ProviderAuthState;
  authUrl: string | null;
  expiresAt: string;
  reason?: string;
};

export type ProviderAuthInput = {
  provider: ProviderAuthProvider;
  profileId: string;
};

type ProviderAuthClock = {
  now: () => number;
  iso: (ms: number) => string;
};

type ProviderAuthChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill" | "once" | "on">;

export type ProviderAuthSessionDeps = {
  profiles: readonly ProviderAuthProfile[];
  now?: () => number;
  randomId?: () => string;
  ttlMs?: number;
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ProviderAuthChild;
  resolveCodexBin?: (profile: ProviderAuthProfile) => string | null;
  validateEffectiveProfile?: (profile: ProviderAuthProfile) => boolean | Promise<boolean>;
};

type SessionRecord = {
  projection: ProviderAuthProjection;
  profile: ProviderAuthProfile | null;
  expiresAtMs: number;
  child?: ProviderAuthChild;
  loginId?: string;
  buffer: string;
};

function clock(now?: () => number): ProviderAuthClock {
  const readNow = now ?? Date.now;
  return { now: readNow, iso: (ms) => new Date(ms).toISOString() };
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, MAX_SESSION_ID_LENGTH);
}

function safeReason(value: string): string {
  return value.replace(/[\r\n]/g, " ").slice(0, MAX_REASON_LENGTH);
}

function profileId(value: unknown): string | null {
  const candidate = boundedText(value, 160);
  return candidate && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(candidate) ? candidate : null;
}

function profileFromUnknown(value: unknown): ProviderAuthProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const id = profileId(candidate.id);
  const provider = candidate.provider === "claude" || candidate.provider === "codex" ? candidate.provider : null;
  const label = boundedText(candidate.label, MAX_LABEL_LENGTH);
  const credentialHome = boundedText(candidate.credentialHome ?? candidate.credential_home, 500);
  const codexBin = boundedText(candidate.codexBin ?? candidate.codex_bin, 500);
  if (!id || !provider || !label) return null;
  if (provider === "codex" && !credentialHome) return null;
  return { id, provider, label, ...(credentialHome ? { credentialHome } : {}), ...(codexBin ? { codexBin } : {}) };
}

/** Parse only the server-side profile catalog. Malformed configuration yields no usable profiles. */
export function readProviderAuthProfiles(env: NodeJS.ProcessEnv = process.env): ProviderAuthProfile[] {
  const raw = env.RMD_PROVIDER_AUTH_PROFILES?.trim();
  if (!raw) {
    return [
      { id: "claude-default", provider: "claude", label: "Claude account" },
      { id: "codex-default", provider: "codex", label: "Codex account", credentialHome: env.CODEX_HOME ?? join(homedir(), ".codex") },
    ];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const profiles = parsed.flatMap((entry) => {
      const profile = profileFromUnknown(entry);
      return profile ? [profile] : [];
    });
    return profiles.filter((profile, index) => profiles.findIndex((candidate) => candidate.id === profile.id) === index);
  } catch {
    return [];
  }
}

function allowedAuthUrl(value: unknown): string | null {
  const candidate = boundedText(value, MAX_AUTH_URL_LENGTH);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !CODEX_AUTH_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function projection(record: SessionRecord): ProviderAuthProjection {
  return { ...record.projection, authUrl: record.projection.authUrl };
}

function baseProjection(
  sessionId: string,
  profile: ProviderAuthProfile | null,
  state: ProviderAuthState,
  expiresAt: string,
  reason?: string,
): ProviderAuthProjection {
  return {
    version: PROVIDER_AUTH_VERSION,
    sessionId,
    provider: profile?.provider ?? "codex",
    profileId: profile?.id ?? null,
    label: profile?.label ?? null,
    state,
    authUrl: null,
    expiresAt,
    ...(reason ? { reason: safeReason(reason) } : {}),
  };
}

function codexEnvironment(profile: ProviderAuthProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: profile.credentialHome };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function defaultCodexBin(profile: ProviderAuthProfile): string | null {
  const candidate = profile.codexBin;
  const resolved = candidate ?? (() => {
    try {
      return execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  if (!resolved) return null;
  try {
    accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function finishChild(record: SessionRecord, state: ProviderAuthState, reason?: string): void {
  if (record.child) {
    record.child.kill("SIGTERM");
    record.child = undefined;
  }
  record.projection = {
    ...record.projection,
    state,
    authUrl: state === "complete" ? null : record.projection.authUrl,
    ...(reason ? { reason: safeReason(reason) } : {}),
  };
}

function writeRpc(child: ProviderAuthChild, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function processCodexLine(store: ProviderAuthSessionStore, record: SessionRecord, line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    finishChild(record, "failed", "Codex auth returned malformed app-server output.");
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const value = message as Record<string, unknown>;
  const id = value.id;
  const result = typeof value.result === "object" && value.result !== null ? value.result as Record<string, unknown> : undefined;
  const error = typeof value.error === "object" && value.error !== null ? value.error as Record<string, unknown> : undefined;
  if (id === 1) {
    if (error) {
      finishChild(record, "failed", boundedText(error.message, MAX_REASON_LENGTH) ?? "Codex app-server initialization failed.");
      return;
    }
    writeRpc(record.child!, { method: "initialized", params: {} });
    writeRpc(record.child!, { method: "account/login/start", id: 2, params: { type: "chatgpt" } });
    return;
  }
  if (id === 2) {
    const authUrl = allowedAuthUrl(result?.authUrl);
    const loginId = boundedText(result?.loginId, 240);
    if (error || !authUrl || !loginId) {
      finishChild(record, "failed", boundedText(error?.message, MAX_REASON_LENGTH) ?? "Codex did not return an allowed browser authorization URL.");
      return;
    }
    record.loginId = loginId;
    record.projection = { ...record.projection, state: "awaiting_browser", authUrl };
    return;
  }
  if (value.method !== "account/login/completed") return;
  const params = typeof value.params === "object" && value.params !== null ? value.params as Record<string, unknown> : {};
  const completedLoginId = boundedText(params.loginId, 240);
  if (!record.loginId || completedLoginId !== record.loginId) return;
  const profile = record.profile;
  if (!profile) {
    finishChild(record, "failed", "Provider account profile is unavailable.");
    return;
  }
  Promise.resolve(store.validateEffectiveProfile(profile)).then((valid) => {
    if (record.projection.state !== "awaiting_browser") return;
    if (!valid) {
      finishChild(record, "failed", "The provider account profile changed before completion.");
      return;
    }
    finishChild(record, "complete");
  }).catch(() => finishChild(record, "failed", "The provider account profile could not be revalidated."));
}

export class ProviderAuthSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clock: ProviderAuthClock;
  private readonly ttlMs: number;
  private readonly randomId: () => string;
  private readonly spawn: NonNullable<ProviderAuthSessionDeps["spawn"]>;
  private readonly resolveCodexBin: (profile: ProviderAuthProfile) => string | null;

  constructor(private readonly deps: ProviderAuthSessionDeps) {
    this.clock = clock(deps.now);
    this.ttlMs = Math.max(1_000, Math.min(deps.ttlMs ?? PROVIDER_AUTH_TTL_MS, PROVIDER_AUTH_TTL_MS));
    this.randomId = deps.randomId ?? (() => randomBytes(24).toString("base64url"));
    this.spawn = deps.spawn ?? ((command, args, options) => spawnProcess(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
    this.resolveCodexBin = deps.resolveCodexBin ?? defaultCodexBin;
  }

  validateEffectiveProfile(profile: ProviderAuthProfile): boolean | Promise<boolean> {
    return this.deps.validateEffectiveProfile ? this.deps.validateEffectiveProfile(profile) : true;
  }

  async start(input: ProviderAuthInput): Promise<ProviderAuthProjection> {
    this.expireSessions();
    const profile = this.deps.profiles.find((candidate) => candidate.id === input.profileId && candidate.provider === input.provider) ?? null;
    const sessionId = safeSessionId(this.randomId());
    const expiresAtMs = this.clock.now() + this.ttlMs;
    const expiresAt = this.clock.iso(expiresAtMs);
    const record: SessionRecord = {
      profile,
      expiresAtMs,
      projection: baseProjection(sessionId, profile, profile ? "awaiting_browser" : "unavailable", expiresAt, profile ? undefined : "No configured provider account profile matches this request."),
      buffer: "",
    };
    this.sessions.set(sessionId, record);
    if (!profile) return projection(record);
    if (profile.provider === "claude") {
      finishChild(record, "unsupported", "Claude browser handoff is not available through a stable machine-facing contract yet.");
      return projection(record);
    }
    if (!profile.credentialHome) {
      finishChild(record, "unavailable", "Codex credential home is not configured on the daemon.");
      return projection(record);
    }
    const bin = this.resolveCodexBin(profile);
    if (!bin) {
      finishChild(record, "unavailable", "Codex executable is not available on the daemon.");
      return projection(record);
    }
    try {
      const child = this.spawn(bin, ["app-server", "--listen", "stdio://"], { env: codexEnvironment(profile), stdio: ["pipe", "pipe", "pipe"] });
      record.child = child;
      child.stdout.on("data", (chunk: Buffer) => {
        record.buffer += chunk.toString("utf8");
        for (;;) {
          const newline = record.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = record.buffer.slice(0, newline);
          record.buffer = record.buffer.slice(newline + 1);
          processCodexLine(this, record, line);
        }
      });
      child.once("error", (error: Error) => finishChild(record, "failed", `Codex app-server failed: ${error.message}`));
      child.once("exit", (code: number | null) => {
        if (record.projection.state === "awaiting_browser") finishChild(record, "failed", `Codex app-server exited before login completion (${code ?? "unknown"}).`);
      });
      writeRpc(child, { method: "initialize", id: 1, params: { clientInfo: { name: "remudero", title: "Remudero", version: "0.1.0" } } });
      return projection(record);
    } catch (error) {
      finishChild(record, "unavailable", `Codex app-server could not start: ${error instanceof Error ? error.message : String(error)}`);
      return projection(record);
    }
  }

  read(sessionId: string): ProviderAuthProjection | null {
    this.expireSessions();
    const record = this.sessions.get(sessionId);
    return record ? projection(record) : null;
  }

  cancel(sessionId: string): ProviderAuthProjection | null {
    this.expireSessions();
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    if (record.projection.state === "awaiting_browser") finishChild(record, "cancelled", "Provider browser authorization was cancelled.");
    return projection(record);
  }

  private expireSessions(): void {
    const now = this.clock.now();
    for (const record of this.sessions.values()) {
      if (record.projection.state === "awaiting_browser" && now >= record.expiresAtMs) finishChild(record, "expired", "Provider browser authorization expired.");
    }
  }
}

/** Public route-wiring seam; kept named so production assembly cannot leave the store test-only. */
export function startProviderAuthSession(store: ProviderAuthSessionStore, input: ProviderAuthInput): Promise<ProviderAuthProjection> {
  return store.start(input);
}

export function providerAuthSessionId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,96}$/.test(value) ? value : null;
}

function parseStartInput(value: unknown): ProviderAuthInput | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "body must be a JSON object" };
  const body = value as Record<string, unknown>;
  const provider = body.provider === "claude" || body.provider === "codex" ? body.provider : null;
  const profileId = profileIdFromRequest(body.profileId ?? body.profile_id);
  if (!provider) return { error: "provider must be claude or codex" };
  if (!profileId) return { error: "profileId must be an opaque provider profile id" };
  return { provider, profileId };
}

function profileIdFromRequest(value: unknown): string | null {
  const candidate = boundedText(value, 160);
  return candidate && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(candidate) ? candidate : null;
}

async function readJsonBody(req: Parameters<Route["handler"]>[0], maxBytes: number): Promise<unknown> {
  const raw = await readBoundedRawBody(req, maxBytes);
  return raw.trim() ? JSON.parse(raw) : {};
}

/**
 * Mount the versioned browser-auth projection on one exact path. The session id stays in the
 * JSON/query payload rather than a wildcard path because the daemon's v0 router intentionally
 * matches exact method+path pairs only.
 */
export function buildProviderAuthRoutes(
  store: ProviderAuthSessionStore,
  maxBodyBytes = 8 * 1024,
  start: (input: ProviderAuthInput) => Promise<ProviderAuthProjection> = (input) => startProviderAuthSession(store, input),
): Route[] {
  return [
    {
      method: "POST",
      path: "/v1/provider-auth",
      scope: "write",
      tier: "middle",
      handler: async (req, res) => {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req, maxBodyBytes);
        } catch (error) {
          sendJson(res, error instanceof RawBodyTooLargeError ? 413 : 400, { error: "invalid_request", detail: error instanceof Error ? error.message : "body is not valid JSON" });
          return;
        }
        const input = parseStartInput(parsed);
        if ("error" in input) {
          sendJson(res, 400, { error: "invalid_request", detail: input.error });
          return;
        }
        sendJson(res, 200, await start(input));
      },
    },
    {
      method: "GET",
      path: "/v1/provider-auth",
      scope: "read",
      sensitivity: "sensitive",
      handler: (req, res) => {
        const sessionId = providerAuthSessionId(new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId"));
        if (!sessionId) {
          sendJson(res, 400, { error: "invalid_request", detail: "sessionId query parameter is required" });
          return;
        }
        const result = store.read(sessionId);
        sendJson(res, result ? 200 : 404, result ?? { error: "not_found", detail: "provider auth session was not found" });
      },
    },
    {
      method: "DELETE",
      path: "/v1/provider-auth",
      scope: "write",
      tier: "low",
      handler: (req, res) => {
        const sessionId = providerAuthSessionId(new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId"));
        if (!sessionId) {
          sendJson(res, 400, { error: "invalid_request", detail: "sessionId query parameter is required" });
          return;
        }
        const result = store.cancel(sessionId);
        sendJson(res, result ? 200 : 404, result ?? { error: "not_found", detail: "provider auth session was not found" });
      },
    },
  ];
}
