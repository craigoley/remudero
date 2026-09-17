import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { RepoLayoutError, resolveRepoLayout } from "../src/lib/repo-layout.js";
import { loadPlanForLayout } from "../src/lib/plan.js";
import { loadLearningsCorpus, projectLearningsHome } from "../src/lib/learnings.js";
import { loadAlertPolicyForRepo } from "../src/lib/alert-lane.js";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 (same reason
// test/comment-load-ratchet.test.ts loads it this way). W1-T3701 reuses this REAL module's split
// between a ceiling and a measured count rather than restating it (see the ratchet below).
const { evaluateCommentLoadRatchet } = (await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "comment-load-ratchet.mjs")).href
)) as {
  evaluateCommentLoadRatchet: (
    current: Record<string, number>,
    baseline: Record<string, number>,
  ) => {
    ok: boolean;
    violations: Array<{ path: string; comments: number; baseline: number; overage: number }>;
    shrunk: Array<{ path: string; from: number; to: number }>;
    added: Array<{ path: string; comments: number }>;
    removed: string[];
    nextBaseline: Record<string, number>;
  };
};

/**
 * test/repo-layout.test.ts — W1-T2922's own falsifier.
 *
 * The audit: the harness's OWN directory shape (`plan/tasks.d`, `MASTER-PLAN.md`, `.remudero/`,
 * `learnings/`) was assumed by 20+ non-test src files, so a target repo missing any of those
 * throws in the first loader that assumes one. `resolveRepoLayout` (repo-layout.ts) is the ONE
 * place that shape now lives, house-defaulted for THIS repo and overridable per-target via a
 * `.remudero/layout.json` file; `projectLearningsHome` (learnings.ts), `loadPlanForLayout`
 * (plan.ts) and `loadAlertPolicyForRepo` (alert-lane.ts) all read through it instead of an inline
 * literal.
 *
 * THE FALSIFIER (from the task's own rationale): a fixture repo with no `plan/tasks.d/` and no
 * `learnings/` directory prints a plan and zero learnings without throwing.
 *
 * @source-text-subject: the LAST test below is a literal census over every non-test `src/*.ts`
 * file's own text — the house-literal ratchet the task record itself names ("the test is the
 * first ratchet: it counts … literals in non-test src and refuses growth from the post-change
 * count"). Its subject genuinely IS the source text, not a snapshot standing in for behaviour, so
 * it declares itself here (test/source-text-assertion-census.test.ts's own exemption) rather than
 * pass through that census silently.
 *
 * W1-T3701: the ratchet's CEILING used to be a hand-frozen literal per house-layout string, which
 * sits at zero headroom the day it is measured and refuses the NEXT file to mention any of them
 * regardless of whether THIS diff is the one that added it. The ceiling below is now the MERGE
 * BASE's own count, read fresh each run via `git ls-tree`/`git show` — never a stored number — and
 * compared through `evaluateCommentLoadRatchet` (scripts/comment-load-ratchet.mjs), the same split
 * between a diff's OWN growth and what it merely inherited that gate already implements. See
 * test/a-house-layout-site-is-judged-against-the-merge-base.test.ts for the tiered response (a
 * site a file can resolve through `resolveRepoLayout` right now is refused; one that cannot yet is
 * recorded as a conversion task and admits the diff) and the caller-vs-inliner adoption ratio.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-repo-layout-"));
}

/** A minimal-but-valid plan monolith: an empty task list. */
const EMPTY_PLAN_YAML = "[]\n";

test("resolveRepoLayout on THIS repo's own root reproduces today's house literals exactly", () => {
  const layout = resolveRepoLayout(REPO_ROOT);
  assert.equal(layout.root, REPO_ROOT);
  assert.equal(layout.planDir, join(REPO_ROOT, "plan"));
  assert.equal(layout.planMonolith, join(REPO_ROOT, "plan", "tasks.yaml"));
  assert.equal(layout.masterPlan, join(REPO_ROOT, "MASTER-PLAN.md"));
  assert.equal(layout.learningsDir, join(REPO_ROOT, "learnings"));
  assert.equal(layout.principlesFile, join(REPO_ROOT, ".remudero", "principles.yaml"));
  assert.equal(layout.alertPolicy, join(REPO_ROOT, "plan", "alert-policy.yaml"));
  assert.equal(layout.stateDir, join(REPO_ROOT, ".remudero"));
});

test("THE FALSIFIER: a target with no plan/tasks.d/ and no learnings/ loads through the layout without throwing", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), EMPTY_PLAN_YAML);
  // Deliberately no `plan/tasks.d/` and no `learnings/` directory anywhere under root.

  const layout = resolveRepoLayout(root);

  const plan = loadPlanForLayout(layout);
  assert.deepEqual(plan.tasks, []);

  const entries = loadLearningsCorpus(layout.learningsDir);
  assert.deepEqual(entries, []);

  // projectLearningsHome resolves through the SAME layout — never a bare house literal.
  assert.equal(projectLearningsHome(root), layout.learningsDir);
});

test("loadAlertPolicyForRepo reads the policy through the resolved layout", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(
    join(root, "plan", "alert-policy.yaml"),
    [
      "act_severities: [medium, low]",
      "critical_paths:",
      "  review: ['src/lib/review.ts']",
      "  gate: ['x']",
      "  containment: ['y']",
      "  ledger: ['z']",
      "  status: ['w']",
    ].join("\n"),
  );
  const policy = loadAlertPolicyForRepo(root);
  assert.deepEqual(policy.actSeverities, ["medium", "low"]);
});

test("resolveRepoLayout: a .remudero/layout.json override wins over the house default, field-by-field", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(
    join(root, ".remudero", "layout.json"),
    JSON.stringify({ learningsDir: "knowledge", planDir: "roadmap" }),
  );
  const layout = resolveRepoLayout(root);
  assert.equal(layout.learningsDir, join(root, "knowledge"));
  assert.equal(layout.planDir, join(root, "roadmap"));
  // Untouched fields keep the house default.
  assert.equal(layout.masterPlan, join(root, "MASTER-PLAN.md"));
  assert.equal(layout.alertPolicy, join(root, "plan", "alert-policy.yaml"));
  // stateDir is never overridable — the override itself must live somewhere fixed to be found.
  assert.equal(layout.stateDir, join(root, ".remudero"));
});

test("resolveRepoLayout: loadPlanForLayout finds shards under a RELOCATED planDir override", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "roadmap", "tasks.d"), { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, "roadmap", "tasks.yaml"), EMPTY_PLAN_YAML);
  writeFileSync(
    join(root, "roadmap", "tasks.d", "W9-T1-example.yaml"),
    ["- id: W9-T1", "  title: example", "  repo: fixture", "  type: implement"].join("\n"),
  );
  writeFileSync(
    join(root, ".remudero", "layout.json"),
    JSON.stringify({ planDir: "roadmap", planMonolith: "roadmap/tasks.yaml" }),
  );
  const layout = resolveRepoLayout(root);
  const plan = loadPlanForLayout(layout);
  assert.deepEqual(plan.tasks.map((t) => t.id), ["W9-T1"]);
});

test("resolveRepoLayout: a malformed .remudero/layout.json fails loud, never silently trusted", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero", "layout.json"), "{ not json");
  assert.throws(() => resolveRepoLayout(root), RepoLayoutError);
});

test("resolveRepoLayout: a layout.json that is valid JSON but NOT an object fails loud", () => {
  // The third refusal in parseLayoutOverrides, and the one the other two cannot reach: `[]` and
  // `"x"` both parse cleanly, so the JSON guard above passes them straight through to a key walk
  // that would find no keys and silently return the house defaults — a relocated repo would then
  // be read at the wrong paths with nothing said. Each shape is asserted, not just one: an array
  // is the case a `typeof === "object"` check alone lets through.
  for (const body of ["[]", '"a string"', "42", "null"]) {
    const root = fixtureRoot();
    mkdirSync(join(root, ".remudero"), { recursive: true });
    writeFileSync(join(root, ".remudero", "layout.json"), body);
    assert.throws(
      () => resolveRepoLayout(root),
      RepoLayoutError,
      `a layout.json of ${body} must be refused, not read as "no overrides"`,
    );
  }
});

test("resolveRepoLayout: an unknown layout.json key fails loud", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero", "layout.json"), JSON.stringify({ bogus: "x" }));
  assert.throws(() => resolveRepoLayout(root), RepoLayoutError);
});

test("resolveRepoLayout: a non-string override value fails loud", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero", "layout.json"), JSON.stringify({ learningsDir: 5 }));
  assert.throws(() => resolveRepoLayout(root), RepoLayoutError);
});

// ── The house-literal ratchet (see the @source-text-subject note above) ─────────────────────────

function listSrcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(root, "src"));
  return out;
}

const HOUSE_LITERALS = ["plan/tasks.d", "MASTER-PLAN.md", ".remudero/", "learnings/"] as const;

/** Per-literal file-presence counts over a fixed set of already-read file contents (never re-reads
 *  anything — the caller decides whether that content came from the working tree or a git ref). */
function houseLiteralCounts(contents: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const literal of HOUSE_LITERALS) counts[literal] = 0;
  for (const content of contents) {
    for (const literal of HOUSE_LITERALS) if (content.includes(literal)) counts[literal] += 1;
  }
  return counts;
}

/** The merge base's own commit, resolved fresh every run — never a stored number (design note i).
 *  Mirrors scripts/comment-load-ratchet.mjs's `readBaseDiff`: a non-hex result means git could not
 *  name a commit for `baseRef`, which must fail loud rather than silently comparing against "". */
function resolveMergeBase(root: string, baseRef = "origin/main"): string {
  const base = execFileSync("git", ["-C", root, "merge-base", baseRef, "HEAD"], { encoding: "utf8" }).trim();
  assert.match(base, /^[0-9a-f]{40}$/i, `git did not return a commit identity for ${baseRef}`);
  return base;
}

/** Every non-test `src/*.ts` path tracked at `ref` (repo-relative), the git-backed counterpart of
 *  {@link listSrcFiles} for a ref that is not the working tree. */
function listSrcFilesAtRef(root: string, ref: string): string[] {
  return execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", ref, "--", "src"], { encoding: "utf8" })
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.endsWith(".ts"));
}

/** `path`'s content at `ref`, or `undefined` when it did not exist there — a brand-new file is not
 *  an error, it simply contributes nothing to the base count. `maxBuffer` is raised past node's
 *  1 MiB default (matching scripts/lib/git.mjs's own 64 MiB) — src/run-task.ts alone is over
 *  2 MiB, and a silently truncated `git show` used to read back as ENOBUFS (`status: null`) and
 *  get counted here as "did not exist at the base", manufacturing a phantom new site on every
 *  literal in that one file every single run. */
function readFileAtRef(root: string, ref: string, relPath: string): string | undefined {
  const res = spawnSync("git", ["-C", root, "show", `${ref}:${relPath}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return res.status === 0 ? res.stdout : undefined;
}

test("W1-T3701 ratchet: non-test src's house-layout literal count is judged against the merge base's own count, never a frozen ceiling", () => {
  const currentCounts = houseLiteralCounts(listSrcFiles(REPO_ROOT).map((f) => readFileSync(f, "utf8")));

  const base = resolveMergeBase(REPO_ROOT);
  const baseContents = listSrcFilesAtRef(REPO_ROOT, base)
    .map((p) => readFileAtRef(REPO_ROOT, base, p))
    .filter((c): c is string => c !== undefined);
  const baseCounts = houseLiteralCounts(baseContents);

  // Reuses comment-load-ratchet's OWN caused-vs-ceiling split (design note i): a literal's count is
  // a violation only when THIS tree carries more sites than the merge base already did — a diff
  // that inherits an already-at-ceiling count, or adds nothing, is never blamed for what the
  // repository already was.
  const verdict = evaluateCommentLoadRatchet(currentCounts, baseCounts);
  assert.deepEqual(
    verdict.violations,
    [],
    verdict.violations
      .map(
        (v) =>
          `'${v.path}' now appears in ${v.comments} non-test src files, up from ${v.baseline} at the merge ` +
          `base (${base.slice(0, 12)}) — a new file assumed the house layout inline instead of resolving it ` +
          `through resolveRepoLayout (src/lib/repo-layout.ts); see ` +
          `test/a-house-layout-site-is-judged-against-the-merge-base.test.ts for the graded response`,
      )
      .join("\n"),
  );
});
