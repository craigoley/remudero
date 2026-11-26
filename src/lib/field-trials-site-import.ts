/**
 * lib/field-trials-site-import.ts — W1-T10832: THE DAILY FIELD NOTE REACHES THE SITE AS ONE OWNER-REVIEWED PR.
 *
 * After a good refresh with the owner's consent file, the `rmd field-trials` pass hands the W1-T10831
 * candidate to {@link syncFieldNoteSiteImport}. It checks out site main fresh and lets the SITE decide:
 * its own `scripts/import-model-field-note.mjs --daily-stage` (PORTAL-T41) validates, refuses overlap
 * and chains the history. Core acts only on that exit code:
 *   0 staged    → the data files the stage changed become ONE ready PR on a non-fleet branch, opened
 *                 with createPlanPrRest or, when probeExistingPlanPr finds it open, updated in place;
 *   3 unchanged → no PR, nothing written;
 *   1 refused   → the site's reason is recorded, no PR, no workaround.
 * Before any write, the App installation must PROVE it can push and open a PR on the site: a token
 * scoped to remudero-site alone must carry Contents and Pull requests write (plannerPrWriteToken).
 * Without it the outcome names the exact grant and nothing is written.
 * Core passes the exporter's unstamped note to the site's stage mode. The site owns publication and
 * review fields; the owner's merge is the review. Nothing here arms, enqueues, approves or merges;
 * the branch is outside every fleet shape, carries no Remudero-Task trailer, and the sweep's arm
 * effect refuses any `field-trials/` head (isOwnerMergeOnlyHead in sweep.ts) even with armSessionPrs.
 * Falsifier: test/routing/a-field-note-candidate-opens-one-reviewed-site-pr.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreflightFastDeps } from "./ci-parity.js";
import { hostWorktreeGitAsync, hostWorktreeGitEnv } from "./worktree-git.js";
import { ghJson } from "./github-transport.js";
import { GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV, mintScopedToken } from "./github-app.js";
import { plannerPrWriteToken } from "./secret-boundary.js";
import type { GhApiFetcher } from "./open-prs-rest.js";
import { createPlanPrRest, probeExistingPlanPr } from "./plan-pr-emitter.js";
import type { ModelFieldNoteBody } from "./field-trials-field-note.js";

export const SITE_IMPORT_OWNER = "craigoley";
export const SITE_IMPORT_REPO = "remudero-site";
/** Outside run-*, plan-file-* and every task-id slug, and under the `field-trials/` prefix the sweep never arms. */
export const SITE_IMPORT_BRANCH = "field-trials/daily-field-note";
export const SITE_IMPORT_BASE = "main";
/** The exact permission the operator adds when the App cannot write the site. */
export const SITE_IMPORT_GRANT = "GitHub App installation on craigoley/remudero-site with Contents: write and Pull requests: write";
export const SITE_STAGE_SCRIPT = "scripts/import-model-field-note.mjs";
export const SITE_STAGE_EXIT = { staged: 0, refused: 1, unchanged: 3 } as const;

/** What the W1-T10831 exporter returns when the pass asks it for a candidate after the released windows. */
export type FieldNoteExport =
  | { state: "candidate"; note: ModelFieldNoteBody }
  | { state: "withheld" | "refused"; reason: string };

export interface SiteRelease { releaseId: string; windowStart: string; windowEnd: string; sourceRepos: string[] }

export type SiteImportOutcome =
  | { state: "withheld"; reason: string }
  | { state: "refused"; by: "exporter" | "site"; reason: string; releaseId?: string }
  | { state: "site-checkout-failed"; reason: string }
  | { state: "site-stage-mode-unavailable"; releaseId: string }
  | { state: "unchanged"; releaseId: string; verifiedOutcome?: VerifiedOutcomeWrite }
  | { state: "stage-failed"; releaseId: string; reason: string }
  | { state: "staged"; releaseId: string; pr: "opened" | "updated"; prUrl: string; prNumber: number; files: string[];
      verifiedOutcome?: VerifiedOutcomeWrite }
  | { state: "site-grant-missing"; releaseId: string; reason: string; missing: string[]; grant: string }
  | { state: "publish-failed"; releaseId: string; reason: string; grant: string };

export interface SiteImportRun { status: number | null; stdout: string; stderr: string }

export interface SiteImportInput {
  /** Private scratch parent; the pass's own directory under it is removed afterwards. */
  workRoot: string;
  nowIso: string;
  /** Runs the exporter with the site's released windows, so a replacement starts at the last RELEASED end. */
  exportCandidate: (released: readonly SiteRelease[]) => FieldNoteExport;
  /** W1-T14985: the cohort index and the owner's consent receipts the site's verified-outcome derivation reads. */
  verifiedOutcome?: SiteVerifiedOutcomeSource;
}

/** W1-T14985: the site's own derivation of data/model-verified-outcome.json (PORTAL-T65). */
export const SITE_VERIFIED_OUTCOME_SCRIPT = "scripts/derive-model-verified-outcome.mjs";
export const SITE_VERIFIED_OUTCOME_FILE = "data/model-verified-outcome.json";

export interface SiteVerifiedOutcomeSource {
  /** state/benchmark-cohort-index.json. */
  cohortIndexPath: string;
  /** Every consented repository's receipt in state/field-trials/field-trials-consent-v1.json. */
  receipts: readonly string[];
}

/** Whether this pass wrote the verified outcome, or the reason it wrote none. */
export type VerifiedOutcomeWrite = { state: "written"; consentAt: string } | { state: "not-written"; reason: string };

/**
 * W1-T14985: the consent instant the site's derivation records, from the owner's receipts (`owner-YYYY-MM-DD-<who>`),
 * which carry a date and no time. The instant is the END of that UTC day, and never later than now (the site refuses a
 * consent instant after its own clock): never earlier than the real consent, so no figure reads as consented before it
 * was. Receipts that name different dates, or none, give a reason and no instant.
 */
export function consentAtFromReceipts(receipts: readonly string[], nowIso: string): { at: string } | { reason: string } {
  if (receipts.length === 0) return { reason: "no-consent-receipt" };
  const dates = new Set<string>();
  for (const receipt of receipts) {
    const day = /^owner-(\d{4}-\d{2}-\d{2})-/.exec(receipt)?.[1];
    const end = day === undefined ? Number.NaN : Date.parse(`${day}T23:59:59.999Z`);
    if (day === undefined || !Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== day) {
      return { reason: `consent-receipt-has-no-date: ${receipt}` };
    }
    dates.add(day);
  }
  if (dates.size !== 1) return { reason: `consent-receipts-disagree: ${[...dates].sort().join(", ")}` };
  const end = Date.parse(`${[...dates][0]}T23:59:59.999Z`);
  return { at: new Date(Math.min(end, Date.parse(nowIso))).toISOString() };
}

/** Run the site's own derivation in the site checkout, so core and site can never disagree on the figures. */
function deriveVerifiedOutcome(spawn: NonNullable<PreflightFastDeps["spawn"]>, siteDir: string,
  source: SiteVerifiedOutcomeSource, nowIso: string): VerifiedOutcomeWrite {
  const consent = consentAtFromReceipts(source.receipts, nowIso);
  if ("reason" in consent) return { state: "not-written", reason: consent.reason };
  try { readFileSync(join(siteDir, SITE_VERIFIED_OUTCOME_SCRIPT), "utf8"); }
  catch (error) {
    return { state: "not-written", reason: `site-derive-script-unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
  }
  const run = spawn(process.execPath, [SITE_VERIFIED_OUTCOME_SCRIPT, source.cohortIndexPath, consent.at, SITE_VERIFIED_OUTCOME_FILE],
    { cwd: siteDir });
  if (run.status !== 0) {
    // Node prints the throw site and a caret before the error itself; the reason is the error's own message.
    const lines = run.stderr.trim().split("\n");
    const said = lines.find((line) => /^(Uncaught )?\w*Error: /.test(line))?.replace(/^(Uncaught )?\w*Error: /, "")
      ?? lines.find((line) => /\S/.test(line)) ?? "";
    return { state: "not-written", reason: `site-derive-exit-${run.status}: ${said}` };
  }
  return { state: "written", consentAt: consent.at };
}

function verifiedOutcomeLine(write: VerifiedOutcomeWrite): string {
  return write.state === "written"
    ? `- Verified outcome: ${SITE_VERIFIED_OUTCOME_FILE} derived by ${SITE_VERIFIED_OUTCOME_SCRIPT} (consent at ${write.consentAt}).\n`
    : `- Verified outcome: not written (${write.reason}).\n`;
}

const defaultStageSpawn: NonNullable<PreflightFastDeps["spawn"]> = (file, args, opts) => {
  const result = spawnSync(file, args, { cwd: opts?.cwd, env: opts?.env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.error ? String(result.error) : result.stderr ?? "" };
};

/** W1-T14779: a token for reading the private site, or why none could be minted. */
export type SiteCloneToken = (ownerRepo: string) => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;

/** The production seam: the daemon's App identity (GH_APP_*), minted for remudero-site only. */
export function appCloneToken(env: NodeJS.ProcessEnv = process.env, mint: typeof mintScopedToken = mintScopedToken): SiteCloneToken {
  return async (ownerRepo) => {
    const minted = await mint(ownerRepo, 10 * 60_000, { env }).catch((error: unknown) => ({ ok: false, reason: String(error), token: undefined }));
    return minted.ok && minted.token ? { ok: true, token: minted.token } : { ok: false, reason: minted.reason ?? "no token returned" };
  };
}

/** Clone into fresh scratch: no repository exists to pin yet, so the leaf's config hardening is applied by hand.
 *  A token reaches git only as a child-env extraheader, never argv or `.git/config` (W1-T14779). */
function siteClone(spawn: NonNullable<PreflightFastDeps["spawn"]>, cwd: string, url: string, target: string, token?: string) {
  const { GIT_DIR: _gitDir, GIT_WORK_TREE: _workTree, ...env } = hostWorktreeGitEnv({
    worktree: cwd, gitDir: join(cwd, ".git"), source: "git-directory" });
  if (token !== undefined) {
    const index = Number(env.GIT_CONFIG_COUNT ?? 0);
    env[`GIT_CONFIG_KEY_${index}`] = "http.https://github.com/.extraheader";
    env[`GIT_CONFIG_VALUE_${index}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    env.GIT_CONFIG_COUNT = String(index + 1);
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return spawn("git", ["clone", "--quiet", "--single-branch", "--branch", SITE_IMPORT_BASE, url, target], { cwd, env });
}

/** The App installation's write capability on the site, proven by a token scoped to it alone. */
export type SiteWriteProof = (ownerRepo: string) => Promise<{ ok: true } | { ok: false; reason: string; missing: string[] }>;

/** The production proof: the daemon's SERVICE App identity (GH_APP_*), minted for remudero-site only. */
export function appWriteProof(env: NodeJS.ProcessEnv = process.env, mint: typeof mintScopedToken = mintScopedToken): SiteWriteProof {
  return async (ownerRepo) => {
    const proof = await plannerPrWriteToken({ appId: env[GH_APP_ID_ENV] ?? "", installationId: env[GH_APP_INSTALLATION_ID_ENV] ?? "",
      keyPath: env[GH_APP_PRIVATE_KEY_PATH_ENV] ?? "" }, ownerRepo, { mint });
    return proof.ok ? { ok: true } : { ok: false, reason: proof.reason, missing: proof.missing };
  };
}

async function runGit(args: string[], cwd: string): Promise<SiteImportRun> {
  try {
    return { status: 0, stdout: await hostWorktreeGitAsync(cwd, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }), stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return { status: failed.status ?? null, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? error) };
  }
}

function readReleases(siteDir: string): SiteRelease[] | string {
  try {
    const history = JSON.parse(readFileSync(join(siteDir, "data", "model-field-note-history.json"), "utf8")) as { releases?: unknown };
    if (!Array.isArray(history.releases)) return "site-history-malformed";
    return history.releases as SiteRelease[];
  } catch (error) {
    return `site-history-unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`;
  }
}

/** The changed paths of the staged checkout; anything outside data/ or any deletion is a refusal. */
async function stagedFiles(siteDir: string): Promise<string[] | string> {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], siteDir);
  if (status.status !== 0) return `git-status-failed: ${status.stderr.trim()}`;
  const files: string[] = [];
  for (const line of status.stdout.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2), path = line.slice(3);
    if (!(code === " M" || code === "??") || !/^data\/[A-Za-z0-9._-]+\.json$/.test(path)) return `stage-wrote-outside-data: ${line}`;
    files.push(path);
  }
  return files.length > 0 ? files.sort() : "stage-reported-staged-but-changed-nothing";
}

/** Write the staged files onto ONE branch over REST and keep ONE ready PR open for it. */
async function publish(fetch: GhApiFetcher, siteDir: string, workDir: string,
  releaseId: string, files: string[], summary: string): Promise<Extract<SiteImportOutcome, { state: "staged" }>> {
  const head = await runGit(["rev-parse", "HEAD", "HEAD^{tree}"], siteDir);
  const [baseSha, baseTree] = head.stdout.trim().split("\n");
  if (head.status !== 0 || !baseSha || !baseTree) throw new Error(`git-rev-parse-failed: ${head.stderr.trim()}`);
  const repo = `repos/${SITE_IMPORT_OWNER}/${SITE_IMPORT_REPO}`;
  const post = (path: string, body: unknown): Record<string, unknown> => {
    const input = join(workDir, `request-${path.replaceAll("/", "-")}.json`);
    writeFileSync(input, JSON.stringify(body), { mode: 0o600 });
    return fetch(["api", "--method", "POST", `${repo}/${path}`, "--input", input]) as Record<string, unknown>;
  };
  const tree = post("git/trees", { base_tree: baseTree, tree: files.map((path) => ({ path, mode: "100644", type: "blob",
    content: readFileSync(join(siteDir, path), "utf8") })) });
  if (typeof tree?.sha !== "string") throw new Error("git-tree-write-returned-no-sha");
  const title = `feat(field-trials): stage daily field note ${releaseId}`;
  const commit = post("git/commits", { message: `${title}\n\nStaged by the core field-trials collector; the owner's merge is the review.`,
    tree: tree.sha, parents: [baseSha] });
  if (typeof commit?.sha !== "string") throw new Error("git-commit-write-returned-no-sha");
  try {
    fetch(["api", "--method", "PATCH", `${repo}/git/refs/heads/${SITE_IMPORT_BRANCH}`, "-f", `sha=${commit.sha}`, "-F", "force=true"]);
  } catch (error) {
    // The branch does not exist yet (or was deleted after a merge): create it from the same commit.
    const reason = `ref-update-failed: ${String(error)}`;
    try { fetch(["api", "--method", "POST", `${repo}/git/refs`, "-f", `ref=refs/heads/${SITE_IMPORT_BRANCH}`, "-f", `sha=${commit.sha}`]); }
    catch (createError) { throw new Error(`${reason}; ref-create-failed: ${String(createError)}`); }
  }
  const open = probeExistingPlanPr(fetch, SITE_IMPORT_OWNER, SITE_IMPORT_REPO, SITE_IMPORT_BRANCH);
  if (open !== undefined) {
    fetch(["api", "--method", "PATCH", `${repo}/pulls/${open.prNumber}`, "-f", `title=${title}`, "-f", `body=${summary}`]);
    return { state: "staged", releaseId, pr: "updated", prUrl: open.prUrl, prNumber: open.prNumber, files };
  }
  const created = createPlanPrRest(fetch, SITE_IMPORT_OWNER, SITE_IMPORT_REPO,
    { title, body: summary, head: SITE_IMPORT_BRANCH, base: SITE_IMPORT_BASE });
  return { state: "staged", releaseId, pr: "opened", prUrl: created.prUrl, prNumber: created.prNumber, files };
}

/** W1-T14984: who staged a field note, as the site's stage mode requires it (remudero-site lib/model-field-note.ts). */
export const FIELD_NOTE_STAGED_BY = "field-trials-collector";

/**
 * W1-T14984: the exporter's note with the collector stamps the site's `--daily-stage` parser demands. The site accepts
 * only its exact collector-staged key set (`stagedBy: "field-trials-collector"`, `stagedAt`, `publishedAt`, ordered
 * asOf <= stagedAt <= publishedAt <= now) and stamps nothing itself, so a bare note was refused on every pass
 * ("invalid schema, rights, coverage or disclosure cell"). Both stamps are this pass's own time; no review field is
 * ever written, because the owner's merge of the site PR is the review.
 */
export function collectorStagedNote<T extends { asOf: string }>(note: T, nowIso: string):
  T & { stagedBy: typeof FIELD_NOTE_STAGED_BY; stagedAt: string; publishedAt: string } {
  const at = new Date(Date.parse(nowIso)).toISOString();
  return { ...note, stagedBy: FIELD_NOTE_STAGED_BY, stagedAt: at, publishedAt: at };
}

/**
 * One pass of the daily site import: fresh site main, the exporter after its released windows, the site's
 * own stage mode, and — only on `staged` — one open import PR. Every outcome is a value, never a throw.
 */
export async function syncFieldNoteSiteImport(input: SiteImportInput,
  deps: Pick<PreflightFastDeps, "spawn"> & { fetch?: GhApiFetcher; siteUrl?: string; writeProof?: SiteWriteProof; cloneToken?: SiteCloneToken } = {}): Promise<SiteImportOutcome> {
  const spawn = deps.spawn ?? defaultStageSpawn;
  mkdirSync(input.workRoot, { recursive: true, mode: 0o700 });
  const workDir = mkdtempSync(join(input.workRoot, "site-import-"));
  try {
    const siteDir = join(workDir, "site");
    const url = deps.siteUrl ?? `https://github.com/${SITE_IMPORT_OWNER}/${SITE_IMPORT_REPO}.git`;
    // A local fixture URL needs no credential; the private site on github.com does.
    const tokenSource = deps.cloneToken ?? (deps.siteUrl === undefined ? appCloneToken() : undefined);
    const minted = tokenSource === undefined ? undefined : await tokenSource(`${SITE_IMPORT_OWNER}/${SITE_IMPORT_REPO}`);
    if (minted !== undefined && !minted.ok) return { state: "site-checkout-failed", reason: `site-clone-token-unavailable: ${minted.reason}` };
    const clone = siteClone(spawn, workDir, url, siteDir, minted?.token);
    const cloneError = minted?.token === undefined ? clone.stderr.trim() : clone.stderr.trim().split(minted.token).join("<token>");
    if (clone.status !== 0) return { state: "site-checkout-failed", reason: `git-clone-exit-${clone.status}: ${cloneError}` };
    const released = readReleases(siteDir);
    if (typeof released === "string") return { state: "site-checkout-failed", reason: released };
    const exported = input.exportCandidate(released);
    if (exported.state !== "candidate") {
      return exported.state === "withheld" ? { state: "withheld", reason: exported.reason }
        : { state: "refused", by: "exporter", reason: exported.reason };
    }
    const releaseId = exported.note.releaseId;
    let script: string;
    try { script = readFileSync(join(siteDir, SITE_STAGE_SCRIPT), "utf8"); }
    catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? String(error);
      return reason === "ENOENT" ? { state: "site-stage-mode-unavailable", releaseId }
        : { state: "stage-failed", releaseId, reason: `stage-script-unreadable: ${reason}` };
    }
    if (!script.includes("--daily-stage")) return { state: "site-stage-mode-unavailable", releaseId };
    // The site stage mode owns every publication and review stamp.
    const candidatePath = join(workDir, "candidate.json"), summaryPath = join(workDir, "summary.md");
    writeFileSync(candidatePath, JSON.stringify(collectorStagedNote(exported.note, input.nowIso)), { mode: 0o600 });
    const stage = spawn(process.execPath, ["--experimental-strip-types", SITE_STAGE_SCRIPT, "--daily-stage", candidatePath, summaryPath], { cwd: siteDir });
    const line = stage.stdout.trim().split("\n").at(-1) ?? "";
    let reported: { outcome?: string; reason?: string } = {};
    try { reported = JSON.parse(line) as typeof reported; }
    catch (error) {
      const reason = `stage-output-not-json: ${String(error)}`;
      if (stage.status === SITE_STAGE_EXIT.staged) return { state: "stage-failed", releaseId, reason };
    }
    const unchanged = stage.status === SITE_STAGE_EXIT.unchanged;
    if (stage.status === SITE_STAGE_EXIT.refused) {
      return { state: "refused", by: "site", releaseId, reason: reported.reason ?? `stage-refused: ${stage.stderr.trim()}` };
    }
    if (!unchanged && (stage.status !== SITE_STAGE_EXIT.staged || reported.outcome !== "staged")) {
      return { state: "stage-failed", releaseId, reason: `stage-exit-${stage.status}: ${stage.stderr.trim() || line}` };
    }
    if (!unchanged) {
      const noted = await stagedFiles(siteDir);
      if (typeof noted === "string") return { state: "stage-failed", releaseId, reason: noted };
    }
    // W1-T14985: the verified outcome rides in the same reviewed PR, derived by the site's own script.
    const verifiedOutcome = input.verifiedOutcome === undefined ? undefined
      : deriveVerifiedOutcome(spawn, siteDir, input.verifiedOutcome, input.nowIso);
    const outcomeFields = verifiedOutcome === undefined ? {} : { verifiedOutcome };
    if (unchanged && verifiedOutcome?.state !== "written") return { state: "unchanged", releaseId, ...outcomeFields };
    const files = await stagedFiles(siteDir);
    if (unchanged && files === "stage-reported-staged-but-changed-nothing") return { state: "unchanged", releaseId, ...outcomeFields };
    if (typeof files === "string") return { state: "stage-failed", releaseId, reason: files };
    const staged = unchanged ? `## Daily verified outcome: ${releaseId}\n\n- The field note is unchanged.\n`
      + "- Review: the owner merge of this PR is the review.\n" : readFileSync(summaryPath, "utf8");
    const summary = verifiedOutcome === undefined ? staged : `${staged.replace(/\n*$/, "\n")}${verifiedOutcomeLine(verifiedOutcome)}`;
    const proof = await (deps.writeProof ?? appWriteProof())(`${SITE_IMPORT_OWNER}/${SITE_IMPORT_REPO}`);
    if (!proof.ok) return { state: "site-grant-missing", releaseId, reason: proof.reason, missing: proof.missing, grant: SITE_IMPORT_GRANT };
    try { return { ...await publish(deps.fetch ?? ghJson, siteDir, workDir, releaseId, files, summary), ...outcomeFields }; }
    catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      return { state: "publish-failed", releaseId, reason, grant: SITE_IMPORT_GRANT };
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
