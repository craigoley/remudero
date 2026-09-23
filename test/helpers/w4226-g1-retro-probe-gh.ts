/**
 * test/helpers/w4226-g1-retro-probe-gh.ts — W1-T4226 (group 1).
 *
 * `retroCommand` builds its SHIPPED gateway (`retroShippedGithubGateway`, run-task.ts) internally,
 * with no deps seam, and that gateway's `unavailable()` is `probeGithubThrottle()` — which shells
 * the real `gh api rate_limit` and then `gh api user`. A test driving `retroCommand(["--dry-run"])`
 * without a `gh` of its own therefore reaches the shared refusal stub, and the gather renders the
 * "GitHub unavailable" branch its title never named.
 *
 * This runs `body` with a scripted `gh` (test/helpers/gh-shim.ts) ahead of the refusal stub on
 * PATH that answers the probe HEALTHY — primary quota remaining, and a live authenticated call —
 * so the gather takes the same GitHub-available path it takes in production.
 */
import { rmSync } from "node:fs";
import { ghShim, type GhShim } from "./gh-shim.js";

export async function withHealthyRetroProbeGh<T>(body: (shim: GhShim) => Promise<T>): Promise<T> {
  const shim = ghShim(
    [
      { when: "api rate_limit", stdout: "5000" },
      { when: "api user", stdout: "retro-probe-fixture" },
    ],
    { kind: "w4226-g1-retro-probe-gh" },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  try {
    return await body(shim);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}
