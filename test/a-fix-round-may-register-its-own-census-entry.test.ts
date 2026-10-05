import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  commitWorkerEdits, fixRungScopeStandDownReason, harnessCommitForShellLessWorker,
  readRegistrationChanges, renderFixPrompt, scopeGuardOutOfScopeFiles,
} from "../src/run-task.js";
import * as sweep from "../src/lib/sweep.js";
import { gitRepo } from "./helpers/git-repo.js";

const declared = ["src/lib/worker.ts"];
const ledger = "src/lib/ledger.ts";
const env = "src/lib/config-schema.ts";
const spend = "src/lib/spend-rows.ts";
const authority = "src/lib/authority.ts";
const baseline = "scripts/bound-kind-baseline.json";
const sources: Record<string, string> = {
  [ledger]: 'export const DECISION_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([\n  "old.step",\n]);\nexport const unrelated = 1;\n',
  [env]: 'export const ENV_REGISTRY: readonly EnvRegistryEntry[] = [\n  envEntry("OLD", "purpose", ["src/lib/worker.ts"]),\n];\n',
  [spend]: 'export const SPEND_STEP_ROLES: Readonly<Record<string, SpendRole>> = {\n  "old.step": "produced",\n};\n',
  [authority]: 'export const AUTHORITY_TABLE: readonly AuthorityRow[] = [\n  { id: "old", module: "src/lib/worker.ts" },\n];\n',
  [baseline]: '{\n  "capturedAt": "2026-10-04",\n  "grandfathered": [\n    "src/lib/worker.ts:OLD",\n    "src/lib/worker.ts:OTHER"\n  ]\n}\n',
};
const additions: Record<string, string> = {
  [ledger]: '  "new.step",\n  "second.step",\n',
  [env]: '  envEntry("NEW", "purpose", ["src/lib/worker.ts"]),\n',
  [spend]: '  "new.step": "produced",\n',
  [authority]: '  { id: "new", module: "src/lib/other.ts" },\n',
};
function added(path: string): string {
  return sources[path].replace(path === spend ? "};" : path === ledger ? "]);" : "];", `${additions[path]}${path === spend ? "};" : path === ledger ? "]);" : "];"}`);
}
function fixture(t: { after(fn: () => void): void }, files = sources): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-registration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
function fakeGit(paths: string[], calls: string[][] = []) {
  return (args: string[]): string => {
    calls.push(args);
    if (args[0] === "status") return paths.map((path) => ` M ${path}\0`).join("");
    if (args[0] === "show") return sources[args[1].slice(args[1].indexOf(":") + 1)];
    if (args[0] === "rev-parse") return "new-head\n";
    return "";
  };
}

test("test/a-fix-round-may-register-its-own-census-entry.test.ts", (t) => {
  for (const path of [env, ledger]) {
    const dir = fixture(t, { [path]: added(path) });
    const result = commitWorkerEdits(dir, declared, "fix(worker): register census row", { runGit: fakeGit([path]) });
    assert.equal(result.committed, true, path);
    assert.deepEqual(result.admittedRegistrations, [path]);
    assert.deepEqual(result.undeclared, []);
    for (const after of [sources[path].replace(path === env ? '"OLD"' : '"old.step"', '"changed"'),
      sources[path].split("\n").filter((line) => !line.includes(path === env ? "envEntry(" : '"old.step"')).join("\n")]) {
      writeFileSync(join(dir, path), after);
      const refused = commitWorkerEdits(dir, declared, "fix(worker): edit row", { runGit: fakeGit([path]) });
      assert.equal(refused.committed, false);
      assert.deepEqual(refused.undeclared, [path]);
      assert.deepEqual(scopeGuardOutOfScopeFiles([path], declared, [{ path, before: sources[path], after }]), [path]);
    }
  }
});

test("a #9041-shaped addition passes staging and both scope filters, and records the admission", (t) => {
  const paths = [ledger, spend];
  const dir = fixture(t, Object.fromEntries(paths.map((path) => [path, added(path)])));
  const changes = paths.map((path) => ({ path, before: sources[path], after: added(path) }));
  assert.deepEqual(scopeGuardOutOfScopeFiles(paths, declared, changes), []);
  assert.equal(fixRungScopeStandDownReason(paths, [], declared, [], [], changes), undefined);
  const rows: { step: string; extra?: Record<string, unknown> }[] = [];
  const count = harnessCommitForShellLessWorker({
    harnessOwnsGit: true, commitCount: 0, report: "COMMIT_MESSAGE: fix(worker): register census rows",
    worktreePath: dir, declaredPaths: declared,
    log: (step, extra) => rows.push({ step, extra }), say: () => {},
  }, { commit: (repo, files, message) => commitWorkerEdits(repo, files, message, { runGit: fakeGit(paths) }), ahead: () => 1 });
  assert.equal(count, 1);
  assert.deepEqual(rows[0].extra?.admitted_registrations, paths);
});

test("registration admission refuses mixed edits, outside additions, duplicate keys and unknown scope", (t) => {
  const dir = fixture(t);
  const invalid = [
    added(ledger).replace("unrelated = 1", "unrelated = 2"),
    sources[ledger] + 'export const outside = 2;\n',
    added(ledger).replace('"new.step"', '"old.step"'),
    added(ledger).replace('"old.step"', '"edited.step"'),
  ];
  for (const after of invalid) {
    writeFileSync(join(dir, ledger), after);
    assert.equal(commitWorkerEdits(dir, declared, "fix(worker): register", { runGit: fakeGit([ledger]) }).committed, false);
  }
  writeFileSync(join(dir, spend), added(spend).replace('"new.step": "produced"', '"old.step": "restated"'));
  assert.equal(commitWorkerEdits(dir, declared, "fix(worker): register", { runGit: fakeGit([spend]) }).committed, false);
  const change = { path: ledger, before: sources[ledger], after: added(ledger) };
  assert.deepEqual(scopeGuardOutOfScopeFiles([ledger], declared), [ledger]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([ledger], [], [change]), [ledger]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([ledger], undefined, [change]), [ledger]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([ledger], ["plan/tasks.d/task.yaml"], [change]), [ledger]);
  assert.ok(fixRungScopeStandDownReason([ledger], [], ["plan/tasks.d/task.yaml"], [], [], [change]));
  assert.ok(fixRungScopeStandDownReason([ledger], [], declared, [ledger], [],
    [{ ...change, after: invalid[0] }]), "a gate remedy cannot bypass the registry boundary");
});

test("authority additions and shrink-only bound baselines are bounded to their rows", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, authority), added(authority));
  assert.deepEqual(commitWorkerEdits(dir, declared, "fix(worker): register", { runGit: fakeGit([authority]) }).admittedRegistrations, [authority]);
  const shrunk = sources[baseline].replace('    "src/lib/worker.ts:OLD",\n', "");
  writeFileSync(join(dir, baseline), shrunk);
  assert.deepEqual(commitWorkerEdits(dir, declared, "fix(worker): shrink", { runGit: fakeGit([baseline]) }).admittedRegistrations, [baseline]);
  assert.equal(fixRungScopeStandDownReason([baseline], [], declared, [baseline], [],
    [{ path: baseline, before: sources[baseline], after: shrunk }]), undefined);
  for (const after of [sources[baseline].replace('"grandfathered": [', '"grandfathered": [\n    "new:BOUND",'),
    shrunk.replace("2026-10-04", "2026-10-05"), sources[baseline].replace("worker.ts:OLD", "worker.ts:NEW")]) {
    writeFileSync(join(dir, baseline), after);
    assert.equal(commitWorkerEdits(dir, declared, "fix(worker): baseline", { runGit: fakeGit([baseline]) }).committed, false);
    assert.ok(fixRungScopeStandDownReason([baseline], [], declared, [baseline], [],
      [{ path: baseline, before: sources[baseline], after }]));
  }
});

test("unreadable or missing registry evidence refuses the exception", (t) => {
  const dir = fixture(t, { [ledger]: added(ledger) });
  const result = commitWorkerEdits(dir, declared, "fix(worker): register", { runGit: (args) => {
    if (args[0] === "show") throw new Error("base blob unavailable");
    return fakeGit([ledger])(args);
  } });
  assert.equal(result.committed, false);
  assert.deepEqual(result.undeclared, [ledger]);
  assert.match(result.reason!, /base blob unavailable/);
  rmSync(join(dir, ledger));
  assert.equal(commitWorkerEdits(dir, declared, "fix(worker): register", { runGit: fakeGit([ledger]) }).committed, false);
});

test("real git stages only the admitted registration beside an undeclared sibling", (t) => {
  const repo = gitRepo({ seedCommit: false, kind: "registration" });
  const { dir, git } = repo;
  t.after(() => repo.cleanup());
  mkdirSync(dirname(join(dir, ledger)), { recursive: true });
  writeFileSync(join(dir, ledger), sources[ledger]);
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", "--", ledger);
  git("commit", "--quiet", "-m", "chore: seed");
  git("branch", "base");
  writeFileSync(join(dir, ledger), added(ledger));
  writeFileSync(join(dir, "rogue.ts"), "export const rogue = true;\n");
  const result = commitWorkerEdits(dir, declared, "fix(worker): register");
  assert.equal(result.committed, true);
  assert.deepEqual(result.admittedRegistrations, [ledger]);
  assert.deepEqual(result.undeclared, ["rogue.ts"]);
  assert.equal(git("show", "--pretty=", "--name-only", "HEAD").trim(), ledger);
  assert.equal(readFileSync(join(dir, ledger), "utf8"), added(ledger));
  const changes = readRegistrationChanges(dir, [ledger, "rogue.ts"], "base");
  assert.equal(changes.length, 1);
  assert.deepEqual(scopeGuardOutOfScopeFiles([ledger], declared, changes), []);
  git("switch", "--quiet", "base");
  writeFileSync(join(dir, ledger), sources[ledger].replace('"old.step"', '"edited.step"'));
  git("add", "--", ledger);
  git("commit", "--quiet", "-m", "fix: edit existing row");
  assert.deepEqual(scopeGuardOutOfScopeFiles([ledger], declared, readRegistrationChanges(dir, [ledger], result.sha)), [ledger]);
});

test("malformed literals and non-row additions never grant registration scope", () => {
  const before = sources[ledger];
  for (const after of [before, added(ledger).replace('"new.step"', '"unterminated'),
    added(ledger).replace('"new.step"', '"new.step" + unknownStep'), added(ledger).replace('"new.step"', '...steps'),
    added(ledger).replace('"new.step"', '`prefix${step}`'), added(ledger).replace('"new.step"', '/pattern/'),
    added(ledger).replace('"new.step"', '("step"}'), added(ledger).replace("]);", ""),
    before + before, before.replace("export const", "const")]) {
    assert.equal(sweep.isAdditiveRegistrationChange({ path: ledger, before, after }), false, after);
  }
  assert.equal(sweep.isAdditiveRegistrationChange({ path: "unregistered.ts", before, after: added(ledger) }), false);
  assert.equal(sweep.isAdditiveRegistrationChange({ path: ledger, after: added(ledger) }), false);
  const spendAfter = added(spend).replace('"new.step":', '["new.step"]:');
  assert.equal(sweep.isAdditiveRegistrationChange({ path: spend, before: sources[spend], after: spendAfter }), false);
  const envAfter = added(env).replace('envEntry("NEW"', 'otherEntry("NEW"');
  assert.equal(sweep.isAdditiveRegistrationChange({ path: env, before: sources[env], after: envAfter }), false);
  const authorityAfter = added(authority).replace('id: "new"', 'name: "new"');
  assert.equal(sweep.isAdditiveRegistrationChange({ path: authority, before: sources[authority], after: authorityAfter }), false);
});

test("existing ledger symbol rows and authority as-const closers retain their installed shapes", () => {
  const before = sources[ledger].replace('  "old.step",', '  OLD_STEP, // imported constant\n  "old.step",');
  const after = added(ledger).replace('  "old.step",', '  OLD_STEP, // imported constant\n  "old.step",');
  assert.equal(sweep.isAdditiveRegistrationChange({ path: ledger, before, after }), true);
  assert.equal(sweep.isAdditiveRegistrationChange({ path: authority,
    before: sources[authority].replace("];", "] as const;"),
    after: added(authority).replace("];", "] as const;") }), true);
});

test("census fix prompts name the bounded table and refuse existing-row edits", () => {
  const prompt = (files: string[], name: string) => renderFixPrompt({
    task: { id: "W1-T5691", title: "fixture", files }, round: 1, branch: "run-W1-T5691-1",
    evidence: { ciFailures: [{ name, logTail: "missing registration" }] },
  });
  const text = prompt(declared, "ledger-literal-census");
  assert.match(text, /ADDITIVE_REGISTRATION_SURFACES/);
  assert.match(text, /DECISION_RELEVANT_LEDGER_STEPS/);
  assert.match(text, /existing row/);
  assert.ok(text.includes(baseline));
  assert.doesNotMatch(prompt(["plan/tasks.d/task.yaml"], "ledger-literal-census"), /ADDITIVE_REGISTRATION_SURFACES/);
  assert.doesNotMatch(prompt(declared, "typecheck"), /ADDITIVE_REGISTRATION_SURFACES/);
  assert.deepEqual(sweep.ADDITIVE_REGISTRATION_SURFACES.map((row) => row.path), [ledger, spend, env, authority, baseline]);
});
