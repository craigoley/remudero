import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../src/lib/clock.js";
import { ciFrictionGardenSpec, ciFrictionHandFixRounds, readCiFrictionHandFixes, priceCiFrictionCauses, landedCiFrictionOrigins } from "../src/lib/ci-friction-gardener.js";
import { ciFrictionEvidence, ciFrictionRemedyRationale, locateCiFrictionOwner } from "../src/lib/ci-friction-remedy.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const clock = fixedClock(Date.parse("2026-10-02T12:00:00Z"));
const rounds = [
  { pr: 1, at: "2026-10-01T10:00:00Z", cause: { kind: "fix_refusal" as const, name: "changed-nothing" }, minutes: 8, detail: "worker changed nothing" },
  { pr: 2, at: "2026-10-01T11:00:00Z", cause: { kind: "check" as const, name: "coverage-ratchet" }, minutes: 2 },
];
const search = { filesContaining: (term: string) => term === "worker changed nothing" ? [{ file: "src/worker.ts", hits: 1 }] : [], fileExists: () => true };
const fix = { pr: 9, at: "2026-10-02T10:00:00Z", files: ["src/worker.ts"] };

test("W1-T5300: a hand fix touching a cause's owning code is attached to that cause as evidence", () => {
  const added = ciFrictionHandFixRounds([fix, fix], rounds, priceCiFrictionCauses(rounds), search);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.cause.name, "changed-nothing");
  assert.equal(added[0]!.minutes, 5);
  const evidence = ciFrictionEvidence(added.map((r) => ({ ...r, causeKey: `${r.cause.kind}:${r.cause.name}` })), "fix_refusal:changed-nothing");
  assert.equal(evidence[0]!.pr, 9);
  assert.match(evidence[0]!.detail, /median proxy/);
  assert.match(ciFrictionRemedyRationale({ key: "fix_refusal:changed-nothing", minutes: 5, rounds: 1, prs: 1,
    owner: { files: ["src/worker.ts"], why: [] }, evidence,
    prior: { task: { id: "W1-T1", origin: "ci-friction:fix_refusal:changed-nothing", status: "merged", retired: false, files: ["src/worker.ts"] } },
  }).join("\n"), /PR #9.*hand fix/);
});

test("W1-T5300: a file repaired by hand in two PRs with no priced cause becomes a hand_fix cause", () => {
  const first = { ...fix, files: ["scripts/check.mjs"] };
  assert.deepEqual(ciFrictionHandFixRounds([first, first], rounds, [], search), []);
  const added = ciFrictionHandFixRounds([first, { ...first, pr: 10 }], rounds, [], search);
  assert.equal(added.length, 2);
  assert.deepEqual(added[0]!.cause, { kind: "hand_fix", name: "scripts/check.mjs" });
  assert.equal(priceCiFrictionCauses(added)[0]!.minutes, 10);
  assert.deepEqual(locateCiFrictionOwner("hand_fix:scripts/check.mjs", [], search)?.files, ["scripts/check.mjs"]);
  assert.equal(locateCiFrictionOwner("hand_fix:src/../../secret", [], search), undefined);
  assert.equal(locateCiFrictionOwner("hand_fix:src/absent.ts", [], { ...search, fileExists: () => false }), undefined);
  assert.deepEqual(ciFrictionHandFixRounds([first, { ...first, pr: 10 }], [], [], search), []);
});

test("W1-T5300: an unreadable PR list leaves hand fixes unmeasured without failing the pass", () => {
  const result = readCiFrictionHandFixes("/unused", "/unused", "owner", "repo", clock, () => { throw new Error("API unavailable"); });
  assert.equal(result.state, "unmeasured");
  assert.match(result.state === "unmeasured" ? result.reason : "", /API unavailable/);
});

test("hand-fix collector runs the real git and gh defaults and persists the merge evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hand-fix-"));
  const fixture = gitRepo({ kind: "hand-fix" });
  const priorPath = process.env.PATH;
  let shimDir: string | undefined;
  try {
    const repo = fixture.dir, git = fixture.git, state = join(root, "state");
    mkdirSync(state);
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src", "worker.ts"), "export const fixed = true;\n");
    git("add", "src/worker.ts"); git("-c", "commit.gpgsign=false", "commit", "-m", "fix(worker): remedy");
    const row = { number: 9, updated_at: clock.iso(), merged_at: fix.at, merge_commit_sha: git("rev-parse", "HEAD"), title: "fix(worker): remedy", head: { ref: "run-unfiled-1" } };
    const shim = ghShim([{ when: "api repos/owner/repo/pulls", stdout: JSON.stringify([row]) }]);
    shimDir = shim.dir;
    process.env.PATH = `${shim.dir}:${priorPath}`;
    const result = readCiFrictionHandFixes(repo, state, "owner", "repo", clock);
    assert.equal(result.state, "observed"); assert.deepEqual(result.fixes, [fix]);
    assert.equal(JSON.parse(readFileSync(join(state, "ci-friction-hand-fixes.json"), "utf8")).asOf, clock.iso());
  } finally { process.env.PATH = priorPath; fixture.cleanup(); rmSync(root, { recursive: true, force: true }); if (shimDir) rmSync(shimDir, { recursive: true, force: true }); }
});

test("manual check evidence survives measured gate pricing and hand-fix filings have durable receipts", () => {
  const added = { ...rounds[1]!, pr: 9, minutes: 5, pricing: "median-proxy" as const };
  const priced = priceCiFrictionCauses([...rounds, added], { status: "measured", prsScanned: 3,
    neverFired: [], alwaysFired: [], gates: [{ gate: "coverage-ratchet", prs: 2, runs: 3, redRuns: 2, refusals: 1, repaired: 1, overridden: 0, minutes: 12 }] });
  assert.deepEqual(priced.find((p) => p.cause.kind === "check"), { cause: rounds[1]!.cause, minutes: 17, rounds: 3, prs: 3 });
  assert.deepEqual(landedCiFrictionOrigins([{ step: "ci-friction.scorecard", pr_url: "https://github.com/owner/repo/pull/10", untracked: "hand_fix:src/worker.ts" }]), ["ci-friction:hand_fix:src/worker.ts"]);
});

test("hand-fix source failures preserve an explicit unavailable reason", () => {
  for (const read of [() => "{}", () => "[{}]", () => JSON.stringify([{ number: 9, updated_at: clock.iso(), merged_at: fix.at,
    title: "fix: broken", head: { ref: "run-unfiled-1" }, merge_commit_sha: "bad" }])]) {
    assert.equal(readCiFrictionHandFixes("/unused", "/unused", "owner", "repo", clock, read).state, "unmeasured");
  }
});

test("a failure reading changed files or persisting the cache is unmeasured, not an empty observed corpus", () => {
  const row = { number: 9, updated_at: clock.iso(), merged_at: fix.at, merge_commit_sha: "a".repeat(40), title: "fix: remedy", head: { ref: "run-unfiled-1" } };
  assert.equal(readCiFrictionHandFixes("/unused", "/unused/state", "owner", "repo", clock,
    (cmd) => { if (cmd === "git") throw new Error("merge unavailable"); return JSON.stringify([row]); }).state, "unmeasured");
  assert.equal(readCiFrictionHandFixes("/unused", "/dev/null/state", "owner", "repo", clock, () => "[]").state, "unmeasured");
});

test("hand-fix collection paginates one list, excludes nonfix, unmerged, old and future repairs", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hand-pages-"));
  const ignored = { number: 1, updated_at: clock.iso(), title: "feat: new", head: { ref: "run-unfiled-1" } };
  const row = { ...ignored, title: "fix: remedy", merged_at: fix.at, merge_commit_sha: "a".repeat(40) };
  let pages = 0;
  try {
    const result = readCiFrictionHandFixes(root, root, "owner", "repo", clock, (cmd, args) => {
      if (cmd === "git") return "src/fixed.ts\nsrc/../../secret\nREADME.md\nsrc/fixed.ts\n";
      pages++;
      return JSON.stringify(pages === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...ignored, number: i + 1 })) : [
        { ...row, number: 101 }, { ...row, number: 102, merged_at: "2026-09-01T12:00:00Z" },
        { ...row, number: 103, merged_at: "2027-01-01T12:00:00Z" }, { ...row, number: 104, head: { ref: "run-W1-T1-1" } },
        { ...row, number: 105, merged_at: null },
      ]);
    });
    assert.equal(pages, 2); assert.equal(result.state, "observed");
    assert.deepEqual(result.fixes, [{ pr: 101, at: fix.at, files: ["src/fixed.ts"] }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manual repair attribution neither duplicates an existing PR round nor charges one PR to two causes", () => {
  assert.deepEqual(ciFrictionHandFixRounds([{ ...fix, pr: 1 }], rounds, priceCiFrictionCauses(rounds), search), []);
  const both = [{ ...fix, files: ["scripts/a.mjs", "scripts/b.mjs"] }, { ...fix, pr: 10, files: ["scripts/a.mjs", "scripts/b.mjs"] }];
  const added = ciFrictionHandFixRounds(both, [rounds[0]!], [], search);
  assert.equal(added.length, 2); assert.equal(added[0]!.minutes, 8);
});

test("the live garden reports unreadable manual evidence while still producing its ordinary inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hand-garden-"));
  const logs: string[] = [];
  try {
    const spec = ciFrictionGardenSpec({ stateDir: root, repoRoot: root, clock, log: (step) => logs.push(step), openWorkspace: () => { throw new Error("not needed"); } }, {
      ledgerRecords: () => [], handFixes: () => ({ state: "unmeasured", reason: "API unavailable", fixes: [] }),
      planState: () => ({ tasks: [] }), ownerSearch: search, mintTaskId: () => "W1-T1",
    });
    const inv = spec.inventory();
    assert.deepEqual(inv.handFixState, { state: "unmeasured", count: 0 });
    assert.ok(logs.includes("ci-friction.hand_fixes_unmeasured"));
    assert.equal(spec.scorecard(inv, { actions: [], acting: [] }).hand_fixes && inv.priced.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
