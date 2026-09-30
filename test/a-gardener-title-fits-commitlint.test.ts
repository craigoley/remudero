/**
 * 2026-09-29..30: the ci-friction gardener's filing was refused seven times by commitlint — its title
 * `chore(plan): the ci-friction gardener drafts a fix for fix_refusal:no-anchored-commit-message-line-in-the-report`
 * is 112 characters and the header limit is 100. Every gardener lands through `gardenCheckout.land`,
 * so the header is fitted there, at a word boundary, with the full title carried in the bodies.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { CONVENTIONAL_LIMITS, fitConventionalTitle } from "../src/lib/commit-message.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gardenCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITLINT = join(REPO_ROOT, "node_modules", ".bin", "commitlint");
const CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

/** Real cause names from the ci-friction gardener's 2026-09-30 inventory. */
const REAL_CAUSES = [
  "fix_refusal:no-anchored-commit-message-line-in-the-report",
  "fix_refusal:the-task-declares-no-files-so-there-is-no-surface-to-stage",
  "fix_refusal:every-change-the-worker-made-is-outside-its-declared-files",
];
const titleFor = (cause: string) => `chore(plan): the ci-friction gardener drafts a fix for ${cause}`;

function lint(message: string) {
  return spawnSync(COMMITLINT, ["--config", CONFIG], { input: message, encoding: "utf8", cwd: REPO_ROOT });
}

test("fitConventionalTitle keeps the prefix and cuts a real cause name at a hyphen", () => {
  for (const cause of REAL_CAUSES) {
    const title = titleFor(cause);
    assert.ok(title.length > CONVENTIONAL_LIMITS.headerMaxLength, `the fixture really is too long: ${title.length}`);
    const { header, trimmed } = fitConventionalTitle(title);
    assert.equal(trimmed, true);
    assert.ok(header.length <= CONVENTIONAL_LIMITS.headerMaxLength, `${header.length}: ${header}`);
    assert.ok(header.startsWith("chore(plan): the ci-friction gardener drafts a fix for fix_refusal:"), header);
    assert.ok(header.endsWith("…"), header);
    const kept = header.slice(0, -1);
    assert.ok(title.startsWith(kept), "the header is a prefix of the title, never a rewrite");
    assert.ok(["-", " "].includes(title[kept.length]), `cut at a word boundary: ${header}`);
    assert.equal(lint(`${header}\n`).status, 0, `real commitlint accepts ${header}`);
  }
});

test("fitConventionalTitle leaves a short title alone and hard-cuts a title with no boundary", () => {
  assert.deepEqual(fitConventionalTitle("chore(plan): short"), { header: "chore(plan): short", trimmed: false });
  const solid = "x".repeat(130);
  const fitted = fitConventionalTitle(solid);
  assert.equal(fitted.header.length, CONVENTIONAL_LIMITS.headerMaxLength);
  assert.equal(fitted.header, `${"x".repeat(99)}…`);
});

function gardenFixture() {
  const seed = gitRepo({ kind: "garden-title-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: "garden-title-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "garden-title-clone" });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  // The same gate the daemon's garden worktrees run: a commit-msg hook calling real commitlint.
  const hooks = join(clone.dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "commit-msg");
  writeFileSync(hook, `#!/bin/sh\nexec "${COMMITLINT}" --config "${CONFIG}" --edit "$1"\n`);
  chmodSync(hook, 0o755);
  return {
    clone,
    origin,
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      clone.cleanup();
    },
  };
}

test("a gardener landing a real long cause name passes commitlint and carries the full title", () => {
  const f = gardenFixture();
  const posted: string[][] = [];
  const title = titleFor(REAL_CAUSES[1]);
  const ws = gardenCheckout({
    name: "ci-friction",
    repoDir: f.clone.dir,
    worktreesRoot: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-title-wt-`)),
    owner: "acme",
    repo: "remudero",
    log: () => {},
    clock: fixedClock(1790000000003),
    fetcher: (args) => {
      posted.push(args);
      return { html_url: "https://github.com/acme/remudero/pull/3", number: 3 };
    },
  });
  try {
    writeFileSync(join(ws.root, "shard.yaml"), "- id: W1-T9\n");
    const url = withLiveWritesAllowed(() => ws.land({ paths: ["shard.yaml"], title, body: "## Acceptance" }));
    assert.equal(url, "https://github.com/acme/remudero/pull/3");
    const message = f.origin.git("log", "-1", "--format=%B", "ci-friction-garden-1790000000003");
    const header = message.split("\n")[0];
    assert.ok(header.length <= CONVENTIONAL_LIMITS.headerMaxLength, header);
    assert.match(message.replace(/\n/g, " "), /Full title: chore\(plan\): the ci-friction gardener drafts a fix for fix_refusal:the-task-declares-no-files-so-there-is-no-surface-to-stage/);
    const flat = posted.flat().join("\n");
    assert.ok(flat.includes(`title=${header}`), `the PR title is the fitted header: ${flat}`);
    assert.ok(flat.includes(`Full title: ${title}`), "the PR body carries the full title");
  } finally {
    ws.dispose();
    f.cleanup();
  }
});
