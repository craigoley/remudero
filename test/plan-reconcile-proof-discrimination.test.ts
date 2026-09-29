import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { landPlanReconcileShards } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

test("W1-T4753 criterion 1: plan reconciliation proves YAML status field instead of prose", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-proof-"));
  const origin = gitRepo({ bare: true, kind: "plan-proof-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "plan-proof-seed" });
  let root: ReturnType<typeof gitRepo> | undefined;
  const relPath = "plan/tasks.d/W1-T4753.yaml";
  const baseContent = "- id: W1-T4753\n  status: queued\n  rationale: |\n    Another task has `status: merged` already.\n";
  const headContent = baseContent.replace("  status: queued\n", "  status: merged\n");

  try {
    mkdirSync(dirname(join(seed.dir, relPath)), { recursive: true });
    writeFileSync(join(seed.dir, relPath), baseContent);
    seed.git("add", "-A");
    seed.git("commit", "--quiet", "-m", "chore: seed queued task with misleading prose");
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    root = gitRepo({ cloneFrom: origin.dir, kind: "plan-proof-root" });

    const calls: string[][] = [];
    const gh = (args: string[]): string => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/4753\n";
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };
    const result = withLiveWritesAllowed(() =>
      landPlanReconcileShards(root!.dir, [{ relPath, content: headContent }], {
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
      writeFileSync(target, origin.git("show", `${ref}:${relPath}`));
    }
    assert.match(readFileSync(join(base, relPath), "utf8"), /status: merged/, "base must contain the misleading prose");
    const grepStatus = (cwd: string, value: string) => spawnSync("grep", ["-arn", "--", value, relPath], { cwd, encoding: "utf8" }).status;
    assert.equal(grepStatus(base, "status: merged"), 0, "the old proof falsely passed on base");
    assert.equal(grepStatus(base, pattern), 1, "the generated proof must fail on base");
    assert.equal(grepStatus(changed, pattern), 0, "the generated proof must pass on the changed field");
  } finally {
    root?.cleanup();
    seed.cleanup();
    origin.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
