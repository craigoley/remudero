import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

// @source-text-subject: the worker's registration source is the input to the parity parser.
test("W1-T10798: a new CI census is refused until the worker registers it", async () => {
  const workerPath = join(REPO_ROOT, "scripts/census-precheck.mjs");
  const worker = await import(pathToFileURL(workerPath).href);
  const source = readFileSync(workerPath, "utf8");
  const added = "test/ci/gates/new-worker-census.test.ts";
  const changed = ["scripts/census-precheck.mjs"];
  const evaluate = (text: string): string[] => worker.censusParityViolations({
    changed,
    population: [added],
    readHead: (path: string) => path === "scripts/census-precheck.mjs" ? text : '{"ciOnly":[]}',
  });

  const refused = evaluate(source);
  assert.equal(refused.length, 1);
  assert.match(refused[0]!, /new-worker-census\.test\.ts.*model it in PRECHECK_PARITY/);

  const registered = source.replace("export const PRECHECK_PARITY = {",
    `export const PRECHECK_PARITY = {\n  "${added}": { modeled: () => [] },`);
  assert.notEqual(registered, source, "the fixture must modify the worker registration");
  assert.deepEqual(evaluate(registered), []);
  assert.throws(() => evaluate(source.replace("export const PRECHECK_EXTRA_CI_CENSUSES = {",
    "export const UNREADABLE_EXTRAS = {")), /worker PRECHECK_EXTRA_CI_CENSUSES declaration is not statically readable/);
});

// @source-text-subject: worker declarations are untrusted inputs to the managed hook's static reader.
test("W1-T10798: check:test:test/every-ci-census-is-asked-before-the-push.test.ts is prevented, not retried — managed hook population", async (t) => {
  const harness = ownedFixtureDir(t, "managed-census-harness").dir;
  const repo = gitRepo({ scope: t, kind: "managed-census-worker" });
  const workerPath = join(REPO_ROOT, "scripts/census-precheck.mjs");
  const worker = await import(pathToFileURL(workerPath).href);
  const source = readFileSync(workerPath, "utf8");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  mkdirSync(join(harness, "hooks"));
  mkdirSync(join(harness, "scripts"));
  copyFileSync(join(REPO_ROOT, "hooks/pre-push"), join(harness, "hooks/pre-push"));
  // Expose the real census entry point and its real defaults; unrelated hook gates are absent.
  writeFileSync(join(harness, "scripts/census-precheck.mjs"),
    `export { main, listAdmittedCensusMembers, runCensusSuitesViaChild } from ${JSON.stringify(pathToFileURL(workerPath).href)};\n`);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(harness, "node_modules"));
  const fillers = Array.from({ length: 20 }, (_, i) => `test/filler-${i}-census.test.ts`);
  for (const path of fillers) write(path, "");
  const baselinePath = "scripts/census-precheck-parity-baseline.json";
  write(baselinePath, JSON.stringify({ ciOnly: [...fillers,
    ...Object.keys(worker.PRECHECK_EXTRA_CI_CENSUSES).filter((path) => !Object.hasOwn(worker.PRECHECK_PARITY, path))] }));
  write("scripts/census-precheck.mjs", source);
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "-m", "seed census declarations");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const added = "test/worker-hidden.test.ts";
  write(added, "");
  repo.git("add", "--", added);
  assert.deepEqual(worker.listCiRuleSuites(repo.dir), fillers.sort(),
    "the real rule-suite selector must see its tracked corpus and exclude the extra");
  const extraSource = source.replace("export const PRECHECK_EXTRA_CI_CENSUSES = {",
    `export const PRECHECK_EXTRA_CI_CENSUSES = {\n  "${added}": "worker addition #10798",`);
  assert.notEqual(extraSource, source);
  const saveWorker = (text: string) => write("scripts/census-precheck.mjs",
    `${text}\nthrow new Error("worker module must never execute");\n`);
  const hook = () => {
    const result = spawnSync("sh", [join(harness, "hooks/pre-push")], {
      cwd: repo.dir, encoding: "utf8", input: "", timeout: 60_000,
      env: { ...process.env, RMD_PREPUSH_GATES: "1", RMD_CENSUS_SNAPSHOT: "" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /worker module must never execute/);
    return { ...result, output };
  };
  saveWorker(extraSource);
  const refused = hook();
  assert.equal(refused.status, 1, refused.output);
  assert.ok(refused.output.includes(`census-parity: ${added} is a CI census nothing asks before the push`), refused.output);
  assert.match(refused.output, /pre-push REFUSED/);

  saveWorker(extraSource.replace("export const PRECHECK_PARITY = {",
    `export const PRECHECK_PARITY = {\n  "${added}": { modeled: () => [] },`));
  const registered = hook();
  assert.equal(registered.status, 0, registered.output);
  assert.doesNotMatch(registered.output, /census-parity:/);

  saveWorker(extraSource.replace(`"${added}": "worker addition #10798"`,
    `["${added}"]: "worker addition #10798"`));
  assert.match(hook().output, /worker PRECHECK_EXTRA_CI_CENSUSES declaration is not statically readable/);
});

// @source-text-subject: the worker registration source is the input to the parity parser.
test("W1-T10798: check:test:test/every-ci-census-is-asked-before-the-push.test.ts is prevented, not retried — shrink-only baseline", async () => {
  const workerPath = join(REPO_ROOT, "scripts/census-precheck.mjs");
  const worker = await import(pathToFileURL(workerPath).href);
  const source = readFileSync(workerPath, "utf8");
  const baselinePath = "scripts/census-precheck-parity-baseline.json";
  const old = "test/ci/gates/carried-worker-census.test.ts";
  const added = "test/ci/gates/new-worker-census.test.ts";
  const evaluate = (rows: string[], baseRows: string[] | null = [old], text = source) =>
    worker.censusParityViolations({
      changed: [baselinePath, added],
      population: [old, added],
      readHead: (path: string) => path === baselinePath ? JSON.stringify({ ciOnly: rows }) : text,
      readBase: (path: string) => {
        assert.equal(path, baselinePath, "the guard must read the merge base's baseline");
        return baseRows === null ? null : JSON.stringify({ ciOnly: baseRows });
      },
    });

  assert.deepEqual(evaluate([old, added]), [
    `census-parity: ${added} is new in ${baselinePath} — model it in PRECHECK_PARITY; the baseline may only shrink`,
  ], "adding a census and its ciOnly row must refuse before push");
  assert.deepEqual(evaluate([old, added], [old, added]), [], "carried rows are allowed");
  assert.deepEqual(evaluate([old, added], null), [], "an absent base baseline has no growth to compare");
  const registered = source.replace("export const PRECHECK_PARITY = {",
    `export const PRECHECK_PARITY = {\n  "${added}": { modeled: () => [] },`);
  assert.notEqual(registered, source);
  assert.deepEqual(evaluate([old], [old, added], registered), [],
    "registering the census and shrinking the baseline is the remedy");
});
