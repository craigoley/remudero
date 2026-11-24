import { startInstallationTokenRefresh, type InstallationTokenRefresh, type refreshInstallationToken } from "./github-app.js";
import { systemClock, type Clock } from "./clock.js";
import { readGardenerOrigin } from "./worker-containment.js";

type RefreshOptions = {
  start?: typeof startInstallationTokenRefresh;
  refresh?: typeof refreshInstallationToken;
};

/** W1-T14623: the reason a garden's GitHub call is refused when its held token expired and was not renewed. */
export const GARDEN_TOKEN_EXPIRED = "token_expired";

/** What a garden pass knows about its held token: no managed renewal here, a live token, one renewed now, or a dead one. */
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
  const renewal = (options.start ?? startInstallationTokenRefresh)({ log, refresh: options.refresh });
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
 * W1-T14623: the held token's state, read without renewing. A renewal timer cannot fire while a pass's loop is
 * blocked by synchronous `gh` calls, so the token can be past its expiry here. Outside a managed pass, or before
 * the first mint, nothing is known and the call proceeds as before.
 */
export function gardenTokenState(): GardenTokenState {
  const held = active;
  const expiresAt = held?.renewal.expiresAtMs?.();
  if (held === undefined || expiresAt === undefined) return { state: "unmanaged" };
  if (held.clock.now() < expiresAt) return { state: "fresh" };
  return { state: "expired", reason: "the held token's expiry passed while the pass's loop was blocked" };
}

/**
 * W1-T14623: call before a synchronous GitHub call in a managed garden pass. It cannot renew without blocking the
 * loop, so a dead token refuses the call with {@link GARDEN_TOKEN_EXPIRED} and the call is never spawned.
 */
export function refuseExpiredGardenToken(): void {
  const token = gardenTokenState();
  if (token.state === "expired") throw new Error(`${GARDEN_TOKEN_EXPIRED}: ${token.reason}`);
}

/**
 * W1-T14623: call before an awaited GitHub call in a managed garden pass. Past the held token's expiry this runs
 * the refresh loop's own renewal and waits for it, so the call presents the new `GH_TOKEN`; when that renewal
 * fails the call is refused with {@link GARDEN_TOKEN_EXPIRED}. A live token is left alone: no extra mint.
 */
export async function renewExpiredGardenToken(): Promise<GardenTokenState> {
  const token = gardenTokenState();
  const renewNow = active?.renewal.renewNow;
  if (token.state !== "expired" || renewNow === undefined) return token;
  const result = await renewNow();
  if (result.ok) return { state: "renewed" };
  throw new Error(`${GARDEN_TOKEN_EXPIRED}: renewing the held token failed (${result.reason ?? "unknown"})`);
}
