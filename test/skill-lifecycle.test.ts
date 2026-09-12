import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";
import { loadProposalRegistry, classifyProposal, proposalsNeedingDraft, type Proposal } from "../src/lib/inbox.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  buildSkillEffectivenessReport,
  skillLifecycleProposalId,
  stageSkillLifecycleProposal,
  type SkillEffectivenessReport,
} from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  applySkillLifecycleRemoval,
  approveCommand,
  skillLifecycleApproveCommitMessage,
  skillLifecycleCommand,
  skillLifecyclePrBody,
} from "../src/run-task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function approveSkill(skillsDir: string, name = "procedure"): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, ["---", `name: ${name}`, "applies-to: implement", "---", "", "## Procedure", "", "- Do the thing."].join("\n"), "utf8");
  return path;
}

function selectionRow(runId: string, selected: boolean, skill = "procedure"): Record<string, unknown> {
  return {
    step: "skills.selection",
    run_id: runId,
    task_type: "implement",
    approved_eligible_names: [skill],
    selected_names: selected ? [skill] : [],
    budget_omitted_names: [],
    budget_chars: 1000,
    zero_selection: !selected,
  };
}

function verdictRow(runId: string, verdict: string): Record<string, unknown> {
  return { step: "verdict", run_id: runId, verdict };
}

function rows(selected: string[], control: string[], skill = "procedure"): Record<string, unknown>[] {
  return [
    ...selected.flatMap((verdict, i) => [selectionRow(`selected-${i}`, true, skill), verdictRow(`selected-${i}`, verdict)]),
    ...control.flatMap((verdict, i) => [selectionRow(`control-${i}`, false, skill), verdictRow(`control-${i}`, verdict)]),
  ];
}

function report(selected: string[], control: string[], skill = "procedure"): SkillEffectivenessReport {
  return buildSkillEffectivenessReport(rows(selected, control, skill), skill);
}

function union(records: Record<string, unknown>[], over: Record<string, unknown> = {}): any {
  return {
    stateDir: "/state",
    archiveFiles: [],
    archiveCount: 0,
    liveFileRead: true,
    unread: [],
    unclassified: [],
    ok: true,
    rows: records,
    torn: 0,
    filesRead: 1,
    ...over,
  };
}

function makeLifecycleOrigin() {
  const bare = gitRepo({ bare: true, branch: "main", kind: "skill-lifecycle-origin" });
  const seed = gitRepo({ branch: "main", seedCommit: false, kind: "skill-lifecycle-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(
    join(seed.dir, "plan", "tasks.yaml"),
    [
      "- id: W1-T4",
      "  title: seed task",
      "  repo: remudero",
      "  depends_on: []",
      "  type: implement",
      "  verify: auto",
      "  status: queued",
      "  attempts: 0",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n", "utf8");
  approveSkill(join(seed.dir, ".claude", "skills"));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed lifecycle fixture");
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.cleanup();
  return bare;
}

test("W1-T3413 refuses untrusted lifecycle input", () => {
  const root = tmpDir("skill-lifecycle-refuse-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  const skillPath = approveSkill(skillsDir);
  const output: string[] = [];
  const errors: string[] = [];
  const deps = {
    stateDir: "/state",
    registryPath,
    approvedSkillsDir: skillsDir,
    write: (line: string) => output.push(line),
    error: (line: string) => errors.push(line),
  };

  assert.equal(skillLifecycleCommand(["procedure"], {
    ...deps,
    readLedger: (() => union([], { ok: false, unread: ["/state/ledger.bad.ndjson.gz"] })) as any,
  }), 1);
  assert.match(errors.pop() ?? "", /REFUSED incomplete ledger union/);

  assert.equal(skillLifecycleCommand(["missing"], {
    ...deps,
    readLedger: (() => union(rows(Array(10).fill("blocked_ci"), Array(10).fill("merged"), "missing"))) as any,
  }), 1);
  assert.match(errors.pop() ?? "", /not approved and opted in/);

  assert.equal(skillLifecycleCommand(["procedure"], {
    ...deps,
    readLedger: (() => union(rows(Array(9).fill("merged"), Array(10).fill("blocked_ci")))) as any,
  }), 1);
  assert.match(errors.pop() ?? "", /below horizon/);
  assert.equal(loadProposalRegistry(registryPath).length, 0);
  assert.equal(readFileSync(skillPath, "utf8").includes("Do the thing."), true);
});

test("W1-T3413 lifecycle CLI usage and unreadable-ledger arms write no proposal", () => {
  const root = tmpDir("skill-lifecycle-cli-refuse-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  approveSkill(skillsDir);
  const errors: string[] = [];
  const deps = {
    stateDir: "/state",
    registryPath,
    approvedSkillsDir: skillsDir,
    write: () => {},
    error: (line: string) => errors.push(line),
    readLedger: (() => {
      throw new Error("no ledger access");
    }) as any,
  };

  assert.equal(skillLifecycleCommand([], deps), 2);
  assert.match(errors.pop() ?? "", /usage: rmd skill lifecycle/);
  assert.equal(skillLifecycleCommand(["--flag"], deps), 2);
  assert.match(errors.pop() ?? "", /usage: rmd skill lifecycle/);
  assert.equal(skillLifecycleCommand(["procedure", "extra"], deps), 2);
  assert.match(errors.pop() ?? "", /unexpected argument/);
  assert.equal(skillLifecycleCommand(["procedure"], deps), 1);
  assert.match(errors.pop() ?? "", /REFUSED unreadable ledger union: Error: no ledger access/);
  assert.equal(loadProposalRegistry(registryPath).length, 0);
});

test("W1-T3413 stages one retire proposal", () => {
  const root = tmpDir("skill-lifecycle-stage-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  approveSkill(skillsDir);

  const first = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")], [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")]),
  );
  assert.equal(first.refused, false);
  assert.equal(first.staged, true);
  assert.equal(first.alreadyStaged, false);

  const second = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")], [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")]),
  );
  assert.equal(second.staged, false);
  assert.equal(second.alreadyStaged, true);

  const proposals = loadProposalRegistry(registryPath);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, skillLifecycleProposalId("procedure"));
  assert.equal(proposals[0].lifecycleAction?.kind, "skill-retirement");
  assert.match(proposals[0].summary, /Basis: not-better-than-control/);
});

test("W1-T3413 refreshes lifecycle evidence", () => {
  const root = tmpDir("skill-lifecycle-refresh-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  approveSkill(skillsDir);

  const first = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")], [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")]),
  );
  const refreshed = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(9).fill("merged"), "failed"], Array(10).fill("blocked_ci")),
  );

  assert.equal(refreshed.refreshed, true);
  assert.notEqual(refreshed.evidenceFingerprint, first.evidenceFingerprint);
  const proposals = loadProposalRegistry(registryPath);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].lifecycleAction?.evidenceFingerprint, refreshed.evidenceFingerprint);
  assert.match(proposals[0].summary, /Basis: named-harm-signal/);
});

test("W1-T3413 approve owns precise removal", () => {
  const root = tmpDir("skill-lifecycle-approve-");
  const skillsDir = join(root, ".claude", "skills");
  const skillPath = approveSkill(skillsDir);
  const keepPath = approveSkill(skillsDir, "keep");
  const staged = stageSkillLifecycleProposal(
    join(root, "inbox-proposals.json"),
    skillsDir,
    report([], Array(10).fill("blocked_ci")),
  );
  assert.equal(staged.staged, true);
  const proposal = loadProposalRegistry(join(root, "inbox-proposals.json"))[0] as Proposal;
  const classification = classifyProposal(proposal, undefined, {
    plan: { tasks: [], byId: new Map() },
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set([proposal.id]),
    isRatified: () => false,
  });

  assert.equal(classification.state, "ready");
  assert.equal(classification.draft, undefined);
  assert.equal(classification.lifecycleAction?.skillPath, ".claude/skills/procedure/SKILL.md");
  assert.deepEqual(proposalsNeedingDraft([proposal], {}), []);

  const removed = applySkillLifecycleRemoval(root, classification.lifecycleAction!);
  assert.deepEqual(removed, { ok: true, removedPath: ".claude/skills/procedure/SKILL.md" });
  assert.equal(existsSync(skillPath), false);
  assert.equal(existsSync(keepPath), true);
});

test("W1-T3413 approve renders lifecycle commit and PR text from the staged action", () => {
  const action = {
    kind: "skill-retirement" as const,
    skillName: "procedure",
    skillPath: ".claude/skills/procedure/SKILL.md",
    evidenceFingerprint: "fp-123",
  };

  assert.match(skillLifecycleApproveCommitMessage(action, "skill-lifecycle:procedure"), /retire approved skill via rmd approve/);
  assert.match(skillLifecycleApproveCommitMessage(action, "skill-lifecycle:procedure"), /Evidence fingerprint: fp-123/);
  const body = skillLifecyclePrBody(action, "skill-lifecycle:procedure");
  assert.match(body, /## Acceptance/);
  assert.match(body, /Removes exactly `.claude\/skills\/procedure\/SKILL.md`/);
  assert.match(body, /Evidence fingerprint: `fp-123`/);
});

test("W1-T3413 approve refuses a lifecycle proposal that is no longer ready before touching git", async () => {
  const root = tmpDir("skill-lifecycle-approve-refuse-");
  mkdirSync(join(root, "state"), { recursive: true });
  const proposal = {
    id: "skill-lifecycle:procedure",
    summary: "retire procedure",
    evidenceAnchors: [],
    trigger: { kind: "ci-red" as const, pr: 1, fired: false },
    lifecycleAction: {
      kind: "skill-retirement" as const,
      skillName: "procedure",
      skillPath: ".claude/skills/procedure/SKILL.md",
      evidenceFingerprint: "fp-refused",
    },
  };
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }, null, 2), "utf8");

  const code = await approveCommand(["skill-lifecycle:procedure"], { config: { claudeBin: "/usr/bin/true", root } as never });

  assert.equal(code, 1);
  const lines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((line) => line.step),
    ["ratify.approve_refused"],
  );
  assert.equal(lines[0].state, "deferred_with_trigger");
});

test("W1-T3413 approve opens a reviewed lifecycle PR that deletes only the approved skill", async () => {
  const bare = makeLifecycleOrigin();
  const root = tmpDir("skill-lifecycle-approve-command-");
  const shim = ghShim([
    { when: "headRefName", stdout: '{"headRefName":"main"}' },
    { when: "pulls", stdout: '{"html_url":"https://github.com/craigoley/remudero/pull/73413","number":73413}' },
  ], { kind: "skill-lifecycle-gh" });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${savedPath}`;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(root, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare.dir, repoDir], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox-proposals.json"),
      JSON.stringify(
        {
          proposals: [
            {
              id: "skill-lifecycle:procedure",
              summary: "retire procedure",
              evidenceAnchors: [],
              lifecycleAction: {
                kind: "skill-retirement",
                skillName: "procedure",
                skillPath: ".claude/skills/procedure/SKILL.md",
                evidenceFingerprint: "fp-approved",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const code = await withLiveWritesAllowed(() =>
      approveCommand(["skill-lifecycle:procedure"], { config: { claudeBin: "/usr/bin/true", root } as never }),
    );

    assert.equal(code, 1, "the ownership guard stops the offline fixture after the lifecycle PR is opened");
    const refs = execFileSync("git", ["-C", bare.dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    assert.equal(refs.length, 1, `expected one lifecycle approve branch, got ${JSON.stringify(refs)}`);
    assert.throws(
      () => execFileSync("git", ["-C", bare.dir, "show", `${refs[0]}:.claude/skills/procedure/SKILL.md`], { encoding: "utf8" }),
      /does not exist/,
    );
    const commit = execFileSync("git", ["-C", bare.dir, "log", "-1", "--format=%B", refs[0]], { encoding: "utf8" });
    assert.match(commit, /Evidence fingerprint: fp-approved/);

    const lines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(lines.some((line) => line.step === "ratify.approved" && line.lifecycle_action === "skill-retirement"));
    assert.ok(lines.some((line) => line.verdict === "pr_attribution_failed"));
    assert.deepEqual(loadProposalRegistry(join(root, "state", "inbox-proposals.json")), []);
  } finally {
    process.env.PATH = savedPath;
    bare.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3413 review stays read only", () => {
  const root = tmpDir("skill-lifecycle-review-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  const skillPath = approveSkill(skillsDir);

  const result = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(8).fill("merged"), ...Array(2).fill("blocked_ci")], [...Array(3).fill("merged"), ...Array(7).fill("blocked_ci")]),
  );

  assert.equal(result.refused, true);
  assert.match(result.reason ?? "", /REVIEW-CANDIDATE is read-only/);
  assert.equal(loadProposalRegistry(registryPath).length, 0);
  assert.equal(existsSync(skillPath), true);
});

test("W1-T3413 mutation rejects arbitrary removal", () => {
  const root = tmpDir("skill-lifecycle-mutation-");
  const skillsDir = join(root, ".claude", "skills");
  const skillPath = approveSkill(skillsDir);
  const otherPath = approveSkill(skillsDir, "other");
  const missingPath = applySkillLifecycleRemoval(
    root,
    {
      kind: "skill-retirement",
      skillName: "procedure",
      skillPath: ".claude/skills/procedure/SKILL.md",
      evidenceFingerprint: "missing",
    },
    { approved: () => true, exists: () => false },
  );
  const badPath = applySkillLifecycleRemoval(root, {
    kind: "skill-retirement",
    skillName: "procedure",
    skillPath: ".claude/skills/other/SKILL.md",
    evidenceFingerprint: "bad",
  });
  const badName = applySkillLifecycleRemoval(root, {
    kind: "skill-retirement",
    skillName: "not-approved",
    skillPath: ".claude/skills/not-approved/SKILL.md",
    evidenceFingerprint: "bad",
  });

  assert.deepEqual(missingPath, { ok: false, reason: "missing .claude/skills/procedure/SKILL.md" });
  assert.equal(badPath.ok, false);
  assert.equal(badName.ok, false);
  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(otherPath), true);
});
