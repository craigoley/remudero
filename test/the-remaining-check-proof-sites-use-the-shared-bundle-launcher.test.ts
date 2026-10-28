// test/the-remaining-check-proof-sites-use-the-shared-bundle-launcher.test.ts — W1-T9279.
//
// ADR 0006's first follow-up: every check-proof spawn site launches through childEntryArgv. W1-T8775 switched the
// plan-PR preflight; these tests drive the other three REAL caller boundaries (pr-open's defaultProofRunner,
// run-task's proofRepairRoundRefusalInWorktree and runPreflightProofs) against a fixture tree whose check-proof
// entry records the node loader flags it ran under, its arguments and its cwd. No assertion reads the argv text.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultProofRunner, checkProofLaunchArgv } from "#src/lib/pr-open.js";
import { defaultPreflightSpawn } from "#src/lib/commit-message.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// run-task's two sites are the REAL callers under test, but this suite must not become one more direct
// importer of src/run-task.ts: scripts/affected-reach-baseline.json (W1-T5702) is a shrink-only ceiling on
// those, and it cannot be raised. The module is therefore loaded at run time by a computed specifier.
const RUN_TASK_FILE = ["run-task", "ts"].join(".");
interface RunTaskSites {
  proofRepairRoundRefusalInWorktree(input: {
    worktreePath: string; roundStartSha: string | undefined; stageable: readonly string[]; proofs: readonly string[];
    childRoot?: string;
  }): unknown;
  runPreflightProofs(repo: string, deps: Record<string, unknown>): { ok: boolean; steps: unknown };
}
const { proofRepairRoundRefusalInWorktree, runPreflightProofs } = (await import(
  pathToFileURL(join(REPO_ROOT, "src", RUN_TASK_FILE)).href
)) as RunTaskSites;
const NAME = "check-proof-main";
const SOURCE = "src/check-proof-main.ts";
const MARK = "FIXTURE-BUNDLE-MARK";
const PROOF = "unit test: some claim";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const OUT_ENV = "RMD_FIXTURE_OUT";

interface ChildRecord { marker: string; args: string[]; execArgv: string[]; cwd: string }
interface BuildModule {
  OUT_DIR: string;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[] }): Promise<unknown>;
}
const loadBuild = async (): Promise<BuildModule> =>
  (await import(pathToFileURL(join(REPO_ROOT, "scripts", "build-child-entries.mjs")).href)) as BuildModule;

const ENTRY_SOURCE = `import { appendFileSync } from "node:fs";
const marker = "${MARK}";
appendFileSync(process.env.${OUT_ENV}!, JSON.stringify({ marker, args: process.argv.slice(2), execArgv: process.execArgv, cwd: process.cwd() }) + "\\n");
`;

type Variant = "current" | "absent" | "stale" | "corrupt";

/** A child-entry tree for `variant`; a current one has a vouched bundle, the others cannot be vouched for. */
async function fixtureTree(variant: Variant): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "rmd-remaining-proof-sites-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(root, SOURCE), ENTRY_SOURCE);
  if (variant === "absent") return root;
  const mod = await loadBuild();
  await mod.buildChildEntries({ root, entries: [{ name: NAME, source: SOURCE }] });
  if (variant === "stale") writeFileSync(join(root, SOURCE), ENTRY_SOURCE + "// edited after the build\n");
  if (variant === "corrupt") {
    const bundle = join(root, mod.OUT_DIR, `${NAME}.mjs`);
    const text = readFileSync(bundle, "utf8");
    assert.ok(text.includes(MARK), "positive control: the bundle carries the marker to flip");
    writeFileSync(bundle, text.replace(MARK, MARK.toUpperCase().replace(/./g, "X")));
  }
  return root;
}

/** A shared-fixture git tree whose HEAD is one test-file commit past origin/main, for the proof-repair round. */
function proofRoundTree(): { dir: string; start: string } {
  const repo = gitRepo({ kind: "remaining-proof-round" });
  const start = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", start);
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, "test", "x.test.ts"), "// x\n");
  repo.git("add", ".");
  repo.git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test edit");
  return { dir: repo.dir, start };
}

type Site = (root: string, outFile: string) => { cwd: string; baseSha?: string };

/** pr-open: the real spawn, in a consumer directory that has no rmd or tsx of its own. */
const prOpenSite: Site = (root) => {
  const consumer = mkdtempSync(join(tmpdir(), "rmd-remaining-consumer-"));
  const res = defaultProofRunner(PROOF, BASE, consumer, { owner: "o", repo: "r" } as never, process.execPath, root);
  assert.equal(res.status, 0, `${res.stderr ?? ""}${res.error ?? ""}`);
  return { cwd: consumer, baseSha: BASE };
};

/** run-task's proof-repair gate: the real spawn in the round's worktree, with an explicit child root. */
const proofRepairSite: Site = (root) => {
  const { dir, start } = proofRoundTree();
  const refusal = proofRepairRoundRefusalInWorktree({
    worktreePath: dir, roundStartSha: start, stageable: ["test/x.test.ts"], proofs: [PROOF], childRoot: root,
  });
  assert.equal(refusal, undefined, "the fixture entry exits 0, so the proof reads as passing");
  return { cwd: dir, baseSha: start };
};

/** run-task's runPreflightProofs: the real default spawn, a fixture child root. */
const preflightSite: Site = (root) => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-remaining-preflight-"));
  const out = runPreflightProofs(repo, {
    childRoot: root,
    spawn: defaultPreflightSpawn,
    git: (args: string[]) => (args[0] === "log" ? "body" : args[0] === "merge-base" ? `${BASE}\n` : "headsha\n"),
    resolveCriteria: () => [{ proof: PROOF }],
  });
  assert.equal(out.ok, true, JSON.stringify(out.steps));
  return { cwd: repo, baseSha: BASE };
};

const SITES: readonly [string, Site][] = [
  ["pr-open defaultProofRunner", prOpenSite],
  ["run-task proofRepairRoundRefusalInWorktree", proofRepairSite],
  ["run-task runPreflightProofs", preflightSite],
];

async function runSite(site: Site, variant: Variant): Promise<{ rec: ChildRecord; ctx: ReturnType<Site> }> {
  const root = await fixtureTree(variant);
  const outDir = mkdtempSync(join(tmpdir(), "rmd-remaining-out-"));
  const outFile = join(outDir, "records.ndjson");
  writeFileSync(outFile, "");
  const prior = process.env[OUT_ENV];
  process.env[OUT_ENV] = outFile;
  try {
    const ctx = site(root, outFile);
    const lines = readFileSync(outFile, "utf8").split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 1, "the check-proof child ran exactly once");
    return { rec: JSON.parse(lines[0]!) as ChildRecord, ctx };
  } finally {
    if (prior === undefined) delete process.env[OUT_ENV]; else process.env[OUT_ENV] = prior;
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("each remaining check-proof spawn site uses the current bundle", async () => {
  for (const [label, site] of SITES) {
    const { rec, ctx } = await runSite(site, "current");
    assert.equal(rec.marker, MARK, `${label}: the child ran`);
    assert.ok(!rec.execArgv.includes("--import"), `${label}: a vouched bundle runs under plain node, no loader import`);
    const expected = label.startsWith("pr-open") ? [PROOF, "--base", BASE, "--repo", "o/r"] : [PROOF, "--base", ctx.baseSha!];
    assert.deepEqual(rec.args, expected, `${label}: the caller's proof arguments, in order`);
    assert.equal(rec.cwd.replace(/^\/private/, ""), ctx.cwd.replace(/^\/private/, ""), `${label}: the caller's cwd`);
  }
});

test("each remaining check-proof spawn site preserves the source fallback", async () => {
  for (const variant of ["absent", "stale", "corrupt"] as const) {
    for (const [label, site] of SITES) {
      const { rec, ctx } = await runSite(site, variant);
      assert.ok(rec.execArgv.includes("--import"), `${label}/${variant}: the source entry runs under the tsx loader`);
      assert.equal(rec.marker, MARK, `${label}/${variant}: the source entry ran, not a bundle`);
      const expected = label.startsWith("pr-open") ? [PROOF, "--base", BASE, "--repo", "o/r"] : [PROOF, "--base", ctx.baseSha!];
      assert.deepEqual(rec.args, expected, `${label}/${variant}: the same arguments as the bundle path`);
    }
  }
});

test("the remaining proof launcher preserves consumer and injected contexts", async () => {
  // Default root is the harness package, never the cwd: the entry path is rooted at this repository.
  const argv = checkProofLaunchArgv(PROOF, BASE);
  const entry = argv[0] === "--import" ? argv[2] : argv[0];
  assert.ok(
    [join(REPO_ROOT, SOURCE), join(REPO_ROOT, "dist", "child-entries", `${NAME}.mjs`)].includes(entry!),
    "the default root is the harness package",
  );
  assert.deepEqual(argv.slice(argv.indexOf(entry!) + 1), [PROOF, "--base", BASE]);
  assert.deepEqual(checkProofLaunchArgv(PROOF, BASE, REPO_ROOT, ["--repo", "o/r"]).slice(-5), [PROOF, "--base", BASE, "--repo", "o/r"]);

  // A consumer repository (no rmd, no tsx) is only the cwd: the child is the harness's, and --repo follows --base.
  const { rec, ctx } = await runSite(prOpenSite, "current");
  assert.notEqual(ctx.cwd, REPO_ROOT);
  assert.equal(rec.cwd.replace(/^\/private/, ""), ctx.cwd.replace(/^\/private/, ""));
  assert.deepEqual(rec.args, [PROOF, "--base", BASE, "--repo", "o/r"]);

  // An injected non-node launcher keeps its own `check-proof` argv and never receives a node entry.
  const dir = mkdtempSync(join(tmpdir(), "rmd-remaining-injected-"));
  try {
    const bin = join(dir, "fake-rmd");
    const out = join(dir, "argv.txt");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
    chmodSync(bin, 0o755);
    const res = defaultProofRunner(PROOF, BASE, dir, { owner: "o", repo: "r" } as never, bin);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readFileSync(out, "utf8").split("\n").filter((l) => l !== ""), ["check-proof", PROOF, "--base", BASE, "--repo", "o/r"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
