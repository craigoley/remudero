import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  EXCHANGE_TIMEOUT_MS, INSTALLATION_TOKEN_LIFETIME_MS, TOKEN_REFRESH_FAILED_STEP, TOKEN_REFRESHED_STEP, keyReadErrorCode, signAppJwt,
  startInstallationTokenRefresh, type InstallationTokenConfig, type InstallationTokenRefresh, type InstallationTokenResult,
  type RefreshOptions as TokenRefreshOptions, type refreshInstallationToken,
} from "./github-app.js";
import { systemClock, type Clock } from "./clock.js";
import { readGardenerOrigin } from "./worker-containment.js";

type RefreshOptions = {
  start?: typeof startInstallationTokenRefresh;
  refresh?: typeof refreshInstallationToken;
};

/** W1-T14623: the reason a garden's GitHub call is refused when its held token expired and could not be renewed. */
export const GARDEN_TOKEN_EXPIRED = "token_expired";

/** What {@link ensureGardenTokenFresh} found: no managed renewal here, a live token, one renewed now, or a dead one. */
export type GardenTokenState =
  | { state: "unmanaged" }
  | { state: "fresh" }
  | { state: "renewed" }
  | { state: "expired"; reason: string };

let active: { renewal: InstallationTokenRefresh; clock: Clock } | undefined;

/** A managed garden owns its token renewal: its parent's later env updates cannot reach this process. */
export async function withManagedGardenTokenRefresh<T>(
  name: string,
  log: (step: string, fields?: Record<string, unknown>) => void,
  run: () => Promise<T>,
  options: RefreshOptions & { clock?: Clock } = {},
): Promise<T> {
  const origin = readGardenerOrigin();
  if (origin?.state !== "linked" || origin.name !== name) return run();
  const renewal = (options.start ?? startInstallationTokenRefresh)({ log, refresh: options.refresh, mintSync: mintInstallationTokenSync });
  const previous = active;
  active = { renewal, clock: options.clock ?? systemClock };
  try {
    if (renewal.ready) await renewal.ready;
    return await run();
  } finally {
    active = previous;
    renewal.stop?.();
  }
}

/**
 * W1-T14623: call before a GitHub call in a managed garden pass. A renewal timer cannot fire while the pass's loop
 * is blocked by synchronous `gh` calls, so past the held token's expiry this renews in place, blocking, and the
 * call spawns with the new `GH_TOKEN`; when that renewal fails the caller must refuse the call. Outside a managed
 * pass, or before the first mint, nothing is known and the call proceeds as before.
 */
export function ensureGardenTokenFresh(): GardenTokenState {
  const held = active;
  const expiresAt = held?.renewal.expiresAtMs?.();
  if (held === undefined || expiresAt === undefined || held.renewal.renewSync === undefined) return { state: "unmanaged" };
  if (held.clock.now() < expiresAt) return { state: "fresh" };
  const result = held.renewal.renewSync();
  return result.ok ? { state: "renewed" } : { state: "expired", reason: result.reason ?? "unknown" };
}

/** Throws a {@link GARDEN_TOKEN_EXPIRED} error when {@link ensureGardenTokenFresh} found a dead token. */
export function refuseExpiredGardenToken(): void {
  const token = ensureGardenTokenFresh();
  if (token.state === "expired") throw new Error(`${GARDEN_TOKEN_EXPIRED}: the pass's App token expired and renewing it failed (${token.reason})`);
}

/** W1-T14623: the exchange a synchronous renewal runs in a child, so a caller whose loop is blocked can still
 *  mint. The JWT travels on the child's stdin; the script text holds no secret, and the token comes back on
 *  stdout, never argv, env or a row. */
const SYNC_EXCHANGE_SCRIPT = `(async () => {
  const out = (v) => process.stdout.write(JSON.stringify(v));
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const res = await fetch(input.url, { method: "POST", signal: AbortSignal.timeout(input.timeoutMs),
      headers: { Authorization: "Bearer " + input.jwt, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Connection: "close" } });
    if (!res.ok) return out({ status: res.status });
    const body = await res.json();
    out({ token: body.token, expires_at: body.expires_at });
  } catch (err) {
    out({ error: (err && err.cause && err.cause.code) || (err && err.code) || (err && err.name) || "unknown" });
  }
})();`;

export type SyncExchangeSpawn = (file: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; input: string; encoding: "utf8"; timeout: number }) =>
  Pick<SpawnSyncReturns<string>, "stdout" | "error">;

/** W1-T14623: {@link mintInstallationToken}'s exchange, run to completion before it returns, for a caller that
 *  cannot await (a synchronous `gh` spawn inside a long synchronous stretch). Same reasons, same rows. It lives
 *  here, not in github-app.ts, which never shells out (W1-T1024). */
export function mintInstallationTokenSync(
  config: InstallationTokenConfig,
  opts: Pick<TokenRefreshOptions, "now" | "readKey" | "retainedKey" | "log"> & { spawn?: SyncExchangeSpawn; apiUrl?: string } = {},
): InstallationTokenResult {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const { appId, installationId, privateKeyPath } = config;
  if (!appId || !installationId || !privateKeyPath) return { ok: false, reason: "app not configured" };
  let pem: string;
  try {
    pem = (opts.readKey ?? ((p: string) => readFileSync(p, "utf8")))(privateKeyPath);
    if (opts.retainedKey) opts.retainedKey.pem = pem;
  } catch (err) {
    if (opts.retainedKey?.pem === undefined) {
      log(TOKEN_REFRESH_FAILED_STEP, { reason: "private key unreadable", error_code: keyReadErrorCode(err), mode: "sync" });
      return { ok: false, reason: "private key unreadable" };
    }
    pem = opts.retainedKey.pem;
  }
  let jwt: string;
  try {
    jwt = signAppJwt(appId, pem, now);
  } catch {
    log(TOKEN_REFRESH_FAILED_STEP, { reason: "jwt signing failed", mode: "sync" });
    return { ok: false, reason: "jwt signing failed" };
  }
  const { NODE_OPTIONS: _loader, ...inherited } = process.env;
  const child = (opts.spawn ?? spawnSync)(process.execPath, ["-e", SYNC_EXCHANGE_SCRIPT], {
    env: inherited, encoding: "utf8", timeout: EXCHANGE_TIMEOUT_MS + 5_000,
    input: JSON.stringify({ jwt, timeoutMs: EXCHANGE_TIMEOUT_MS,
      url: `${opts.apiUrl ?? "https://api.github.com"}/app/installations/${installationId}/access_tokens` }),
  });
  const fail = (reason: string): InstallationTokenResult => {
    log(TOKEN_REFRESH_FAILED_STEP, { reason, mode: "sync" });
    return { ok: false, reason };
  };
  if (child.error) return fail("exchange timed out");
  let body: { token?: unknown; expires_at?: unknown; status?: unknown; error?: unknown };
  try {
    body = JSON.parse(String(child.stdout ?? ""));
  } catch (err) {
    log(TOKEN_REFRESH_FAILED_STEP, { reason: "exchange response unparsable", error: err instanceof Error ? err.message : String(err), mode: "sync" });
    return { ok: false, reason: "exchange response unparsable" };
  }
  if (typeof body.status === "number") return fail(`exchange rejected: ${body.status}`);
  if (body.error !== undefined) return fail(body.error === "TimeoutError" ? "exchange timed out" : `exchange request failed: ${String(body.error)}`);
  if (typeof body.token !== "string" || body.token === "" || typeof body.expires_at !== "string") return fail("exchange response missing token");
  const parsed = Date.parse(body.expires_at);
  const expiresAtMs = Number.isFinite(parsed) ? parsed : now() + INSTALLATION_TOKEN_LIFETIME_MS;
  log(TOKEN_REFRESHED_STEP, { installation_id: installationId, expires_at: body.expires_at, mode: "sync" });
  return { ok: true, token: body.token, expiresAtMs };
}
