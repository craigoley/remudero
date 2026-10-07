// W1-T6064 — the exact Node pin (ADR 0002) moves .nvmrc and deploy/Dockerfile's FROM together, and
// Dependabot's /deploy docker lane edits only FROM. The daemon's dep-review lane syncs a same-major bump onto
// its pull request with the App token it already holds (W1-T6258).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isDependencyDeclarationPath } from "../src/lib/dep-review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @ts-expect-error The head identity gate is an executable .mjs module outside tsconfig.
import { isDependencyBumpHead } from "../scripts/head-identity-gate.mjs";

const SCRIPT = join(process.cwd(), "scripts", "node-pin-follows-the-image.mjs");
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

// Operator ruling 2026-10-07: the daemon already holds the App token, so nothing may ask for a fleet App key
// stored as a GitHub secret; W1-T6258 moves the sync into the dep-review lane.
test("no workflow asks GitHub secrets for the fleet App's key", () => {
  const dir = join(process.cwd(), ".github", "workflows");
  const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(workflows.length > 10, "the census must read the real workflow directory");
  const asking = workflows.filter((name) => /secrets\.RMD_FLEET_APP_(PRIVATE_KEY|CLIENT_ID)/.test(readFileSync(join(dir, name), "utf8")));
  assert.deepEqual(asking, []);
});
