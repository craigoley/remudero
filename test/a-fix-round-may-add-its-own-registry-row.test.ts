import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  commitWorkerEdits, fixRungScopeStandDownReason, harnessCommitForShellLessWorker,
  readRegistrationChanges, renderFixPrompt, runFixRung, scopeGuardOutOfScopeFiles,
} from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import * as sweep from "#src/lib/sweep.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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

test("test/a-fix-round-may-add-its-own-registry-row.test.ts", (t) => {
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
  assert.deepEqual(sweep.ADDITIVE_REGISTRATION_SURFACES.map((row) => row.path), [ledger, spend, env, authority, baseline,
    parity, parityBaseline, guide]);
});

// W1-T13378: a pull request that adds a COMMANDS verb must register it in the console-parity table, its baseline
// and the operator guide's command table. Those are instrument files, so a fix round stood down for the operator.
const commandsPath = "src/run-task.ts";
const parity = "scripts/console-parity-ratchet.mjs";
const parityBaseline = "scripts/console-parity-baseline.json";
const guide = "docs/operator-guide.md";
const verbSurfaces = [parity, parityBaseline, guide];
const commandRow = (verb: string) => `  {\n    name: "${verb}",\n    syntax: "rmd ${verb}",\n    summary: "s",\n    detail: "d",\n  },\n`;
const commandsSource = (verbs: readonly string[], padding = "") =>
  `${padding}const COMMANDS: readonly CommandSpec[] = [\n${verbs.map(commandRow).join("")}];\nexport { COMMANDS };\n`;
const mainVerbs = ["old-verb", "listed-verb", "gh"];
const verbBefore: Record<string, string> = {
  [parity]: 'export const ROUTE_MATCH = {\n  status: "GET /v1/status",\n};\nexport const CLI_ONLY = {\n  "old-verb": "host-local",\n' +
    '  ...reasons(\n    [\n      // a listed verb\n      "listed-verb",\n    ],\n    REASON,\n  ),\n  gh:\n    "runs one read " +\n    "on the Mac",\n};\n',
  [parityBaseline]: '{\n  "_comment": "the recorded set",\n  "uncoveredVerbs": [\n    "gh",\n    "listed-verb",\n    "old-verb"\n  ]\n}\n',
  [guide]: "# Guide\n\n| Command | What it does |\n|---|---|\n| `rmd old-verb` | Old. |\n| `rmd gh -- <args>` | One read. |\n\nAfter the table.\n",
};
const rowAnchor: Record<string, string> = { [parity]: '  "old-verb":', [parityBaseline]: '    "old-verb"', [guide]: "| `rmd gh" };
const ownRow: Record<string, string> = {
  [parity]: '  "new-verb": "host-local recovery of one PR",\n',
  [parityBaseline]: '    "new-verb",\n',
  [guide]: "| `rmd new-verb <pr-number>` | Recover one PR. |\n",
};
const withRow = (path: string, row = ownRow[path]) => verbBefore[path].replace(rowAnchor[path], `${row}${rowAnchor[path]}`);
const verbChange = (path: string, after: string, prAddedVerbs: readonly string[] | undefined = ["new-verb"]) =>
  ({ path, before: verbBefore[path], after, ...(prAddedVerbs ? { prAddedVerbs } : {}) });

/** Each form keeps the PR's own row and adds exactly one edit the invariant refuses. */
const refusedForms: Record<string, [string, string][]> = {
  [parity]: [
    ["an existing row changed", withRow(parity).replace('"old-verb": "host-local"', '"old-verb": "changed"')],
    ["an existing row removed", withRow(parity).replace('  "old-verb": "host-local",\n', "")],
    ["a verb the PR does not add", withRow(parity, ownRow[parity].replace("new-verb", "other-verb"))],
    ["an edit outside the table", withRow(parity).replace('"GET /v1/status"', '"GET /v1/other"')],
    ["the verb joined an existing list", verbBefore[parity].replace('"listed-verb",', '"listed-verb",\n      "new-verb",')],
    ["the row added twice", withRow(parity, ownRow[parity] + ownRow[parity])],
    ["a computed reason", withRow(parity, '  "new-verb": reasonFor("new-verb"),\n')],
    ["a spread row", withRow(parity, '  ...reasons(["new-verb"], REASON),\n')],
    ["a row for a verb already listed", withRow(parity, '  "listed-verb": "again",\n')],
  ],
  [parityBaseline]: [
    ["an existing row changed", withRow(parityBaseline).replace('"gh"', '"gh-two"')],
    ["an existing row removed", withRow(parityBaseline).replace('    "gh",\n', "")],
    ["a verb the PR does not add", withRow(parityBaseline, '    "other-verb",\n')],
    ["an edit outside the list", withRow(parityBaseline).replace("the recorded set", "an edited set")],
    ["the row added twice", withRow(parityBaseline, ownRow[parityBaseline] + ownRow[parityBaseline])],
  ],
  [guide]: [
    ["an existing row changed", withRow(guide).replace("Old.", "Changed.")],
    ["an existing row removed", withRow(guide).replace("| `rmd old-verb` | Old. |\n", "")],
    ["a verb the PR does not add", withRow(guide, ownRow[guide].replace("new-verb", "other-verb"))],
    ["an edit outside the table", withRow(guide).replace("After the table.", "Edited.")],
    ["a row that also names another verb", withRow(guide, "| `rmd new-verb` | Same as `rmd other-verb`. |\n")],
    ["a row for a verb already documented", withRow(guide, "| `rmd old-verb --again` | Again. |\n")],
  ],
};

function verbScope(t: { after(fn: () => void): void }, worker: Record<string, string>, opts: { prVerbs?: string[]; requested?: string[]; small?: boolean; reasked?: boolean } = {}) {
  const repo = gitRepo({ kind: "verb-registration" });
  t.after(() => repo.cleanup());
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  // Past execFileSync's 1 MiB default buffer, as the real src/run-task.ts is: the PR's diff must still be readable.
  const padding = opts.small ? "" : `// ${"x".repeat(1_200_000)}\n`;
  put(commandsPath, commandsSource(mainVerbs, padding));
  for (const path of verbSurfaces) put(path, verbBefore[path]);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const branch = "run-W1-T9002-1794947327900";
  repo.git("checkout", "-qb", branch);
  put(commandsPath, commandsSource([...mainVerbs, ...(opts.prVerbs ?? ["new-verb"])], padding));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "feat: add the verb");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: ({ step: string } & Record<string, unknown>)[] = [];
  const issues: string[] = [];
  let spawns = 0;
  const signature = "comment-load-ratchet: console-parity UNMAPPED new-verb; docs-claims operator guide missing new-verb";
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const review = { state: "failure", criteria: [{ claim: "ci green", proof: "unit test: ci", met: false, reason: signature,
    proof_exec: "not_executable" }], testTheater: false, summary: signature, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  const run: Parameters<typeof runFixRung>[0] = {
    taskId: "W1-T9002", runId: "verb-registration-run", task: { id: "W1-T9002", title: "add new-verb", files: [commandsPath] },
    prUrl: "https://github.com/acme/remudero/pull/19014", branch, worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review, ciFailures: [{ name: "comment-load-ratchet", logTail: signature }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "only the operator can grant an instrument" }),
    deps: {
      spawn: async () => {
        // A re-asked round first omits its COMMIT_MESSAGE line, from a writer with no provider, and gives it when asked.
        const first = spawns++ === 0;
        if (first) for (const [path, text] of Object.entries(worker)) put(path, text);
        const line = opts.reasked && first ? "" : "COMMIT_MESSAGE: fix(console): register new-verb";
        return { text: `REPORT\nnew-verb needs its registrations.\nFIX_OUTCOME: NEEDS_SCOPE ${(opts.requested ?? verbSurfaces).join(",")}\n` +
            line, blocks: [], sessionId: "scope", costUsd: 1, numTurns: 1,
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, stderr: "", model: "sonnet", effort: "medium",
          compactionEvents: [], qualitySuspect: false, modelUsage: {}, ...(opts.reasked ? {} : { provider: "codex" }) } as WorkerResult;
      },
      fetchPrBody: async () => "Adds new-verb.\n\nRemudero-Task: W1-T9002\n",
      fetchPrDiffFiles: async () => repo.git("diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean),
      scopeAmendmentWritePorts: { repoDir: repo.dir, findShard: () => undefined, lookupIdentity: () => undefined,
        probeExisting: () => undefined } as unknown as NonNullable<Parameters<typeof runFixRung>[0]["deps"]["scopeAmendmentWritePorts"]>,
      push: () => {},
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", headSha: repo.git("rev-parse", "HEAD") }),
      issues: { create: (_title, body) => { issues.push(body); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T9002", pr_number: 19014, ...extra }),
      say: () => {}, account: (r) => r,
    },
  };
  const committed = () => repo.git("diff", "--name-only", `${headSha}..HEAD`).split("\n").filter(Boolean).sort();
  return { repo, run, rows, issues, headSha, committed, spawns: () => spawns };
}

test("W1-T13378 criterion 1: a fix round's NEEDS_SCOPE for its own verb's rows commits them instead of escalating", async (t) => {
  for (const reasked of [false, true]) {
    const f = verbScope(t, Object.fromEntries(verbSurfaces.map((path) => [path, withRow(path)])), { reasked });
    await runFixRung(f.run);
    const scope = f.rows.filter((row) => row.step === "fix.scope_amendment");
    assert.deepEqual(f.issues, [], JSON.stringify(f.rows.map((row) => [row.step, row.outcome, row.reason])));
    assert.deepEqual(scope.map((row) => row.outcome), reasked ? ["registration-admitted", "registration-admitted"] : ["registration-admitted"]);
    assert.ok(scope.every((row) => JSON.stringify(row.paths) === JSON.stringify(verbSurfaces)), JSON.stringify(scope));
    assert.equal(f.spawns(), reasked ? 2 : 1, "positive control: the re-asked round asked once for its commit line");
    assert.deepEqual(f.committed(), [...verbSurfaces].sort(), "the round committed exactly the three registrations");
    for (const path of verbSurfaces) assert.equal(f.repo.git("show", `HEAD:${path}`), withRow(path).trimEnd());
  }
});

test("W1-T13378 criterion 1: the PR's own verb row is an additive registration on each surface, read from the PR's diff", async (t) => {
  for (const path of verbSurfaces) {
    assert.equal(sweep.isAdditiveRegistrationChange(verbChange(path, withRow(path))), true, path);
  }
  const changes = verbSurfaces.map((path) => verbChange(path, withRow(path)));
  assert.deepEqual(scopeGuardOutOfScopeFiles(verbSurfaces, [commandsPath], changes), []);
  assert.equal(fixRungScopeStandDownReason([commandsPath, ...verbSurfaces], [commandsPath], [commandsPath], [], [], changes), undefined);
  // The verb is what the PR's committed diff adds to COMMANDS, from the merge base to the head: a real git read.
  const f = verbScope(t, {}, { small: true });
  for (const path of verbSurfaces) writeFileSync(join(f.repo.dir, path), withRow(path));
  f.repo.git("add", "-A");
  f.repo.git("commit", "-qm", "fix: register new-verb");
  const read = await sweep.withPrAddedVerbs(readRegistrationChanges(f.repo.dir, verbSurfaces, "origin/main"),
    (args) => f.repo.git(...args), "HEAD");
  assert.deepEqual(read.map((change) => [change.path, change.prAddedVerbs, change.error]), verbSurfaces.map((path) => [path, ["new-verb"], undefined]));
  assert.ok(read.every(sweep.isAdditiveRegistrationChange));
  // Positive control on the real files: the mechanism parses this repository's own table, baseline, guide and COMMANDS.
  const real = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
  const commands = real(commandsPath);
  const fake = "w1-t13378-probe-verb";
  const plus = commands.replace("const COMMANDS: readonly CommandSpec[] = [\n", `const COMMANDS: readonly CommandSpec[] = [\n${commandRow(fake)}`);
  assert.notEqual(plus, commands, "positive control: the real COMMANDS declaration was found");
  assert.deepEqual(sweep.commandVerbsAddedByDiff(commands, plus), [fake]);
  const realRows: Record<string, [string, string]> = {
    [parity]: ["export const CLI_ONLY = {\n", `  "${fake}": "probe",\n`],
    [parityBaseline]: ['  "uncoveredVerbs": [\n', `    "${fake}",\n`],
    [guide]: ["| Command | What it does |\n|---|---|\n", `| \`rmd ${fake}\` | Probe. |\n`],
  };
  for (const [path, [anchor, row]] of Object.entries(realRows)) {
    const before = real(path);
    const after = before.replace(anchor, `${anchor}${row}`);
    assert.notEqual(after, before, path);
    assert.equal(sweep.isAdditiveRegistrationChange({ path, before, after, prAddedVerbs: [fake] }), true, path);
    assert.equal(sweep.isAdditiveRegistrationChange({ path, before, after, prAddedVerbs: ["another-verb"] }), false, path);
  }
});

test("W1-T13378 criterion 2: an existing-row edit, a removal, another verb or any other edit stays an instrument path", async () => {
  for (const path of verbSurfaces) {
    assert.equal(sweep.isAdditiveRegistrationChange(verbChange(path, withRow(path))), true, `positive control: ${path}`);
    for (const [name, after] of refusedForms[path]) {
      assert.notEqual(after, withRow(path), `${path}: ${name} is a real edit`);
      const change = verbChange(path, after);
      assert.equal(sweep.isAdditiveRegistrationChange(change), false, `${path}: ${name}`);
      assert.deepEqual(scopeGuardOutOfScopeFiles([path], [commandsPath], [change]), [path], `${path}: ${name}`);
      assert.ok(fixRungScopeStandDownReason([commandsPath, path], [commandsPath], [commandsPath], [], [], [change]), `${path}: ${name}`);
    }
    // The verb comes only from the PR's diff: no evidence, no verb, or an unreadable read refuses the row.
    const own = { path, before: verbBefore[path], after: withRow(path) };
    assert.equal(sweep.isAdditiveRegistrationChange(own), false, `${path}: no evidence`);
    assert.equal(sweep.isAdditiveRegistrationChange({ ...own, prAddedVerbs: [] }), false, `${path}: the PR adds no verb`);
    assert.equal(sweep.isAdditiveRegistrationChange({ ...verbChange(path, withRow(path)), error: "unreadable" }), false, path);
  }
  const unreadable = await sweep.withPrAddedVerbs([{ path: guide, before: verbBefore[guide], after: withRow(guide) }],
    () => { throw new Error("merge base unavailable"); });
  assert.match(unreadable[0].error ?? "", /merge base unavailable/);
  assert.equal(sweep.isAdditiveRegistrationChange(unreadable[0]), false);
  const unparsable = await sweep.withPrAddedVerbs([{ path: guide, before: verbBefore[guide], after: withRow(guide) }],
    (args) => args[0] === "merge-base" ? "base\n" : "export const nothing = 1;\n");
  assert.match(unparsable[0].error ?? "", /COMMANDS/);
  const untouched = [{ path: ledger, before: sources[ledger], after: added(ledger) }, { path: guide, before: verbBefore[guide], after: verbBefore[guide] }];
  assert.deepEqual(await sweep.withPrAddedVerbs(untouched, () => { throw new Error("must not read"); }), untouched);
  // COMMANDS rows are keyed by their own top-level name; any row without one makes the PR's verbs unknown.
  const commands = commandsSource(mainVerbs);
  assert.deepEqual(sweep.commandVerbsAddedByDiff(commands, commandsSource([...mainVerbs, "new-verb"])), ["new-verb"]);
  assert.deepEqual(sweep.commandVerbsAddedByDiff(commands, commands), []);
  assert.deepEqual(sweep.commandVerbsAddedByDiff(commands, commands.replace('name: "gh"', 'name: "gh-renamed"')), ["gh-renamed"]);
  for (const after of [commands.replace("];", "  { syntax: \"rmd x\", flags: [{ name: \"nested\" }] },\n];"),
    commands.replace("];", "  { name: VERB_NAME },\n];"), commands.replace("];", "  ...MORE_COMMANDS,\n];"), "const OTHER = [];\n"]) {
    assert.equal(sweep.commandVerbsAddedByDiff(commands, after), undefined, after);
  }
});

test("W1-T13378 criterion 2: a fix round whose verb rows break the boundary still escalates as an instrument", async (t) => {
  const own = Object.fromEntries(verbSurfaces.map((path) => [path, withRow(path)]));
  for (const [name, worker, prVerbs] of [
    ["an existing row changed", { ...own, [parity]: refusedForms[parity][0][1] }, undefined],
    ["a verb the PR does not add", { ...own, [guide]: refusedForms[guide][2][1] }, undefined],
    ["a verb only the worker adds", { ...own, [commandsPath]: commandsSource([...mainVerbs, "new-verb"]) }, ["unrelated-verb"]],
  ] as const) {
    const f = verbScope(t, worker, { prVerbs: prVerbs ? [...prVerbs] : undefined });
    await runFixRung(f.run);
    const scope = f.rows.filter((row) => row.step === "fix.scope_amendment");
    assert.deepEqual(scope.map((row) => [row.outcome, row.paths]), [["instrument-escalated", [...verbSurfaces].sort()]], name);
    assert.equal(f.issues.length, 1, name);
    assert.match(f.issues[0], /instrument-path/, name);
    assert.deepEqual(f.committed(), [], `${name}: nothing was committed`);
  }
});
