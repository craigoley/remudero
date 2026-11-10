/**
 * W1-T11926: one resolver decides which GitHub credential a `gh` child uses.
 *
 * Observed 2026-11-09: a host-side review run computed PASS and could not post it. Its process had
 * no GH_TOKEN, and gh answered with its own login hint, which names no cause. Each runner found out
 * which credential it had by failing.
 *
 * The rule this module keeps: every `gh` child gets its credential from the first source that
 * answers, in the order of {@link GITHUB_CREDENTIAL_SOURCE_ORDER}. When no source answers, the error
 * names every source and why it failed, and one ledger row records the same names.
 *
 * This module sits below the ledger in the import graph: the ledger reaches the transport through
 * the config, and the transport imports this module. So the process entry point hands the ledger
 * writer in through {@link installGithubCredentialMissingSink}, as it does for the transport's actor.
 *
 * A credential value never leaves this module except in the environment of the `gh` child. No value
 * reaches a return field, a log line, a ledger row or an error message. This module writes no
 * credential anywhere. It does not mint or rotate one, and it does not run the GitHub App mint.
 *
 * With no references file, a process that has an ambient token or a stored gh login behaves exactly
 * as it did before this module existed.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { RmdError } from "./errors.js";
import { discoverLiveLedgerRoot } from "./live-write-guard.js";

/** The references file, in the state directory. It holds references only, never a credential value. */
export const GITHUB_CREDENTIAL_REFERENCES_FILENAME = "github-credential-references.json";

/** The ledger step written when no source answers. */
export const GITHUB_CREDENTIAL_MISSING_STEP = "github.credential_missing";

/** The scope of a reference that applies to every repository. */
export const GITHUB_CREDENTIAL_ALL_REPOS = "*";

/** The same failure is recorded at most once in this many milliseconds, per process. */
export const GITHUB_CREDENTIAL_MISSING_ROW_GAP_MS = 10 * 60_000;

/** Where a reference points: an environment variable, a file, or a GitHub App. */
export type GithubCredentialKind = "env" | "file" | "app";

/**
 * One reference: a scope, a kind and a name. `scope` is {@link GITHUB_CREDENTIAL_ALL_REPOS} or
 * `owner/repo`. `name` is the environment variable, the absolute file path, or the app's name.
 * A console can add a reference by writing this shape to the references file.
 */
export interface GithubCredentialReference {
  scope: string;
  kind: GithubCredentialKind;
  name: string;
}

export type GithubCredentialSource = "repo-reference" | "remudero-reference" | "ambient-env" | "gh-login";

/** The order the sources are tried in. The first source that answers supplies the credential. */
export const GITHUB_CREDENTIAL_SOURCE_ORDER: readonly GithubCredentialSource[] = [
  "repo-reference",
  "remudero-reference",
  "ambient-env",
  "gh-login",
];

/** A source that did not answer, and why. `reason` holds names and paths, never a value. */
export interface GithubCredentialAttempt {
  source: GithubCredentialSource;
  reason: string;
}

export interface GithubCredentialResolution {
  /** The source that answered. "none" means the call may run without a credential. */
  source: GithubCredentialSource | "none";
  /** The sources tried before the one that answered, in order. */
  tried: readonly GithubCredentialAttempt[];
  /** The environment for the `gh` child. It returns `base` itself when the source needs no change. */
  childEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined;
}

export interface GithubCredentialQuery {
  /** The environment the `gh` child would receive. Defaults to this process's own. */
  env?: NodeJS.ProcessEnv;
  /** The `owner/repo` the call is for, when it is known. */
  repo?: string;
  /** A short label for the call, for example "gh pr review". It appears in the error and the row. */
  operation?: string;
  /** The state directory. Defaults to the one named by the harness config under `env.HOME`. */
  stateDir?: string;
  /** Asked only when no source answers. True lets the call run with no credential and no row. */
  mayRunWithout?: () => boolean;
  clock?: Clock;
}

/** No source answered. The message and `tried` name every source and why it failed. */
export class GithubCredentialMissingError extends RmdError {
  readonly tried: readonly GithubCredentialAttempt[];
  constructor(operation: string, repo: string | undefined, tried: readonly GithubCredentialAttempt[]) {
    const lines = tried.map((attempt, index) => `  ${index + 1}. ${attempt.source}: ${attempt.reason}`);
    super(
      "github",
      1,
      `no GitHub credential for \`${operation}\`${repo === undefined ? "" : ` on ${repo}`} (W1-T11926). ` +
        `Sources tried, in order:\n${lines.join("\n")}\n` +
        `Any one source is enough: add a reference, set GH_TOKEN for this process, or store a login with the gh CLI on this host.`,
      { operation, ...(repo === undefined ? {} : { repo }), sources: tried.map((attempt) => ({ ...attempt })) },
    );
    this.name = "GithubCredentialMissingError";
    this.tried = tried;
  }
}

const REPO_SCOPE = /^[\w.-]+\/[\w.-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS: readonly string[] = ["env", "file", "app"];

/**
 * Parse the references file. It throws when the text is not the expected shape, and the message
 * names the entry by position only, so a value pasted into the file by mistake is never repeated.
 */
export function parseGithubCredentialReferences(text: string): GithubCredentialReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the references file is not JSON");
  }
  const list = (parsed as { references?: unknown } | null)?.references;
  if (!Array.isArray(list)) throw new Error("the references file has no `references` list");
  return list.map((entry: unknown, index) => {
    const { scope, kind, name } = (entry ?? {}) as Record<string, unknown>;
    const where = `references entry ${index + 1}`;
    if (typeof scope !== "string" || (scope !== GITHUB_CREDENTIAL_ALL_REPOS && !REPO_SCOPE.test(scope))) {
      throw new Error(`${where} needs a scope of "${GITHUB_CREDENTIAL_ALL_REPOS}" or owner/repo`);
    }
    if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error(`${where} needs a kind of env, file or app`);
    if (typeof name !== "string" || name.trim() === "") throw new Error(`${where} needs a name`);
    return { scope, kind: kind as GithubCredentialKind, name };
  });
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unreadable";
}

type Loaded = { references: GithubCredentialReference[] } | { failure: string };
type Answer = { token: string } | { reason: string };

function loadReferences(path: string | undefined, stateDirFailure: string): Loaded {
  if (path === undefined) return { failure: stateDirFailure };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = errorCode(err);
    return { failure: code === "ENOENT" ? `no references file at ${path}` : `the references file ${path} is unreadable (${code})` };
  }
  try {
    return { references: parseGithubCredentialReferences(text) };
  } catch (err) {
    return { failure: `${path} is not usable: ${(err as Error).message}` };
  }
}

/** Read what one reference points at. An unreadable or empty target is a failure, never an answer. */
function followReference(reference: GithubCredentialReference, env: NodeJS.ProcessEnv): Answer {
  if (reference.kind === "env") {
    // A name that is not a variable name is not repeated: it may be a value pasted by mistake.
    if (!ENV_NAME.test(reference.name)) return { reason: "an env reference has a name that is not an environment variable name" };
    const value = env[reference.name]?.trim();
    return value ? { token: value } : { reason: `environment variable ${reference.name} is not set` };
  }
  if (reference.kind === "file") {
    if (!isAbsolute(reference.name)) return { reason: "a file reference has a name that is not an absolute path" };
    try {
      const value = readFileSync(reference.name, "utf8").trim();
      return value ? { token: value } : { reason: `file ${reference.name} is empty` };
    } catch (err) {
      return { reason: `file ${reference.name} is unreadable (${errorCode(err)})` };
    }
  }
  // Minting a GitHub App token is outside this resolver (W1-T11926 scope), so an app reference fails.
  return { reason: `app reference ${reference.name} cannot answer: this resolver does not mint GitHub App tokens` };
}

function answerFromReferences(loaded: Loaded, scope: string | undefined, env: NodeJS.ProcessEnv): Answer {
  if ("failure" in loaded) return { reason: loaded.failure };
  if (scope === undefined) return { reason: "this call names no repository" };
  const matching = loaded.references.filter((reference) => reference.scope.toLowerCase() === scope.toLowerCase());
  if (matching.length === 0) return { reason: `no reference has the scope ${scope}` };
  const reasons: string[] = [];
  for (const reference of matching) {
    const answer = followReference(reference, env);
    if ("token" in answer) return answer;
    reasons.push(answer.reason);
  }
  return { reason: reasons.join("; ") };
}

/** Where gh keeps a stored login, resolved as gh resolves it. Only the file's size is read. */
function ghLoginAnswer(env: NodeJS.ProcessEnv): { ok: true } | { reason: string } {
  const dir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "gh") : join(env.HOME || homedir(), ".config", "gh"));
  const hosts = join(dir, "hosts.yml");
  try {
    if (statSync(hosts).size > 0) return { ok: true };
  } catch {
    // A missing file and an unreadable one both mean there is no stored login to use.
  }
  return { reason: `gh has no stored login at ${hosts}` };
}

/** The {@link GITHUB_CREDENTIAL_MISSING_STEP} row. It carries names and paths only. */
export interface GithubCredentialMissingRow {
  run_id: string;
  task_id: string;
  step: typeof GITHUB_CREDENTIAL_MISSING_STEP;
  operation: string;
  repo?: string;
  sources: GithubCredentialAttempt[];
  [k: string]: unknown;
}

let missingSink: ((row: GithubCredentialMissingRow) => void) | undefined;

/**
 * Install the writer for the {@link GITHUB_CREDENTIAL_MISSING_STEP} row. The process entry point
 * passes a function that appends the row to the ledger. `undefined` removes the writer.
 */
export function installGithubCredentialMissingSink(sink: ((row: GithubCredentialMissingRow) => void) | undefined): void {
  missingSink = sink;
}

/** Failure signature to the time its row was last written, so a polling loop cannot flood the ledger. */
const missingRowWrittenAtMs = new Map<string, number>();

function recordMissing(operation: string, repo: string | undefined, tried: readonly GithubCredentialAttempt[], clock: Clock): void {
  if (missingSink === undefined) return;
  const signature = JSON.stringify([operation, repo, tried]);
  const last = missingRowWrittenAtMs.get(signature);
  const now = clock.now();
  if (last !== undefined && now - last < GITHUB_CREDENTIAL_MISSING_ROW_GAP_MS) return;
  missingRowWrittenAtMs.set(signature, now);
  try {
    missingSink({
      run_id: "github-credential",
      task_id: "GITHUB-CREDENTIAL",
      step: GITHUB_CREDENTIAL_MISSING_STEP,
      operation,
      ...(repo === undefined ? {} : { repo }),
      sources: tried.map((attempt) => ({ ...attempt })),
    });
  } catch {
    // The caller still gets the named error. A ledger that cannot be written must not replace it.
  }
}

/**
 * Pick the credential for one `gh` call (W1-T11926). It tries a per-repo reference, then a
 * remudero-wide reference, then the ambient GH_TOKEN or GITHUB_TOKEN, then gh's own stored login.
 * It returns the name of the source that answered. It throws {@link GithubCredentialMissingError}
 * and hands one {@link GITHUB_CREDENTIAL_MISSING_STEP} row to the installed writer when none answers.
 */
export function resolveGithubCredential(query: GithubCredentialQuery = {}): GithubCredentialResolution {
  const env = query.env ?? process.env;
  const keep = (base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined => base;
  // The value is held by this closure only. It is not a field, so no logger or row can read it.
  const withToken = (token: string) => (base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({ ...(base ?? process.env), GH_TOKEN: token });

  let stateDir = query.stateDir;
  let stateDirFailure = "";
  if (stateDir === undefined) {
    try {
      stateDir = join(discoverLiveLedgerRoot(env), "state");
    } catch (err) {
      stateDirFailure = `the state directory could not be found (${errorCode(err)})`;
    }
  }
  const loaded = loadReferences(stateDir === undefined ? undefined : join(stateDir, GITHUB_CREDENTIAL_REFERENCES_FILENAME), stateDirFailure);
  const tried: GithubCredentialAttempt[] = [];

  const perRepo = answerFromReferences(loaded, query.repo, env);
  if ("token" in perRepo) return { source: "repo-reference", tried, childEnv: withToken(perRepo.token) };
  tried.push({ source: "repo-reference", reason: perRepo.reason });

  const wide = answerFromReferences(loaded, GITHUB_CREDENTIAL_ALL_REPOS, env);
  if ("token" in wide) return { source: "remudero-reference", tried, childEnv: withToken(wide.token) };
  tried.push({ source: "remudero-reference", reason: wide.reason });

  if (env.GH_TOKEN || env.GITHUB_TOKEN) return { source: "ambient-env", tried, childEnv: keep };
  tried.push({ source: "ambient-env", reason: "GH_TOKEN and GITHUB_TOKEN are not set in this process" });

  const login = ghLoginAnswer(env);
  if ("ok" in login) return { source: "gh-login", tried, childEnv: keep };
  tried.push({ source: "gh-login", reason: login.reason });

  if (query.mayRunWithout?.() === true) return { source: "none", tried, childEnv: keep };
  const operation = query.operation ?? "gh";
  recordMissing(operation, query.repo, tried, query.clock ?? systemClock);
  throw new GithubCredentialMissingError(operation, query.repo, tried);
}

/** The `owner/repo` a gh call names in its arguments, or `undefined` when it names none. */
export function githubRepoOfGhArgv(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const named = arg === "--repo" || arg === "-R" ? args[i + 1] : arg.startsWith("--repo=") ? arg.slice("--repo=".length) : undefined;
    if (named !== undefined && REPO_SCOPE.test(named)) return named;
  }
  if (args[0] !== "api") return undefined;
  for (const arg of args.slice(1)) {
    const match = /^\/?repos\/([\w.-]+\/[\w.-]+)(?:[/?]|$)/.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}

/** True for a gh call that inspects or sets up gh itself, such as `gh auth status`. It needs no credential. */
export function ghArgvNeedsNoCredential(args: readonly string[]): boolean {
  return ["auth", "version", "--version", "help", "--help", "completion", "config"].includes(args[0] ?? "");
}
