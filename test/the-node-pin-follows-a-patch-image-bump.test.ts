// W1-T6064 — the exact Node pin (ADR 0002) moves .nvmrc and deploy/Dockerfile's FROM together, and
// Dependabot's /deploy docker lane edits only FROM. A same-major bump is synced onto its pull request
// by a workflow that pushes with the fleet App's token (a GITHUB_TOKEN push starts no new CI run).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { isDependencyDeclarationPath } from "../src/lib/dep-review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @ts-expect-error The head identity gate is an executable .mjs module outside tsconfig.
import { isDependencyBumpHead } from "../scripts/head-identity-gate.mjs";

const SCRIPT = join(process.cwd(), "scripts", "node-pin-follows-the-image.mjs");
const WORKFLOW = join(process.cwd(), ".github", "workflows", "node-pin-follows-the-image.yml");
const DIGEST = `sha256:${"a".repeat(64)}`;

function pinFixture(fromVersion: string, pinned = "24.21.0"): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}node-pin-`));
  execFileSync("mkdir", ["-p", join(root, "deploy")]);
  writeFileSync(join(root, "deploy", "Dockerfile"), `# syntax=docker/dockerfile:1\nFROM node:${fromVersion}-bookworm-slim@${DIGEST}\nUSER node\n`);
  writeFileSync(join(root, ".nvmrc"), `${pinned}\n`);
  return root;
}

function sync(root: string) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
}

test("W1-T6064: a same-major image bump moves the pin and a major is refused", () => {
  const patch = pinFixture("24.22.0");
  const moved = sync(patch);
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(readFileSync(join(patch, ".nvmrc"), "utf8"), "24.22.0\n", "the pin follows the image within its major");
  assert.match(moved.stdout, /24\.21\.0 -> 24\.22\.0/);

  const again = sync(patch);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already/, "a synced pin is left alone, so the workflow's own push ends the loop");

  const major = pinFixture("25.1.0");
  const refused = sync(major);
  assert.equal(refused.status, 1, "a major is a plan change (W1-T6063), never a sync");
  assert.match(refused.stderr, /major/);
  assert.equal(readFileSync(join(major, ".nvmrc"), "utf8"), "24.21.0\n", "a refused major leaves the pin untouched");
});

test("W1-T6064: a Dockerfile with no single node FROM is refused, never read as in sync", () => {
  const root = pinFixture("24.21.0");
  writeFileSync(join(root, "deploy", "Dockerfile"), `FROM debian:bookworm-slim@${DIGEST}\n`);
  const run = sync(root);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /FROM node:/);
});

test("W1-T6064: the synced bump stays a dependency-only head the identity gate admits", () => {
  assert.equal(isDependencyDeclarationPath(".nvmrc"), true, "the runtime pin is a dependency declaration");
  assert.equal(isDependencyBumpHead({
    headRef: "dependabot/docker/deploy/node-24.22.0-bookworm-slim",
    subject: "chore(deps): .nvmrc follows the image's Node 24.22.0",
    changedPaths: ["deploy/Dockerfile", ".nvmrc"],
  }), true);
});

test("W1-T6064: the workflow syncs only Dependabot's Dockerfile bumps and pushes with the fleet App token", () => {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as {
    on: { pull_request: { paths: string[] } };
    jobs: Record<string, { if: string; steps: Array<{ id?: string; if?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }> }>;
  };
  assert.deepEqual(workflow.on.pull_request.paths, ["deploy/Dockerfile"]);
  const [job] = Object.values(workflow.jobs);
  assert.ok(job, "one sync job");
  assert.match(job.if, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
  const steps = job.steps;
  const syncStep = steps.findIndex((s) => s.run?.includes("node scripts/node-pin-follows-the-image.mjs"));
  const tokenStep = steps.findIndex((s) => s.uses?.startsWith("actions/create-github-app-token@"));
  const pushStep = steps.findIndex((s) => s.run?.includes("git push"));
  assert.ok(syncStep >= 0 && tokenStep > syncStep && pushStep > tokenStep, "sync, then mint, then push");
  assert.match(readFileSync(WORKFLOW, "utf8"), /uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d/, "the action is pinned by SHA like every other");
  assert.match(steps[tokenStep]!.if ?? "", /drift/, "no token is minted when the pin is already in sync");
  assert.match(JSON.stringify(steps[tokenStep]!.with), /secrets\.RMD_FLEET_APP_PRIVATE_KEY/);
  assert.match(steps[pushStep]!.run!, /steps\.app-token\.outputs\.token|APP_TOKEN/);
  const guard = steps.find((s) => s.run?.includes("RMD_FLEET_APP_PRIVATE_KEY") && s.run.includes("exit 1"));
  assert.ok(guard, "a missing Dependabot secret fails the job and names it, never a silent skip");
});
