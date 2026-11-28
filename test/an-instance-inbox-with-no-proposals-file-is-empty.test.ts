import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { instanceStateRoot } from "#src/lib/instance-gateway.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Context = { after(fn: () => void): void };
// An instance that has never written a proposal: a ledger and a plan, but no state/inbox-proposals.json.
function instanceWithNoProposalsFile(t: Context) {
  const base = makeTempDir("rmd-instance-no-proposals");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = instanceStateRoot({ name: "arcade", repo: "owner/arcade", project: "fixture", live: true }, base);
  const checkout = join(root.root, "repos", "arcade");
  mkdirSync(dirname(checkout), { recursive: true });
  const repository = gitRepo();
  t.after(() => repository.cleanup());
  const tree = repository.addWorktree(checkout, "arcade");
  mkdirSync(join(root.root, "state"), { recursive: true });
  mkdirSync(dirname(root.planPath), { recursive: true });
  writeFileSync(root.planPath, "[]\n");
  writeFileSync(root.ledgerPath, "");
  tree.git("add", ".");
  tree.git("commit", "--allow-empty", "-m", "fixture");
  const deps = { root: checkout, planPath: root.planPath, ledgerPath: root.ledgerPath, inboxRoot: root.root,
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve() {}, reframe() {} },
    inboxSourceIdentity: { instance: "arcade", repository: "owner/arcade", root: checkout, planPath: root.planPath,
      ledgerPath: root.ledgerPath, inboxRoot: root.root } };
  return { root, deps, registry: join(root.root, "state/inbox-proposals.json") };
}

test("W1-T15180 criterion 1: an instance inbox with no proposals file classifies as an empty inbox", async t => {
  const { deps } = instanceWithNoProposalsFile(t);
  const first = await refreshInboxClassification(deps, {});
  assert.equal(first.proposals, 0);
  const memo = {};
  await refreshInboxClassification(deps, memo);
  assert.equal((await refreshInboxClassification(deps, memo)).changed, false, "a still-missing registry is a stable input");
});

test("W1-T15180 criterion 2: a malformed registry, a missing ledger or a missing plan still fails", async t => {
  {
    const { deps, registry } = instanceWithNoProposalsFile(t);
    writeFileSync(registry, "{broken");
    await assert.rejects(refreshInboxClassification(deps, {}), /instance inbox registry is unavailable|JSON/);
  }
  {
    const { deps, root } = instanceWithNoProposalsFile(t);
    rmSync(root.ledgerPath);
    await assert.rejects(refreshInboxClassification(deps, {}), /ENOENT/);
  }
  {
    const { deps, root } = instanceWithNoProposalsFile(t);
    rmSync(root.planPath);
    await assert.rejects(refreshInboxClassification(deps, {}), /ENOENT/);
  }
  {
    const { deps, registry } = instanceWithNoProposalsFile(t);
    mkdirSync(registry);
    await assert.rejects(refreshInboxClassification(deps, {}), /not a regular file/);
  }
});
