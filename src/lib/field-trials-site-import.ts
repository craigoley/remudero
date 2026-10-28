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
 * The staged note carries only the collector stamps the site's parser requires (stagedBy, stagedAt and
 * the publishedAt it orders after stagedAt). Core never writes reviewedBy or reviewedAt: the owner's
 * merge is the review. Nothing here arms, enqueues, approves or merges; the branch is outside every
 * fleet shape and the PR carries no Remudero-Task trailer, so no sweep can credit or arm it.
 * Falsifier: test/routing/a-field-note-candidate-opens-one-reviewed-site-pr.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ghJson } from "./github-transport.js";
import type { GhApiFetcher } from "./open-prs-rest.js";
import { createPlanPrRest, probeExistingPlanPr } from "./plan-pr-emitter.js";
import type { ModelFieldNoteBody } from "./field-trials-field-note.js";

export const SITE_IMPORT_OWNER = "craigoley";
export const SITE_IMPORT_REPO = "remudero-site";
/** Outside run-*, plan-file-* and every task-id slug: no fleet sweep credits, reviews or arms it. */
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
  | { state: "unchanged"; releaseId: string }
  | { state: "stage-failed"; releaseId: string; reason: string }
  | { state: "staged"; releaseId: string; pr: "opened" | "updated"; prUrl: string; prNumber: number; files: string[] }
  | { state: "publish-failed"; releaseId: string; reason: string; grant: string };

export interface SiteImportRun { status: number | null; stdout: string; stderr: string }

export interface SiteImportDeps {
  fetch?: GhApiFetcher;
  /** Clone source for site main; a test passes a local repository. */
  siteUrl?: string;
  run?: (file: string, args: string[], cwd: string) => SiteImportRun;
}

export interface SiteImportInput {
  /** Private scratch parent; the pass's own directory under it is removed afterwards. */
  workRoot: string;
  nowIso: string;
  /** Runs the exporter with the site's released windows, so a replacement starts at the last RELEASED end. */
  exportCandidate: (released: readonly SiteRelease[]) => FieldNoteExport;
}

function defaultRun(file: string, args: string[], cwd: string): SiteImportRun {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.error ? String(result.error) : result.stderr ?? "" };
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
function stagedFiles(run: NonNullable<SiteImportDeps["run"]>, siteDir: string): string[] | string {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], siteDir);
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
function publish(fetch: GhApiFetcher, siteDir: string, run: NonNullable<SiteImportDeps["run"]>, workDir: string,
  releaseId: string, files: string[], summary: string): Extract<SiteImportOutcome, { state: "staged" }> {
  const head = run("git", ["rev-parse", "HEAD", "HEAD^{tree}"], siteDir);
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

/**
 * One pass of the daily site import: fresh site main, the exporter after its released windows, the site's
 * own stage mode, and — only on `staged` — one open import PR. Every outcome is a value, never a throw.
 */
export function syncFieldNoteSiteImport(input: SiteImportInput, deps: SiteImportDeps = {}): SiteImportOutcome {
  const run = deps.run ?? defaultRun;
  mkdirSync(input.workRoot, { recursive: true, mode: 0o700 });
  const workDir = mkdtempSync(join(input.workRoot, "site-import-"));
  try {
    const siteDir = join(workDir, "site");
    const url = deps.siteUrl ?? `https://github.com/${SITE_IMPORT_OWNER}/${SITE_IMPORT_REPO}.git`;
    const clone = run("git", ["clone", "--quiet", "--single-branch", "--branch", SITE_IMPORT_BASE, url, siteDir], workDir);
    if (clone.status !== 0) return { state: "site-checkout-failed", reason: `git-clone-exit-${clone.status}: ${clone.stderr.trim()}` };
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
    // The site's collector-staged shape: the note plus the staging stamps. No review field, ever.
    const stampedAt = new Date(Date.parse(input.nowIso)).toISOString();
    const candidatePath = join(workDir, "candidate.json"), summaryPath = join(workDir, "summary.md");
    writeFileSync(candidatePath, JSON.stringify({ ...exported.note, publishedAt: stampedAt,
      stagedBy: "field-trials-collector", stagedAt: stampedAt }), { mode: 0o600 });
    const stage = run(process.execPath, ["--experimental-strip-types", SITE_STAGE_SCRIPT, "--daily-stage", candidatePath, summaryPath], siteDir);
    const line = stage.stdout.trim().split("\n").at(-1) ?? "";
    let reported: { outcome?: string; reason?: string } = {};
    try { reported = JSON.parse(line) as typeof reported; }
    catch (error) {
      const reason = `stage-output-not-json: ${String(error)}`;
      if (stage.status === SITE_STAGE_EXIT.staged) return { state: "stage-failed", releaseId, reason };
    }
    if (stage.status === SITE_STAGE_EXIT.unchanged) return { state: "unchanged", releaseId };
    if (stage.status === SITE_STAGE_EXIT.refused) {
      return { state: "refused", by: "site", releaseId, reason: reported.reason ?? `stage-refused: ${stage.stderr.trim()}` };
    }
    if (stage.status !== SITE_STAGE_EXIT.staged || reported.outcome !== "staged") {
      return { state: "stage-failed", releaseId, reason: `stage-exit-${stage.status}: ${stage.stderr.trim() || line}` };
    }
    const files = stagedFiles(run, siteDir);
    if (typeof files === "string") return { state: "stage-failed", releaseId, reason: files };
    const summary = readFileSync(summaryPath, "utf8");
    try { return publish(deps.fetch ?? ghJson, siteDir, run, workDir, releaseId, files, summary); }
    catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      return { state: "publish-failed", releaseId, reason, grant: SITE_IMPORT_GRANT };
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
