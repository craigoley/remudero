/**
 * W1-T12200: THE REPOSITORY THAT TAKES A NEW PLAN FILE. One host switch, one resolver.
 *
 * The switch is the host file `<state dir>/plan-destination.json`, beside `daemon-target.json`:
 * `{"repository": "<owner>/<name>", "kinds": ["decision"]}`. An absent file is the outcome `off`: the
 * caller's public repository, unchanged. The rule for each writer: a file is edited in the repository
 * that holds it; only a NEW file follows the switch.
 *
 * READ ON EACH CALL, NO CACHE. An operator turns a kind off by editing the file. The next call sees it.
 *
 * NO GUESS. A file that is present but wrong is `unreadable` with a reason and no repository. It is never
 * read as "off": a writer that fell back to the public repository would file in the wrong place. The
 * listing of the `repos/` directory is never read.
 *
 * NO PRIVATE BYTES IN A REASON. A reason names the file path and the rule that failed. It never quotes
 * the file's content or the JSON parser's message, because the content names a private repository and
 * the reason may reach a ledger row (the W1-T11768 rule).
 *
 * This module does not import `repo-location.ts` (that file reads `process.argv` at import). The caller
 * passes the state directory and its own public repository and checkout as plain values, so the `off`
 * answer is exactly what the caller uses today, and there is no injection seam to count.
 */
import { join } from "node:path";
import { readFileIfExists } from "./fs-race-safe.js";

export const PLAN_DESTINATION_KINDS = ["decision", "feedback", "task"] as const;
export type PlanDestinationKind = typeof PLAN_DESTINATION_KINDS[number];

/** A repository and the checkout a writer commits in. */
export interface PlanDestinationRepository { owner: string; repo: string; checkoutDir: string }

export type PlanDestination =
  /** `off`: no host file. `not_listed`: the file does not list this kind. Both are the public repository.
   * `another_repository` (W1-T14320): the target is not the instance's own repository, so the target is returned. */
  | ({ outcome: "off" | "not_listed" | "another_repository" } & PlanDestinationRepository)
  /** The file names a repository and lists this kind. */
  | ({ outcome: "destination" } & PlanDestinationRepository)
  /** The file is present and cannot be trusted. There is no repository to write to. */
  | { outcome: "unreadable"; reason: string };

export type PlanDestinationRepositoryRead =
  | { outcome: "off" }
  | ({ outcome: "named"; kinds: PlanDestinationKind[] } & PlanDestinationRepository)
  | { outcome: "unreadable"; reason: string };

export function planDestinationPath(stateDir: string): string {
  return join(stateDir, "plan-destination.json");
}

// GitHub's own alphabet for an owner and a name. A name of dots only would leave the `repos/` directory.
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const DOTS_ONLY = /^\.+$/;

function isKind(value: unknown): value is PlanDestinationKind {
  return typeof value === "string" && (PLAN_DESTINATION_KINDS as readonly string[]).includes(value);
}

/**
 * The repository the host file names, for a reader that reads both roots. It answers while the file names
 * a repository, also when `kinds` is empty: files that already went there stay there.
 * The checkout is `<config.root>/repos/<name>`, the sibling of the state directory.
 * `stateDir` is `<config.root>/state`. `undefined` means this host has no instance config, so the switch is off.
 */
export function planDestinationRepository(stateDir: string | undefined): PlanDestinationRepositoryRead {
  if (stateDir === undefined) return { outcome: "off" };
  const path = planDestinationPath(stateDir);
  let raw: string | undefined;
  try {
    raw = readFileIfExists(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { outcome: "unreadable", reason: `${path}: cannot read the file (${typeof code === "string" ? code : "error"})` };
  }
  if (raw === undefined) return { outcome: "off" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message quotes the content, and the content names a private repository. Return the rule only.
    return { outcome: "unreadable", reason: `${path}: not valid JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { outcome: "unreadable", reason: `${path}: not a {repository, kinds} record` };
  }
  const { repository, kinds } = parsed as { repository?: unknown; kinds?: unknown };
  const parts = typeof repository === "string" ? repository.split("/") : [];
  const [owner, repo] = parts;
  if (parts.length !== 2 || owner === undefined || repo === undefined || !SEGMENT.test(owner) || !SEGMENT.test(repo) ||
    DOTS_ONLY.test(owner) || DOTS_ONLY.test(repo)) {
    return { outcome: "unreadable", reason: `${path}: repository is not <owner>/<name>` };
  }
  if (!Array.isArray(kinds) || !kinds.every(isKind)) {
    return { outcome: "unreadable", reason: `${path}: kinds is not a list of ${PLAN_DESTINATION_KINDS.join(", ")}` };
  }
  return {
    outcome: "named", owner, repo,
    checkoutDir: join(stateDir, "..", "repos", repo),
    kinds: PLAN_DESTINATION_KINDS.filter((kind) => kinds.includes(kind)),
  };
}

/**
 * Where a NEW plan file of this kind is filed on this host. Reads the host file on each call.
 * `publicRepository` is the repository and checkout the caller writes to today. It is returned unchanged
 * when the switch does not apply.
 */
export function resolvePlanDestination(
  kind: PlanDestinationKind,
  stateDir: string | undefined,
  publicRepository: PlanDestinationRepository,
): PlanDestination {
  const named = planDestinationRepository(stateDir);
  if (named.outcome === "unreadable") return named;
  if (named.outcome === "off") return { outcome: "off", ...publicRepository };
  if (!named.kinds.includes(kind)) return { outcome: "not_listed", ...publicRepository };
  return { outcome: "destination", owner: named.owner, repo: named.repo, checkoutDir: named.checkoutDir };
}

/** W1-T14320: the same repository, compared as GitHub compares names: without regard to case. */
function sameRepository(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * W1-T14320: where a NEW plan file of this kind is filed for a lane whose target is `target`. The host file is for
 * the instance's own plans only. A target that is another repository (a product plan) is filed in that repository,
 * as with no host file, also when the host file is unreadable. `ownRepository` reads the instance's own repository;
 * it is called only when the host file would move the file, so a host with the switch off makes no added read.
 * An own repository that cannot be read is `unreadable`: the lane is not guessed into either repository.
 */
export function resolvePlanDestinationForTarget(
  kind: PlanDestinationKind,
  stateDir: string | undefined,
  target: PlanDestinationRepository,
  ownRepository: () => { owner: string; repo: string },
): PlanDestination {
  const destination = resolvePlanDestination(kind, stateDir, target);
  if (destination.outcome !== "destination" && destination.outcome !== "unreadable") return destination;
  let own: { owner: string; repo: string };
  try {
    own = ownRepository();
  } catch (e) {
    void e; // The failure text can name a checkout path. The reason names the rule only.
    return { outcome: "unreadable", reason: "the instance's own repository cannot be read, so the plan destination cannot be applied" };
  }
  return sameRepository(target, own) ? destination : { outcome: "another_repository", ...target };
}
