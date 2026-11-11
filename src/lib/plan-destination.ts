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
 * passes its own public repository and checkout, so the `off` answer is exactly what the caller uses today.
 */
import { join } from "node:path";
import { readFileIfExists } from "./fs-race-safe.js";

export const PLAN_DESTINATION_KINDS = ["decision", "feedback", "task"] as const;
export type PlanDestinationKind = typeof PLAN_DESTINATION_KINDS[number];

/** A repository and the checkout a writer commits in. */
export interface PlanDestinationRepository { owner: string; repo: string; checkoutDir: string }

export interface PlanDestinationRepositoryDeps {
  /** `<config.root>/state`. `undefined` means this host has no instance config, so the switch is off. */
  stateDir: () => string | undefined;
}

export interface PlanDestinationDeps extends PlanDestinationRepositoryDeps {
  /** The repository and checkout the caller writes to today. Returned unchanged when the switch does not apply. */
  publicRepository: () => PlanDestinationRepository;
}

export type PlanDestination =
  /** `off`: no host file. `not_listed`: the file does not list this kind. Both are the public repository. */
  | ({ outcome: "off" | "not_listed" } & PlanDestinationRepository)
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
 */
export function planDestinationRepository(deps: PlanDestinationRepositoryDeps): PlanDestinationRepositoryRead {
  let stateDir: string | undefined;
  try {
    stateDir = deps.stateDir();
  } catch (e) {
    return { outcome: "unreadable", reason: `instance config: ${(e as Error).message}` };
  }
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

/** Where a NEW plan file of this kind is filed on this host. Reads the host file on each call. */
export function resolvePlanDestination(kind: PlanDestinationKind, deps: PlanDestinationDeps): PlanDestination {
  const named = planDestinationRepository(deps);
  if (named.outcome === "unreadable") return named;
  if (named.outcome === "off") return { outcome: "off", ...deps.publicRepository() };
  if (!named.kinds.includes(kind)) return { outcome: "not_listed", ...deps.publicRepository() };
  return { outcome: "destination", owner: named.owner, repo: named.repo, checkoutDir: named.checkoutDir };
}
