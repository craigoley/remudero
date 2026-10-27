#!/usr/bin/env node
/**
 * DOES THIS PUSH FALSIFY ITS OPEN PR'S OWN BODY PROOF? Ask before the push lands, not after the review (W1-T9235).
 *
 * OBSERVED 2026-10-13: a follow-up push to #11328's shards broke that PR's own stored `## Acceptance` grep proof, and it
 * surfaced as remudero-review FAIL about 20 minutes later. `proof-resolve-precheck.mjs` judges PLAN criteria and SKIPs a
 * plan-only filing, so nothing re-ran the STORED BODY's proofs. The body is fixed between pushes, so a push that removes
 * or rewords the text a body proof greps for is knowable offline in about a second.
 *
 * ONE PREDICATE, NEVER TWO. The block is the reviewer's own `parseAcceptanceBlock`; each tree is judged by its own
 * `certainHeadRefusals` (title resolution for a `unit test:` proof, the reviewer's executor for a `grep:`), which spawns no
 * test runner. A proof the reviewer would degrade rather than refuse is never judged here.
 *
 * ONLY A BRANCH THAT CAN HAVE A PR: a push whose remote old sha is all zeros (a new branch) or whose local sha is all zeros
 * (a deletion) reads nothing. The stored body is read AT MOST ONCE per push, only when the shared gh read floor is clear
 * (stamping it as any read does), and never waited for; otherwise the body cached under the git common dir is used; with
 * neither, one named line and exit 0. There is no timer, count or page cap.
 *
 * SEVERITY FOLLOWS THE BODY'S FRESHNESS. A proof that PASSED at the remote's old tip and is refused at the pushed sha is
 * NEWLY FALSIFIED: on a FRESH body the push is refused (exit 1); on a CACHED body it is reported and the push goes on,
 * since the body may have been edited elsewhere. A proof already failing at the old tip is reported only.
 *
 * Exit 0 clean, reported-only or skipped; 1 a newly falsified proof on a fresh body; 2 could not read (the hook never
 * blocks on 2).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { certainHeadRefusals, extractTaskTrailerId, parseAcceptanceBlock, parseWhitelistedProof, resolvePlanCriteriaAtHead } from "../src/lib/review.js";
import { DEFAULT_GH_READ_CADENCE_S, ghReadCadenceDecision, ghReadCadenceStampPath, readGhReadCadenceStampMs, stampGhRead } from "../src/lib/github-transport.js";
import { isMainModule } from "./lib/argv.mjs";
import { git, gitOrThrow } from "./lib/git.mjs";

const ZERO_SHA = /^0+$/;
const PLAN = "plan/tasks.yaml";
const UNCHECKED = "open-PR body proofs UNCHECKED: read floor busy and no cached body";

/**
 * Which body to judge, and the reads that cost. PURE over its injected seams so a test counts the reads.
 * `floorClear()` says the shared read floor permits a read now; `readFresh()` is that one read and returns the open PR's
 * body (`null` for no open PR) or throws; `readCache()` returns the cached body or `undefined`; `writeCache(body)` records
 * a fresh one.
 */
export function selectBodySource({ oldSha, newSha, floorClear, readFresh, readCache, writeCache = () => {} }) {
  if (!oldSha || ZERO_SHA.test(oldSha)) return { kind: "skip", lines: ["open-pr-body-proof-precheck: SKIP -- a first push of a new branch cannot have an open PR"] };
  if (!newSha || ZERO_SHA.test(newSha)) return { kind: "skip", lines: ["open-pr-body-proof-precheck: SKIP -- a deletion carries no content"] };
  const notes = [];
  if (floorClear()) {
    try {
      const body = readFresh();
      if (body === null) return { kind: "skip", lines: ["open-pr-body-proof-precheck: SKIP -- this branch has no open pull request"] };
      writeCache(body);
      return { kind: "fresh", body, lines: [] };
    } catch (e) {
      notes.push(`open-pr-body-proof-precheck: the open-PR read failed (${e.message}) -- trying the cached body`);
    }
  }
  const cached = readCache();
  if (typeof cached === "string") return { kind: "cached", body: cached, lines: notes };
  return { kind: "unchecked", lines: [...notes, `open-pr-body-proof-precheck: ${UNCHECKED}`] };
}

/**
 * The verdict. `refusalsAt(sha)` returns the body proofs the reviewer is certain to refuse at that tree, or `undefined`
 * when the tree is not readable here (an old tip this clone lacks): then nothing can be called NEWLY falsified.
 * `trailerCriteria(taskId)` returns the plan criteria the body's `Remudero-Task:` trailer resolves at head, which belong
 * to the existing precheck and the reviewer's shard read, never to this one.
 */
export function openPrBodyVerdict({ source, oldSha, newSha, refusalsAt, trailerCriteria = () => [] }) {
  if (source.kind !== "fresh" && source.kind !== "cached") return { exit: 0, lines: source.lines };
  const body = source.body;
  const taskId = extractTaskTrailerId(body);
  if (taskId !== undefined && trailerCriteria(taskId).length > 0) {
    return { exit: 0, lines: [...source.lines, `open-pr-body-proof-precheck: SKIP -- the body's Remudero-Task: ${taskId} resolves criteria at head; proof-resolve-precheck judges those`] };
  }
  const criteria = parseAcceptanceBlock(body);
  if (criteria.length === 0) return { exit: 0, lines: [...source.lines, "open-pr-body-proof-precheck: SKIP -- the open PR's body carries no ## Acceptance proofs"] };
  const now = refusalsAt(newSha);
  if (now === undefined) return { exit: 0, lines: [...source.lines, "open-pr-body-proof-precheck: SKIP -- the pushed tree could not be read here, NOT passed"] };
  if (now.length === 0) {
    return { exit: 0, lines: [...source.lines, `open-pr-body-proof-precheck: OK -- ${criteria.length} body proofs (${source.kind} body), none the reviewer is certain to refuse at the pushed sha`] };
  }
  const before = refusalsAt(oldSha);
  const failedBefore = new Set((before ?? []).map((r) => r.proof));
  const fresh = [];
  const already = [];
  for (const r of now) (before !== undefined && !failedBefore.has(r.proof) ? fresh : already).push(r);
  const lines = [...source.lines];
  const show = (r, was) => `  - ${r.proof}\n      old tip ${String(oldSha).slice(0, 12)}: ${was}\n      pushed ${String(newSha).slice(0, 12)}: FAILS -- ${r.why}\n      claim: ${r.claim}`;
  if (already.length > 0) {
    lines.push(
      `open-pr-body-proof-precheck: ${already.length} body proof(s) ${before === undefined ? "could not be compared (old tip not in this clone)" : "already failing at the old tip"} (reported only):`,
      ...already.map((r) => show(r, before === undefined ? "not judged" : "FAILS")),
    );
  }
  if (fresh.length === 0) return { exit: 0, lines };
  const refuse = source.kind === "fresh";
  lines.push(
    `open-pr-body-proof-precheck: this push NEWLY FALSIFIES ${fresh.length} proof(s) in the open PR's own body (${source.kind} body):`,
    ...fresh.map((r) => show(r, "passes")),
  );
  lines.push(
    refuse
      ? "  TO FIX: change the commit so the proof passes again, or edit the PR body's ## Acceptance first and push again."
      : "  The body was read from this clone's cache, not GitHub, so this is REPORTED and the push goes on: confirm the stored body still carries this proof.",
  );
  return { exit: refuse ? 1 : 0, lines };
}

/** The pull request body for `<owner>:<branch>` via one REST read, stamped on the shared floor. `null`: no open PR. */
function readOpenPrBody(remoteUrl, branch, stampPath) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl ?? "");
  if (!m) throw new Error(`origin is not a github.com remote (${remoteUrl})`);
  const [, owner, repo] = m;
  stampGhRead(stampPath);
  const r = spawnSync("gh", ["api", `repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`gh api exit ${r.status}: ${(r.stderr ?? "").trim().split("\n")[0]}`);
  const pulls = JSON.parse(r.stdout);
  if (!Array.isArray(pulls) || pulls.length === 0) return null;
  return String(pulls[0].body ?? "");
}

function cacheFile(branch) {
  const common = resolve(gitOrThrow(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return join(common, "rmd-open-pr-body", `${encodeURIComponent(branch)}.json`);
}

/** Extract only what the proofs read from `sha` into a temp dir, so the reviewer's own functions run over a real tree. */
function extractProofTree(repoRoot, sha, criteria) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-open-pr-body-"));
  const paths = new Set(["package.json"]);
  for (const c of criteria) {
    const w = parseWhitelistedProof((c.proof ?? "").trim());
    if (!w) continue;
    if (w.kind === "grep" && typeof w.args[3] === "string" && !w.args[3].startsWith("/") && !w.args[3].includes("..")) paths.add(w.args[3]);
    else if (w.kind === "test") paths.add("test");
  }
  for (const p of paths) {
    const a = git(["archive", "--format=tar", sha, "--", p], { cwd: repoRoot, encoding: "buffer" });
    if (a.status !== 0 || !a.stdout?.length) continue; // an absent path is a failing proof, judged as such
    spawnSync("tar", ["-x", "-C", dir], { input: a.stdout });
  }
  return dir;
}

/** The proofs the reviewer is certain to refuse at `sha`'s tree, or `undefined` when this clone lacks that commit. */
export function refusalsAtSha(repoRoot, sha, criteria) {
  if (git(["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot }).status !== 0) return undefined;
  const dir = extractProofTree(repoRoot, sha, criteria);
  try {
    return certainHeadRefusals(criteria, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const headRef = flag("--head-ref");
  const oldSha = flag("--old-sha");
  const newSha = flag("--new-sha");
  const remoteUrl = flag("--remote-url");
  let verdict;
  try {
    const repoRoot = gitOrThrow(["rev-parse", "--show-toplevel"]);
    const stampPath = ghReadCadenceStampPath();
    const cacheAt = headRef ? cacheFile(headRef) : undefined;
    const source = selectBodySource({
      oldSha,
      newSha,
      floorClear: () => {
        const windowS = /^[0-9]+$/.test(process.env.RMD_GH_COOLDOWN_S ?? "") ? Number(process.env.RMD_GH_COOLDOWN_S) : DEFAULT_GH_READ_CADENCE_S;
        return ghReadCadenceDecision({ isWrite: false, isExempt: false, nowMs: Date.now(), lastReadMs: readGhReadCadenceStampMs(stampPath), mode: "enforce", windowS }).allow;
      },
      readFresh: () => readOpenPrBody(remoteUrl ?? gitOrThrow(["remote", "get-url", "origin"]), headRef, stampPath),
      readCache: () => {
        try {
          return cacheAt === undefined ? undefined : JSON.parse(readFileSync(cacheAt, "utf8")).body;
        } catch {
          return undefined; // an absent or unreadable cache is "no cached body", named by the caller
        }
      },
      writeCache: (body) => {
        if (cacheAt === undefined) return;
        mkdirSync(join(cacheAt, ".."), { recursive: true });
        writeFileSync(cacheAt, JSON.stringify({ body, readAt: new Date().toISOString() }));
      },
    });
    const refusalsAt = (sha) => refusalsAtSha(repoRoot, sha, parseAcceptanceBlock(source.body ?? ""));
    verdict = openPrBodyVerdict({
      source,
      oldSha,
      newSha,
      refusalsAt,
      trailerCriteria: (taskId) => resolvePlanCriteriaAtHead(`Remudero-Task: ${taskId}`, repoRoot, PLAN, newSha).criteria,
    });
  } catch (e) {
    console.error(`open-pr-body-proof-precheck: could not read this push (${e.message}) -- NOT reporting clean`);
    return 2;
  }
  for (const line of verdict.lines) (verdict.exit === 0 && verdict.lines.length === 1 ? console.log : console.error)(line);
  return verdict.exit;
}

if (isMainModule(import.meta.url)) process.exit(main());
