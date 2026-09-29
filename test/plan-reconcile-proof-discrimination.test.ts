import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { landPlanReconcileShards } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "plan-proof-test",
  GIT_AUTHOR_EMAIL: "plan-proof-test@example.invalid",
  GIT_COMMITTER_NAME: "plan-proof-test",
  GIT_COMMITTER_EMAIL: "plan-proof-test@example.invalid",
};

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", env: gitEnv });
}

test("W1-T4753 plan reconciliation proves YAML status field instead of prose", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-proof-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const root = join(dir, "root");
  const relPath = "plan/tasks.d/W1-T4753.yaml";
  const baseContent = "- id: W1-T4753\n  status: queued\n  rationale: |\n    Another task has `status: merged` already.\n";
  const headContent = baseContent.replace("  status: queued\n", "  status: merged\n");

  try {
    git(["init", "--quiet", "--bare", "-b", "main", origin]);
    git(["init", "--quiet", "-b", "main", seed]);
    mkdirSync(dirname(join(seed, relPath)), { recursive: true });
    writeFileSync(join(seed, relPath), baseContent);
    git(["-C", seed, "add", "-A"]);
    git(["-C", seed, "commit", "--quiet", "-m", "chore: seed queued task with misleading prose"]);
    git(["-C", seed, "remote", "add", "origin", origin]);
    git(["-C", seed, "push", "--quiet", "origin", "main"]);
    git(["clone", "--quiet", origin, root]);

    const calls: string[][] = [];
    const gh = (args: string[]): string => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/4753\n";
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };
    const result = withLiveWritesAllowed(() =>
      landPlanReconcileShards(root, [{ relPath, content: headContent }], {
        gh,
        targetRepository: { owner: "o", repo: "r" },
        landingOwner: "measurement-cadence",
      }),
    );
    assert.equal(result.landed, true, result.error);

    const create = calls.find((args) => args[0] === "pr" && args[1] === "create");
    assert.ok(create, "landing must open a PR");
    const body = create[create.indexOf("--body") + 1];
    const head = create[create.indexOf("--head") + 1];
    const proof = body.match(/^-.+ \| grep: (.+) in (plan\/tasks\.d\/W1-T4753\.yaml)$/m);
    assert.ok(proof, "generated acceptance must retain a per-shard grep proof");
    const [, pattern, proofPath] = proof;
    assert.equal(proofPath, relPath);
    assert.equal(pattern, "^  status: merged$", "proof must select the YAML field, not rationale prose");

    const base = join(dir, "base");
    const changed = join(dir, "changed");
    for (const [checkout, ref] of [[base, "main"], [changed, head]]) {
      const target = join(checkout, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, git(["--git-dir", origin, "show", `${ref}:${relPath}`]));
    }
    assert.match(readFileSync(join(base, relPath), "utf8"), /status: merged/, "base must contain the misleading prose");
    const grepStatus = (cwd: string, value: string) => spawnSync("grep", ["-arn", "--", value, relPath], { cwd, encoding: "utf8" }).status;
    assert.equal(grepStatus(base, "status: merged"), 0, "the old proof falsely passed on base");
    assert.equal(grepStatus(base, pattern), 1, "the generated proof must fail on base");
    assert.equal(grepStatus(changed, pattern), 0, "the generated proof must pass on the changed field");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
