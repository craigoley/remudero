import { startInstallationTokenRefresh, type refreshInstallationToken } from "./github-app.js";
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
  try {
    if (renewal.ready) await renewal.ready;
    return await run();
  } finally {
    renewal.stop?.();
  }
}
