import { startInstallationTokenRefresh, type refreshInstallationToken } from "./github-app.js";
import { installGhHeldTokenGuard } from "./github-transport.js";
import { readGardenerOrigin } from "./worker-containment.js";

type RefreshOptions = {
  start?: typeof startInstallationTokenRefresh;
  refresh?: typeof refreshInstallationToken;
};

/** A managed garden owns its token renewal: its parent's later env updates cannot reach this process. */
export async function withManagedGardenTokenRefresh<T>(
  name: string,
  log: (step: string, fields?: Record<string, unknown>) => void,
  run: () => Promise<T>,
  options: RefreshOptions = {},
): Promise<T> {
  const origin = readGardenerOrigin();
  if (origin?.state !== "linked" || origin.name !== name) return run();
  const renewal = (options.start ?? startInstallationTokenRefresh)({ log, refresh: options.refresh });
  // W1-T14623: a long pass's loop can block its renewal timer past the held token's expiry. W1-T14543's guard then
  // renews before an awaited gh call, and refuses a synchronous one with token_expired before it is spawned.
  const { tokenState, ensureFresh } = renewal;
  const uninstall = tokenState && ensureFresh ? installGhHeldTokenGuard({ tokenState, ensureFresh }) : undefined;
  try {
    if (renewal.ready) await renewal.ready;
    return await run();
  } finally {
    uninstall?.();
    renewal.stop?.();
  }
}
