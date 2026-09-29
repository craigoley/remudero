/**
 * Reading THIS checkout's owner/repo from its origin, and the typed failure when it cannot.
 *
 * A separate, PURE module on purpose: `src/lib/repo-location.ts` evaluates `process.argv` at import
 * and its exports are pinned to the argv cluster, so a class a caller needs for `instanceof`, and a
 * root-parameterised reader a test can drive, cannot live there without every importer paying that.
 */
import { execFileSync } from "node:child_process";

export const OWNER_REPO_REMEDY = "run inside a git checkout, or pass --repo <owner>/<repo> where the command accepts it";

export class OwnerRepoUnresolvableError extends Error {
  readonly checkoutRoot: string;
  readonly reason: string;

  constructor(checkoutRoot: string, reason: string) {
    super(`no origin remote resolvable at ${checkoutRoot} (${reason}) — ${OWNER_REPO_REMEDY}`);
    this.name = "OwnerRepoUnresolvableError";
    this.checkoutRoot = checkoutRoot;
    this.reason = reason;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.trim();
}

/** Why `git config --get remote.origin.url` failed, in one line. Outside a work tree git exits 1
 *  and says NOTHING, exactly like an unset key, so a bare exit 1 is told apart by asking git
 *  whether `root` is a checkout at all. */
function gitFailureReason(e: unknown, root: string): string {
  const err = e as { stderr?: unknown; status?: unknown; message?: unknown };
  const stderr = firstLine(String(err?.stderr ?? ""));
  if (stderr) return stderr;
  if (err?.status !== 1) return firstLine(String(err?.message ?? e));
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return "remote.origin.url is not set";
  } catch {
    return "not inside a git work tree";
  }
}

/** Owner + repo parsed from the origin url of the checkout at `root`. Any failure to read or parse
 *  it throws {@link OwnerRepoUnresolvableError}. */
export function resolveOwnerRepoAt(root: string): { owner: string; repo: string } {
  let url: string;
  try {
    url = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    throw new OwnerRepoUnresolvableError(root, gitFailureReason(e, root));
  }
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    throw new OwnerRepoUnresolvableError(root, `cannot parse owner/repo from origin url "${url.replace(/\/\/[^/@]*@/, "//")}"`);
  }
  return { owner: m[1], repo: m[2] };
}

/** A caller that catches an arbitrary failure from an injected resolver gets the typed error too. */
export function asOwnerRepoUnresolvable(e: unknown, checkoutRoot: string): OwnerRepoUnresolvableError {
  return e instanceof OwnerRepoUnresolvableError ? e : new OwnerRepoUnresolvableError(checkoutRoot, firstLine(String((e as Error)?.message ?? e)));
}
