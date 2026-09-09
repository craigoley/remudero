import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { RepoLayoutError, resolveRepoLayout } from "../src/lib/repo-layout.js";
import { loadPlanForLayout } from "../src/lib/plan.js";
import { loadLearningsCorpus, projectLearningsHome } from "../src/lib/learnings.js";
import { loadAlertPolicyForRepo } from "../src/lib/alert-lane.js";

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

/**
 * Frozen at THIS diff's own post-change count (measured against this same head): centralizing the
 * house defaults in repo-location.ts is the one deliberate new site this diff itself adds (it now
 * carries `"MASTER-PLAN.md"`, `"plan"` + `"tasks.yaml"`, `".remudero"` + `"principles.yaml"` and
 * `"learnings"` as the ONE place a foreign target overrides). Every OTHER non-test src file's count
 * is unchanged by this diff. A future file assuming the house shape inline, instead of resolving
 * it through {@link resolveRepoLayout}, pushes a count past its own literal here and this test
 * reddens — the ratchet the task record calls for.
 */
//
// RE-FROZEN ONCE, AND ONLY WHERE MAIN MOVED. `plan/tasks.d` went 23 -> 24 while this branch was
// open, and the growth is not this diff's: MEASURED on origin/main ALONE the count is already 24,
// and on the merged branch it is also 24 — this PR adds no site. The ceiling is re-frozen at the
// inherited number rather than the branch being blamed for it, which is the same distinction
// comment-load-ratchet draws in as many words ("already carried N at the merge base — inherited,
// not this diff's growth"). The ratchet keeps its direction: a 25th site still reddens.
const HOUSE_LITERAL_CEILING: Record<(typeof HOUSE_LITERALS)[number], number> = {
  "plan/tasks.d": 24,
  "MASTER-PLAN.md": 19,
  ".remudero/": 18,
  "learnings/": 16,
};

test("W1-T2922 ratchet: non-test src's house-layout literal count cannot grow past this diff's own count", () => {
  const files = listSrcFiles(REPO_ROOT);
  const counts: Record<string, number> = {};
  for (const literal of HOUSE_LITERALS) counts[literal] = 0;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const literal of HOUSE_LITERALS) {
      if (content.includes(literal)) counts[literal] += 1;
    }
  }
  for (const literal of HOUSE_LITERALS) {
    assert.ok(
      counts[literal] <= HOUSE_LITERAL_CEILING[literal],
      `'${literal}' now appears in ${counts[literal]} non-test src files, exceeding the frozen ` +
        `ceiling of ${HOUSE_LITERAL_CEILING[literal]} — a new file assumed the house layout ` +
        `inline instead of resolving it through resolveRepoLayout (src/lib/repo-layout.ts)`,
    );
  }
});
