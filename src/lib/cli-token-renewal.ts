/**
 * lib/cli-token-renewal.ts — W1-T15038: a CLI verb that runs past an hour keeps a live GitHub token.
 *
 * The CLI entry used to mint the installation token once when GH_TOKEN was unset. The token lives one hour, so any
 * verb that ran longer (a hand `rmd review`, for one) lost GitHub part-way through. This arms the shared renewal loop
 * ({@link startInstallationTokenRefresh}) instead. `daemon` and `serve` arm their own loop, so they keep the one-shot
 * mint here. With no GH_APP_* names the loop is not armed and the one-shot mint runs exactly as before.
 */
import { refreshInstallationToken, startInstallationTokenRefresh } from "./github-app.js";

type StartOptions = Parameters<typeof startInstallationTokenRefresh>[0];

/** The verbs that arm their own renewal loop, so the CLI entry only mints for them once. */
export const SELF_RENEWING_VERBS: ReadonlySet<string> = new Set(["daemon", "serve"]);

/** What the CLI entry did about the GitHub token. */
export type CliTokenRenewal = "skipped" | "armed" | "minted-once";

/**
 * Give a CLI verb its GitHub token: nothing when GH_TOKEN is already set; the renewal loop (first mint awaited, later
 * renewals on an unref'd timer, so a short verb still exits at once) for any verb but `daemon` and `serve` when the
 * GH_APP_* names are set; otherwise the one-shot mint.
 */
export async function armCliTokenRenewal(o: {
  cmd: string | undefined;
  log: StartOptions["log"];
  env?: NodeJS.ProcessEnv;
  refresh?: NonNullable<StartOptions["refresh"]>;
  start?: typeof startInstallationTokenRefresh;
}): Promise<CliTokenRenewal> {
  const env = o.env ?? process.env;
  if (env.GH_TOKEN) return "skipped";
  const refresh = o.refresh ?? refreshInstallationToken;
  if (o.cmd === undefined || !SELF_RENEWING_VERBS.has(o.cmd)) {
    const loop = (o.start ?? startInstallationTokenRefresh)({ log: o.log, refresh, ...(o.env ? { env: o.env } : {}) });
    if (loop.armed) {
      await loop.ready;
      return "armed";
    }
  }
  await refresh({ log: o.log, ...(o.env ? { env: o.env } : {}) });
  return "minted-once";
}
