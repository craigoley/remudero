/**
 * test/plan/the-public-catalog-takes-no-new-task-record.test.ts — W1-T14343.
 *
 * A new task record belongs in the plan destination, yet the public catalog took 542 new records in 7 days because the
 * switch saying so is host state. `lint-plan`'s changed-task pass now refuses a record whose id no commit of the base's
 * history ever held, while plan/policy.yaml's committed `catalog.newTasks` row is closed and the linted checkout's
 * origin is the repository that row names.
 *
 * Each case builds a real git repository carrying the REAL plan/policy.yaml and drives lint-plan by spawning
 * scripts/lint-plan-offline.mjs (never importing src/run-task.ts), with HOME pointed at a fixture home so no host
 * config or host switch can reach the answer.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { catalogNewTasksRow, newPublicTaskRecords, readCatalogNewTasksRow } from "#src/cli/commands/lint-plan.js";
import { newPublicTaskRecordViolations } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CATALOG_ORIGIN = "https://github.com/craigoley/remudero.git";
const POLICY = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
const CLOSED_ROW = "    value: closed\n    repository: craigoley/remudero\n";
const OPEN_POLICY = POLICY.replace(CLOSED_ROW, "    value: open\n    repository: craigoley/remudero\n");

// Every fixture record names one suite the fixture really holds, so it lints clean apart from what a case changes.
const FIXTURE_SUITE = "test/w1-t14343-fixture.test.ts";
const FIXTURE_TITLE = "the fixture record is proven";

const record = (id: string, title: string): string =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: human",
    "  risk: low",
    "  status: queued",
    `  origin: "W1-T14343 test fixture"`,
    `  design: "NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve"`,
    "  acceptance:",
    `    - claim: "something is proven"`,
    `      proof: "unit test: ${FIXTURE_TITLE}"`,
    "  files:",
    `    - ${FIXTURE_SUITE}`,
    "",
  ].join("\n");

const shard = (id: string): string => join("plan", "tasks.d", `${id}-fixture-record.yaml`);

function write(fixture: GitRepo, rel: string, text: string): void {
  writeFileSync(join(fixture.dir, rel), text, "utf8");
}

function commitAll(fixture: GitRepo, message: string): string {
  fixture.git("add", "-A", "plan");
  fixture.git("commit", "-q", "-m", message);
  return fixture.git("rev-parse", "HEAD");
}

/** A public-catalog checkout: the real policy, one existing record, origin the catalog repository. */
function catalogFixture(): { fixture: GitRepo; base: string } {
  const fixture = gitRepo({ kind: "w1-t14343" });
  mkdirSync(join(fixture.dir, "plan", "tasks.d"), { recursive: true });
  write(fixture, join("plan", "tasks.yaml"), "[]\n");
  write(fixture, join("plan", "policy.yaml"), POLICY);
  write(fixture, shard("ZZ-T1"), record("ZZ-T1", "an existing record"));
  mkdirSync(join(fixture.dir, "test"));
  write(fixture, FIXTURE_SUITE, `import { test } from "node:test";\ntest("${FIXTURE_TITLE}", () => {});\n`);
  fixture.git("add", FIXTURE_SUITE);
  fixture.git("remote", "add", "origin", CATALOG_ORIGIN);
  return { fixture, base: commitAll(fixture, "base") };
}

function fixtureHome(destination?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14343-home-`));
  if (destination !== undefined) {
    const root = join(home, "instance");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root }));
    writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify(destination));
  }
  return home;
}

interface Lint { code: number | null; lines: string[]; text: string }

function lint(fixture: { dir: string }, base: string, home = fixtureHome()): Lint {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.RMD_CI_DEPENDENCY_EVIDENCE;
  const run = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "lint-plan-offline.mjs"),
    "--repo-root", fixture.dir, "--base", base], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 240_000 });
  rmSync(home, { recursive: true, force: true });
  const text = `${run.stdout}${run.stderr}`;
  assert.ok(/rmd lint-plan: \d+ task\(s\) checked/.test(text), `lint-plan printed no summary:\n${text}`);
  return { code: run.status, lines: text.split("\n"), text };
}

/** The verdict lines only: every violation, warning and the summary, in order. */
const verdict = (run: Lint): string[] => run.lines.filter((l) => /^(✗ |\s{4}\[|\s+⚠ |rmd lint-plan: )/.test(l));
const refusals = (run: Lint): string[] => run.lines.filter((l) => l.includes("[new-public-task-record]"));

test("W1-T14343 criterion 1: a new id the catalog never held is refused, naming the verbs that file it in the plan destination", () => {
  const { fixture, base } = catalogFixture();
  write(fixture, shard("ZZ-T2"), record("ZZ-T2", "a brand new record"));
  commitAll(fixture, "file a new record in the public catalog");

  const run = lint(fixture, base);
  assert.equal(run.code, 1, run.text);
  const header = run.lines.find((l) => l.startsWith("✗ ZZ-T2:"));
  assert.ok(header, run.text);
  // The gate's violation is the record's ONLY one: without it this pull request lints clean, as it does on origin/main.
  assert.match(header!, /^✗ ZZ-T2: 1 violation\(s\)/);
  const [refusal] = refusals(run);
  assert.ok(refusal, run.text);
  assert.match(refusal!, /ZZ-T2 is a new task record/);
  assert.ok(refusal!.includes("`rmd plan-destination task`"), refusal);
  assert.ok(refusal!.includes("`rmd next-task-id --branch"), refusal);
  assert.doesNotMatch(refusal!, /remudero-ops|ops repo|private/i, "the message never names the plan destination's repository");
});

test("W1-T14343 criterion 1: the violation is pure and silent without the caller's set", () => {
  const task = { id: "ZZ-T2" } as never;
  assert.deepEqual(newPublicTaskRecordViolations(task), []);
  assert.deepEqual(newPublicTaskRecordViolations(task, { newPublicTaskRecordIds: new Set(["ZZ-T9"]) }), []);
  const [v] = newPublicTaskRecordViolations(task, { newPublicTaskRecordIds: new Set(["ZZ-T2"]) });
  assert.equal(v?.check, "new-public-task-record");
  assert.equal(v?.severity, "block");
});

test("W1-T14343 criterion 2: a mover RESTORE, a rollback re-add, an edit and a move REMOVE lint as on origin/main", () => {
  const { fixture } = catalogFixture();
  // History holds ZZ-T3 as a shard and ZZ-T4 in the monolith; the mover removed both before the base.
  write(fixture, shard("ZZ-T3"), record("ZZ-T3", "a record the mover moved"));
  write(fixture, join("plan", "tasks.yaml"), record("ZZ-T4", "a monolith record later moved"));
  commitAll(fixture, "file ZZ-T3 and ZZ-T4");
  rmSync(join(fixture.dir, shard("ZZ-T3")));
  write(fixture, join("plan", "tasks.yaml"), "[]\n");
  const base = commitAll(fixture, "chore(plan): move ZZ-T3 to the ops catalog");

  const cases: Array<[string, () => void]> = [
    ["restore", () => write(fixture, shard("ZZ-T3"), record("ZZ-T3", "a record the mover moved"))],
    ["rollback re-add", () => write(fixture, shard("ZZ-T4"), record("ZZ-T4", "a monolith record later moved"))],
    ["edit", () => write(fixture, shard("ZZ-T1"), record("ZZ-T1", "an existing record, edited"))],
    ["remove", () => rmSync(join(fixture.dir, shard("ZZ-T1")))],
  ];
  for (const [name, change] of cases) {
    fixture.git("checkout", "-q", "-B", `case-${name.replace(/ /g, "-")}`, base);
    change();
    commitAll(fixture, `chore(plan): ${name}`);
    const closed = lint(fixture, base);
    write(fixture, join("plan", "policy.yaml"), OPEN_POLICY);
    const open = lint(fixture, base);
    fixture.git("checkout", "-q", "--", "plan/policy.yaml");
    assert.deepEqual(refusals(closed), [], `${name}: ${closed.text}`);
    assert.equal(closed.code, 0, `${name}: ${closed.text}`);
    assert.deepEqual(verdict(closed), verdict(open), `${name} lints exactly as with the check off`);
  }
});

test("W1-T14343 criterion 3: the answer is the committed row, never host state, and an open row never fires", () => {
  const { fixture, base } = catalogFixture();
  write(fixture, shard("ZZ-T2"), record("ZZ-T2", "a brand new record"));
  commitAll(fixture, "file a new record");

  // The host switch says nothing about the answer: a host file naming no task destination, one naming one, or none.
  for (const host of [undefined, { repository: "fixture/destination", kinds: [] }, { repository: "fixture/destination", kinds: ["task"] }]) {
    assert.equal(refusals(lint(fixture, base, fixtureHome(host))).length, 1, `closed row, host ${JSON.stringify(host)}`);
  }
  write(fixture, join("plan", "policy.yaml"), OPEN_POLICY);
  for (const host of [undefined, { repository: "fixture/destination", kinds: ["task"] }]) {
    const open = lint(fixture, base, fixtureHome(host));
    assert.deepEqual(refusals(open), [], open.text);
    assert.equal(open.code, 0, open.text);
  }
  // A checkout of another repository copying the same closed policy (a fixture) is not the catalog.
  fixture.git("checkout", "-q", "--", "plan/policy.yaml");
  fixture.git("remote", "set-url", "origin", "https://github.com/someone/fixture-copy.git");
  const elsewhere = lint(fixture, base);
  assert.deepEqual(refusals(elsewhere), [], elsewhere.text);
  assert.equal(elsewhere.code, 0, elsewhere.text);
});

test("W1-T14343 criterion 3: the row is committed data, and a malformed row fails loud instead of reading as open", () => {
  assert.deepEqual(readCatalogNewTasksRow(join(REPO_ROOT, "plan", "policy.yaml")), { state: "closed", repository: "craigoley/remudero" });
  assert.match(POLICY, /^catalog:\n {2}newTasks:\n {4}value: closed\n {4}repository: craigoley\/remudero\n {4}origin: "net-new: W1-T14343/m);
  assert.deepEqual(catalogNewTasksRow(undefined), { state: "open" });
  assert.deepEqual(catalogNewTasksRow("proofTimeoutMs: {}\n"), { state: "open" });
  assert.deepEqual(catalogNewTasksRow("catalog:\n  newTasks: { value: open, origin: x }\n"), { state: "open" });
  for (const bad of [
    "catalog: []\n",
    "catalog:\n  newTasks: { value: closed, repository: o/r }\n",
    "catalog:\n  newTasks: { value: shut, repository: o/r, origin: x }\n",
    "catalog:\n  newTasks: { value: closed, origin: x }\n",
  ]) assert.throws(() => catalogNewTasksRow(bad), /catalog\.newTasks/, bad);
  assert.throws(() => readCatalogNewTasksRow(REPO_ROOT), /EISDIR/);
  assert.deepEqual(readCatalogNewTasksRow(join(REPO_ROOT, "plan", "no-such-policy.yaml")), { state: "open" });

  const { fixture, base } = catalogFixture();
  write(fixture, join("plan", "policy.yaml"), POLICY.replace(CLOSED_ROW, "    value: shut\n    repository: craigoley/remudero\n"));
  write(fixture, shard("ZZ-T2"), record("ZZ-T2", "a brand new record"));
  commitAll(fixture, "a malformed row");
  const run = lint(fixture, base);
  assert.equal(run.code, 1, run.text);
  assert.ok(run.lines.some((l) => l.startsWith("✗ plan/policy.yaml:") && l.includes("catalog.newTasks")), run.text);
  assert.ok(run.lines.some((l) => l.includes("[new-public-task-record] not checked")), run.text);
});

test("W1-T14343 criterion 3: history that cannot be read completely fires nothing and says why", () => {
  const { fixture, base } = catalogFixture();
  write(fixture, shard("ZZ-T2"), record("ZZ-T2", "a brand new record"));
  commitAll(fixture, "file a new record");
  // A depth-2 clone holds the base and the head but not the history before them.
  const shallow = { dir: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14343-shallow-`)), "clone") };
  for (const args of [["clone", "-q", "--depth", "2", `file://${fixture.dir}`, shallow.dir], ["-C", shallow.dir, "remote", "set-url", "origin", CATALOG_ORIGIN]]) {
    const git = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  assert.equal(spawnSync("git", ["-C", shallow.dir, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).stdout.trim(), "true");
  const run = lint(shallow, base);
  assert.deepEqual(refusals(run).filter((l) => !l.includes("not checked")), [], run.text);
  assert.ok(run.lines.some((l) => /\[new-public-task-record\] not checked: this clone is shallow/.test(l)), run.text);

  const input = { checkoutRoot: fixture.dir, planRel: "plan/tasks.yaml", policyFile: join(fixture.dir, "plan", "policy.yaml"), base, addedIds: new Set(["ZZ-T2"]) };
  assert.deepEqual(newPublicTaskRecords({ ...input, addedIds: new Set() }), { state: "off", reason: "no_added_ids" });
  assert.deepEqual(newPublicTaskRecords(input, () => { throw new Error("fatal: bad object\nmore"); }),
    { state: "unknown", reason: "the base's history does not read (fatal: bad object)" });
  assert.deepEqual(newPublicTaskRecords(input, undefined, () => { throw new Error("no origin"); }),
    { state: "off", reason: "not_the_catalog_repository" });
  assert.deepEqual(newPublicTaskRecords({ ...input, policyFile: fixture.dir }).state, "unknown");
  const checked = newPublicTaskRecords({ ...input, addedIds: new Set(["ZZ-T2", "ZZ-T1", "not an id"]) });
  assert.deepEqual(checked.state === "checked" ? [...checked.newIds] : checked, ["ZZ-T2"]);
});

test("W1-T14343 criterion 4: invariant:existing-records-lint-as-today — a pull request adding no new id lints exactly as with the check off", () => {
  const { fixture, base } = catalogFixture();
  // An edit that carries a pre-existing violation, so the comparison covers violations, severities and the exit code.
  write(fixture, shard("ZZ-T1"), record("ZZ-T1", "an existing record, edited").replace(`proof: "unit test: ${FIXTURE_TITLE}"`, 'proof: "works"'));
  commitAll(fixture, "edit an existing record");
  const closed = lint(fixture, base);
  write(fixture, join("plan", "policy.yaml"), OPEN_POLICY);
  const open = lint(fixture, base);
  assert.equal(closed.code, 1, closed.text);
  assert.ok(verdict(closed).some((l) => l.startsWith("✗ ZZ-T1:")), closed.text);
  assert.deepEqual(refusals(closed), []);
  assert.equal(closed.code, open.code);
  assert.deepEqual(verdict(closed), verdict(open));
});
