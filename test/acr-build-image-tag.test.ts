import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

// ── recon-2026-09-05 R-48: a release IS an image build, so it must leave a git-visible tag ──
//
// The operator ruled (docs/audits/recon-2026-09-05.md, folded into README.md/CHANGELOG.md/
// CONTRIBUTING.md by #4079): this project is pre-alpha, there are no semver releases, and "a
// release" is an image build. `.github/workflows/acr-build.yml` builds and pushes the image but
// left no trace in git of WHICH commits were ever built — `/etc/rmd-build-sha` only answers that
// question from inside a running container. This suite pins the "Tag the build" step that closes
// that gap, reading the real workflow file (never a copied fixture) so a later edit is what this
// suite actually reads.

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  with?: { inlineScript?: string };
}

interface Workflow {
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

const workflowPath = new URL("../.github/workflows/acr-build.yml", import.meta.url);

function workflow(): Workflow {
  return parseYaml(readFileSync(workflowPath, "utf8")) as Workflow;
}

function step(name: string): WorkflowStep {
  const jobs = workflow().jobs ?? {};
  for (const job of Object.values(jobs)) {
    const found = job.steps?.find((s) => s.name === name);
    if (found) return found;
  }
  throw new Error(`no step named ${JSON.stringify(name)} found in acr-build.yml`);
}

test("the 'Tag the build' step exists, right after the build/push step", () => {
  const build = workflow().jobs?.build;
  assert.ok(build, "expected a 'build' job in acr-build.yml");
  const names = (build!.steps ?? []).map((s) => s.name);
  const pushIdx = names.indexOf("Build and push (ACR)");
  const tagIdx = names.indexOf("Tag the build");
  assert.ok(pushIdx >= 0, "expected a 'Build and push (ACR)' step");
  assert.ok(tagIdx >= 0, "expected a 'Tag the build' step");
  assert.equal(tagIdx, pushIdx + 1, "the tag step must come immediately after the build/push step");
});

test("the tag step is guarded on the build/push step's own outcome — deleting the guard must fail this test", () => {
  const push = step("Build and push (ACR)");
  assert.equal(push.id, "build_push", "the build/push step must carry a stable id for the guard to reference");

  const tag = step("Tag the build");
  assert.equal(
    tag.if,
    "steps.build_push.outcome == 'success'",
    "the tag step must be gated on steps.build_push.outcome — removing this guard must never let " +
      "the step tag a commit whose build or push failed",
  );
});

test("the tag step reuses the exact sha expression stamped as RMD_BUILD_SHA — never a recomputed one", () => {
  const push = step("Build and push (ACR)");
  const buildScript = push.with?.inlineScript ?? "";
  assert.match(
    buildScript,
    /--build-arg "RMD_BUILD_SHA=\$\{GITHUB_SHA\}"/,
    "expected the build step to stamp RMD_BUILD_SHA from ${GITHUB_SHA} — this is the value the " +
      "tag step must reuse verbatim",
  );

  const tagScript = step("Tag the build").run ?? "";
  assert.match(
    tagScript,
    /SHORT_SHA="\$\{GITHUB_SHA:0:7\}"/,
    "the tag step must derive its short sha from ${GITHUB_SHA} — the same expression the build " +
      "step stamps into the image, not a recomputed git rev-parse or similar",
  );
  assert.match(
    tagScript,
    /git tag -a "\$\{TAG_NAME\}" -m "[^"]*\$\{GITHUB_SHA\}[^"]*" "\$\{GITHUB_SHA\}"/,
    "the tag step must annotate and point the tag at ${GITHUB_SHA} itself",
  );
});

test("the tag name is image/<yyyymmdd>-<7-char sha> and the step is idempotent on a repeat run", () => {
  const tagScript = step("Tag the build").run ?? "";
  assert.match(
    tagScript,
    /TAG_NAME="image\/\$\(date -u \+%Y%m%d\)-\$\{SHORT_SHA\}"/,
    "expected the tag name to be image/<yyyymmdd>-<7-char sha>",
  );
  assert.match(
    tagScript,
    /git ls-remote --exit-code --tags origin "refs\/tags\/\$\{TAG_NAME\}"/,
    "the step must check whether the tag already exists on origin before creating it, so a re-run " +
      "on the same sha (same tag name) does not fail on an existing ref",
  );
  assert.match(tagScript, /exit 0/, "an already-existing tag must be a clean no-op, not a failure");
});

test("only the build job carries contents: write — the workflow's top-level block stays read-only", () => {
  const parsed = workflow();
  assert.equal(parsed.permissions?.contents, "read", "the top-level permissions block must stay least-privilege");
  assert.equal(parsed.permissions?.["id-token"], "write");

  const jobs = parsed.jobs ?? {};
  const jobIds = Object.keys(jobs);
  assert.deepEqual(jobIds, ["build"], "expected exactly one job in acr-build.yml — if this changes, re-check which job needs contents: write");

  assert.equal(jobs.build?.permissions?.contents, "write", "the build job must elevate to contents: write to push the tag");
  assert.equal(jobs.build?.permissions?.["id-token"], "write", "azure/login still needs id-token: write at job scope");
});
