/**
 * Server-owned provider browser-auth sessions (provider-auth-v1).
 *
 * The browser receives an opaque session projection only. Provider processes, credential homes,
 * raw JSON-RPC messages, and completion validation stay on the daemon side. This module is the
 * intentionally small boundary between the console gateway and provider-specific auth flows.
 */

import { accessSync, constants as fsConstants, readFileSync, rmSync } from "node:fs";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readBoundedRawBody, RawBodyTooLargeError, type Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { createClaudeFleetLoginStagingDir, replaceClaudeFleetCredential, type ClaudeFleetCredentialReplacement } from "./worker-home.js";

export const PROVIDER_AUTH_VERSION = "provider-auth-v1" as const;
export const PROVIDER_AUTH_TTL_MS = 10 * 60 * 1000;
const MAX_SESSION_ID_LENGTH = 96;
const MAX_REASON_LENGTH = 240;
const MAX_LABEL_LENGTH = 160;
const MAX_AUTH_URL_LENGTH = 2_048;
const CODEX_AUTH_HOSTS = new Set(["auth.openai.com", "chatgpt.com"]);
/** W1-T10380: the hosts the pinned Claude CLI's `auth login` prints its authorize URL on (fixture in the test). */
export const CLAUDE_AUTH_HOSTS = new Set(["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"]);
/** PRIMARY CONTROL: the longest pasted code the CLI is ever handed; anything longer is refused unread. */
export const MAX_CLAUDE_CODE_LENGTH = 1_024;
const MAX_CLAUDE_OUTPUT_LENGTH = 64 * 1024;
const CLAUDE_CODE_WAIT_MS = 20_000;

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
  /** Server-only Claude CLI override. Never appears in a projection. */
  claudeBin?: string;
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
  /** W1-T10380: a redacted label for the account a completed Claude login now runs the fleet on. */
  accountLabel?: string;
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
  /** W1-T10380: the HOME whose `.claude/fleet-auth/claude` is the fleet store. Defaults to `homedir()`. */
  claudeRealHome?: string;
  /** W1-T10380: the real Claude CLI; may throw when none resolves. Defaults to the profile's or PATH's. */
  resolveClaudeBin?: (profile: ProviderAuthProfile) => string | null;
  replaceClaudeStore?: typeof replaceClaudeFleetCredential;
  codeWaitMs?: number;
};

/** {@link ProviderAuthSessionStore.submitCode}'s answer; a projection never carries the code. */
export type ProviderAuthCodeResult =
  | { outcome: "not_found" }
  | { outcome: "invalid" | "conflict" | "accepted"; projection: ProviderAuthProjection };

type SessionRecord = {
  projection: ProviderAuthProjection;
  profile: ProviderAuthProfile | null;
  expiresAtMs: number;
  child?: ProviderAuthChild;
  loginId?: string;
  buffer: string;
  /** W1-T10380: the session's private `CLAUDE_CONFIG_DIR`; removed on every terminal path. */
  stagingDir?: string;
  codeSubmitted?: boolean;
  waiters?: Array<() => void>;
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
  const claudeBin = boundedText(candidate.claudeBin ?? candidate.claude_bin, 500);
  if (!id || !provider || !label) return null;
  if (provider === "codex" && !credentialHome) return null;
  return {
    id, provider, label,
    ...(credentialHome ? { credentialHome } : {}), ...(codexBin ? { codexBin } : {}), ...(claudeBin ? { claudeBin } : {}),
  };
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

function allowedAuthUrl(value: unknown, hosts: ReadonlySet<string> = CODEX_AUTH_HOSTS): string | null {
  const candidate = boundedText(value, MAX_AUTH_URL_LENGTH);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !hosts.has(url.hostname.toLowerCase())) return null;
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
  return defaultProviderBin(profile.codexBin, "codex");
}

function defaultProviderBin(candidate: string | undefined, command: string): string | null {
  const resolved = candidate ?? (() => {
    try {
      return execFileSync("which", [command], { encoding: "utf8" }).trim();
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
  if (record.stagingDir) {
    rmSync(record.stagingDir, { recursive: true, force: true });
    record.stagingDir = undefined;
  }
  for (const wake of record.waiters?.splice(0) ?? []) wake();
}

/** W1-T10380: the Claude CLI's environment — an allowlist, with HOME and CLAUDE_CONFIG_DIR both the
 *  staging dir, so neither the fleet store nor the host's `~/.claude` is reachable from the login. */
function claudeLoginEnvironment(stagingDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: stagingDir, HOME: stagingDir };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** A pasted authorization code: printable ASCII, no whitespace, length-bounded. Never stored. */
function claudeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return code.length > 0 && code.length <= MAX_CLAUDE_CODE_LENGTH && /^[\x21-\x7e]+$/.test(code) ? code : null;
}

/** The first allowlisted authorize URL in the CLI's output, never any other text it printed. */
function claudeAuthUrl(text: string): string | null {
  for (const token of text.match(/https:\/\/[^\s"'<>]+/g) ?? []) {
    const url = allowedAuthUrl(token, CLAUDE_AUTH_HOSTS);
    if (url && new URL(url).pathname.includes("/oauth/authorize")) return url;
  }
  return null;
}

/** A redacted label for the account the CLI signed in (`j***@example.com`), from the staged `.claude.json`. */
function redactedClaudeAccount(stagingDir: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(stagingDir, ".claude.json"), "utf8"));
  } catch {
    // The label annotates a completed login and never gates it: an absent or unparseable file has none.
    return undefined;
  }
  const email = (parsed as { oauthAccount?: { emailAddress?: unknown } } | null)?.oauthAccount?.emailAddress;
  if (typeof email !== "string") return undefined;
  const at = email.lastIndexOf("@");
  return at > 0 ? `${email[0]}***${email.slice(at)}`.slice(0, MAX_LABEL_LENGTH) : undefined;
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
  private readonly resolveClaudeBin: (profile: ProviderAuthProfile) => string | null;
  private readonly claudeRealHome: string;

  constructor(private readonly deps: ProviderAuthSessionDeps) {
    this.clock = clock(deps.now);
    this.ttlMs = Math.max(1_000, Math.min(deps.ttlMs ?? PROVIDER_AUTH_TTL_MS, PROVIDER_AUTH_TTL_MS));
    this.randomId = deps.randomId ?? (() => randomBytes(24).toString("base64url"));
    this.spawn = deps.spawn ?? ((command, args, options) => spawnProcess(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
    this.resolveCodexBin = deps.resolveCodexBin ?? defaultCodexBin;
    this.resolveClaudeBin = deps.resolveClaudeBin ?? ((profile) => defaultProviderBin(profile.claudeBin, "claude"));
    this.claudeRealHome = deps.claudeRealHome ?? homedir();
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
    if (profile.provider === "claude") return this.startClaude(record, profile);
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

  /** W1-T10380: drive the CLI's own `auth login` in a private staging dir; its authorize URL is the projection's. */
  private startClaude(record: SessionRecord, profile: ProviderAuthProfile): ProviderAuthProjection {
    let bin: string | null;
    try {
      bin = this.resolveClaudeBin(profile);
    } catch {
      // The resolver's refusal names searched paths, which never cross into a projection.
      bin = null;
    }
    if (!bin) {
      finishChild(record, "unavailable", "Claude executable is not available on the daemon.");
      return projection(record);
    }
    try {
      record.stagingDir = createClaudeFleetLoginStagingDir(this.claudeRealHome);
      const child = this.spawn(bin, ["auth", "login", "--claudeai"], { env: claudeLoginEnvironment(record.stagingDir), stdio: ["pipe", "pipe", "pipe"] });
      record.child = child;
      child.stdout.on("data", (chunk: Buffer) => {
        if (record.projection.authUrl) return;
        record.buffer = (record.buffer + chunk.toString("utf8")).slice(-MAX_CLAUDE_OUTPUT_LENGTH);
        const authUrl = claudeAuthUrl(record.buffer);
        if (!authUrl || record.projection.state !== "awaiting_browser") return;
        record.buffer = "";
        record.projection = { ...record.projection, authUrl };
      });
      child.stderr.on("data", () => undefined);
      child.stdin.on("error", () => finishChild(record, "failed", "The Claude login stopped reading its code."));
      child.once("error", () => finishChild(record, "failed", "The Claude login process failed."));
      child.once("exit", (code: number | null) => {
        record.child = undefined;
        void this.completeClaude(record, code);
      });
    } catch {
      // A spawn or staging failure ends the session; its message may carry a path, so it stays server-side.
      finishChild(record, "unavailable", "The Claude login could not start on the daemon.");
    }
    return projection(record);
  }

  private async completeClaude(record: SessionRecord, code: number | null): Promise<void> {
    if (record.projection.state !== "awaiting_browser") return;
    if (code !== 0 || !record.codeSubmitted || !record.stagingDir) {
      finishChild(record, "failed", `The Claude login ended without completing (exit ${code ?? "unknown"}).`);
      return;
    }
    const stagingDir = record.stagingDir;
    const live = (): boolean => record.projection.state === "awaiting_browser" && this.clock.now() < record.expiresAtMs;
    let result: ClaudeFleetCredentialReplacement;
    try {
      result = await (this.deps.replaceClaudeStore ?? replaceClaudeFleetCredential)({ realHome: this.claudeRealHome, stagingDir, proceed: live });
    } catch {
      // The replacement writes by rename under the refresh lock, so a throw left the store's old file in place.
      result = { kind: "refused", reasonClass: "fleet-store-write-failed" };
    }
    if (record.projection.state !== "awaiting_browser") return;
    if (result.kind !== "replaced") {
      finishChild(record, live() ? "failed" : "expired", `The Claude login did not produce a usable fleet credential (${result.reasonClass}).`);
      return;
    }
    const accountLabel = redactedClaudeAccount(stagingDir);
    if (accountLabel) record.projection = { ...record.projection, accountLabel };
    finishChild(record, "complete");
  }

  /** W1-T10380: hand the operator's pasted code to the waiting CLI once, then wait (bounded) for the outcome. */
  async submitCode(sessionId: string, rawCode: unknown): Promise<ProviderAuthCodeResult> {
    this.expireSessions();
    const record = this.sessions.get(sessionId);
    if (!record) return { outcome: "not_found" };
    const code = claudeCode(rawCode);
    if (!code) return { outcome: "invalid", projection: projection(record) };
    const child = record.child;
    if (record.projection.provider !== "claude" || record.projection.state !== "awaiting_browser" || !record.projection.authUrl || !child || record.codeSubmitted) {
      return { outcome: "conflict", projection: projection(record) };
    }
    record.codeSubmitted = true;
    const settled = new Promise<void>((wake) => {
      const timer = setTimeout(wake, this.deps.codeWaitMs ?? CLAUDE_CODE_WAIT_MS);
      timer.unref?.();
      (record.waiters ??= []).push(() => {
        clearTimeout(timer);
        wake();
      });
    });
    child.stdin.write(`${code}\n`);
    await settled;
    return { outcome: "accepted", projection: projection(record) };
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

/** W1-T10380: `PATCH /v1/provider-auth` takes the pasted Claude code in the BODY with its session id —
 *  the v0 router matches exact paths only, and a code in a URL would reach logs and `Referer`. */
export function buildProviderAuthCodeRoutes(store: ProviderAuthSessionStore, maxBodyBytes = 8 * 1024): Route[] {
  return [
    {
      method: "PATCH",
      path: "/v1/provider-auth",
      scope: "write",
      tier: "middle",
      handler: async (req, res) => {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req, maxBodyBytes);
        } catch (error) {
          sendJson(res, error instanceof RawBodyTooLargeError ? 413 : 400, { error: "invalid_request", detail: "body must be bounded JSON" });
          return;
        }
        const body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        const sessionId = providerAuthSessionId(body.sessionId);
        if (!sessionId) {
          sendJson(res, 400, { error: "invalid_request", detail: "sessionId is required" });
          return;
        }
        const result = await store.submitCode(sessionId, body.code);
        if (result.outcome === "not_found") {
          sendJson(res, 404, { error: "not_found", detail: "provider auth session was not found" });
          return;
        }
        if (result.outcome === "accepted") {
          sendJson(res, 200, result.projection);
          return;
        }
        const detail = result.outcome === "invalid" ? "code must be the bounded authorization code the provider showed" : "this session is not waiting for a code";
        sendJson(res, result.outcome === "invalid" ? 400 : 409, { error: result.outcome === "invalid" ? "invalid_request" : "conflict", detail });
      },
    },
  ];
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
