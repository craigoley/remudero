import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  decideDispatchClaim, dispatchClaimRef, gitClaimRunnerAsync, gitDispatchClaimReserver,
  gitDispatchClaimReserverAsync, type GitAnswer,
} from "#src/lib/dispatch-claim.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12525: a claim of a ref that origin already holds was a non-fast-forward push. git leaves a
// rejected ref out of the pre-push hook's stdin, so the hook ran every content check (10 to 45
// minutes on the Azure host) before git refused the push as taken. `attempt` now reads the ref first.

const TASK = "W1-T9701";
const REF = dispatchClaimRef(TASK);
const HELD = "c".repeat(40);
const MINE = "d".repeat(40);
const OK = (stdout = ""): GitAnswer => ({ status: 0, stdout, stderr: "" });

/** A fake git whose ls-remote answers `listed`, whose push answers `pushed`, and which records every argv. */
function scriptedGit(listed: GitAnswer, pushed: GitAnswer = OK()) {
  const calls: string[][] = [];
  const answer = (args: string[]): GitAnswer => {
    calls.push(args);
    if (args[0] === "remote") return OK("/tmp/a-local-origin.git\n");
    if (args[0] === "ls-remote") return listed;
    if (args[0] === "push") return pushed;
    return OK();
  };
  return {
    calls,
    pushes: () => calls.filter((c) => c[0] === "push"),
    sync: () => gitDispatchClaimReserver({ run: answer }),
    awaited: () => gitDispatchClaimReserverAsync({ run: async (args) => answer(args) }),
  };
}

test("W1-T12525 criterion 1: a held claim ref is taken with no push, and the refusal names the holder", async () => {
  const listed = OK(`${HELD}\t${REF}\n`);
  const sync = scriptedGit(listed);
  const reserver = sync.sync();
  assert.equal(reserver.attempt(TASK, MINE), "taken");
  assert.equal(sync.pushes().length, 0, "the sync reserver must not push a ref origin already holds");
  assert.ok(sync.calls.some((c) => c.join(" ") === `ls-remote origin ${REF}`), "the check reads the claim ref itself");
  const reason = decideDispatchClaim("taken", { taskId: TASK, holder: reserver.holder(TASK) }).reason;
  assert.match(reason, new RegExp(`held by ${HELD}`));

  const awaited = scriptedGit(listed);
  const asyncReserver = awaited.awaited();
  assert.equal(await asyncReserver.attempt(TASK, MINE), "taken");
  assert.equal(awaited.pushes().length, 0, "the async reserver must not push a ref origin already holds");
  assert.match(decideDispatchClaim("taken", { taskId: TASK, holder: await asyncReserver.holder(TASK) }).reason, new RegExp(HELD));
});

test("W1-T12525 criterion 2: a free claim ref is pushed create-only, and a lost race is still taken", async (t) => {
  for (const make of ["sync", "awaited"] as const) {
    const free = scriptedGit(OK());
    assert.equal(await free[make]().attempt(TASK, MINE), "created", make);
    assert.deepEqual(free.pushes(), [["push", "origin", `${MINE}:${REF}`]], `${make}: the push is unchanged`);
    for (const arg of free.pushes()[0]!) {
      assert.ok(!arg.startsWith("+") && !arg.startsWith("--force"), `${make}: no forced update in ${arg}`);
    }
    const raced = scriptedGit(OK(), { status: 1, stdout: "", stderr: ` ! [rejected]        ${MINE} -> ${REF} (fetch first)\n` });
    assert.equal(await raced[make]().attempt(TASK, MINE), "taken", `${make}: a push that loses the race reads taken`);
  }

  // Real git: the ref appears between the check and the push. The create-only push is refused and
  // the holder's anchor stays on origin.
  const origin = gitRepo({ bare: true, scope: t, kind: "claim-race-origin" });
  const client = gitRepo({ scope: t, kind: "claim-race-client" });
  client.addRemote("origin", origin.dir);
  const tree = client.git("rev-parse", "HEAD^{tree}");
  const holder = client.git("commit-tree", tree, "-m", "rmd-dispatch claim 1@holder 2026-01-01T00:00:00.000Z");
  const late = client.git("commit-tree", tree, "-m", "rmd-dispatch claim 2@late 2026-01-01T00:00:01.000Z");
  const real = realGit(client.dir);
  let first = true;
  const racing = gitDispatchClaimReserver({
    run: (args) => {
      if (args[0] === "ls-remote" && first) {
        first = false;
        const before = real(args);
        client.git("push", "origin", `${holder}:${REF}`);
        return before;
      }
      return real(args);
    },
  });
  assert.equal(racing.attempt(TASK, late), "taken");
  assert.equal(origin.git("rev-parse", REF), holder, "the create-only push never overwrites the holder");
});

test("W1-T12525 criterion 3: a failed ls-remote is unreachable, keeps git's stderr, and pushes nothing", async () => {
  const failed: GitAnswer = { status: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'\n" };
  const sync = scriptedGit(failed);
  const reserver = sync.sync();
  assert.equal(reserver.attempt(TASK, MINE), "unreachable");
  assert.match(String(reserver.lastAttemptStderr?.()), /could not read Username/);
  assert.equal(sync.pushes().length, 0);

  const awaited = scriptedGit(failed);
  const asyncReserver = awaited.awaited();
  assert.equal(await asyncReserver.attempt(TASK, MINE), "unreachable");
  assert.match(String(asyncReserver.lastAttemptStderr?.()), /could not read Username/);
  assert.equal(awaited.pushes().length, 0);
  assert.match(decideDispatchClaim("unreachable", { taskId: TASK, stderr: asyncReserver.lastAttemptStderr?.() }).reason, /git said: fatal/);
});

test("W1-T12525 criterion 4: against a real origin that holds the ref, the real reserver is taken and the pre-push hook never runs", async (t) => {
  const origin = gitRepo({ bare: true, scope: t, kind: "claim-held-origin" });
  const client = gitRepo({ scope: t, kind: "claim-held-client" });
  client.addRemote("origin", origin.dir);
  client.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  client.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const holder = gitDispatchClaimReserver({ run: realGit(client.dir) });
  const held = holder.mintAnchor();
  assert.equal(holder.attempt(TASK, held), "created");

  const hooks = join(client.dir, "recording-hooks");
  const marker = join(client.dir, "pre-push-ran");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\ncat > /dev/null\necho ran >> "${marker}"\nexit 0\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  client.git("config", "core.hooksPath", hooks);

  const sync = gitDispatchClaimReserver({ run: realGit(client.dir) });
  assert.equal(sync.attempt(TASK, sync.mintAnchor()), "taken");
  const awaited = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(client.dir) });
  assert.equal(await awaited.attempt(TASK, await awaited.mintAnchor()), "taken");
  assert.equal(existsSync(marker), false, "no push ran, so the pre-push hook never ran");
  assert.equal(origin.git("rev-parse", REF), held, "the holder's anchor is untouched");
  assert.match(decideDispatchClaim("taken", { taskId: TASK, holder: await awaited.holder(TASK) }).reason, new RegExp(held));

  // Positive control: the hook is live, and a free ref is still claimed through it.
  assert.equal(await awaited.attempt("W1-T9702", await awaited.mintAnchor()), "created");
  assert.equal(readFileSync(marker, "utf8"), "ran\n", "the recording hook runs for a real claim push");
});

/** The content gates hooks/pre-push runs, each by its script name. */
const GATES = [
  "rule15-precheck.mjs", "rule25-precheck.mjs", "ci-control-plane-precheck.mjs", "test-tier-manifest.mjs",
  "head-identity-gate.mjs", "worker-branch-shape.mjs", "proof-resolve-precheck.mjs",
];
// W1-T12510 moved these checks to CI. Older branch hooks still invoke them before the merge.
const CI_GATES = ["census-precheck.mjs", "lint-plan-precheck.mjs"];
const CI_DELEGATION = "pre-push: census suites and plan lint run in CI (ci.yml ci-shard and lint-plan, aggregated by ci-gate)";

test("W1-T12525 criterion 5: hooks/pre-push with an empty stdin still runs every content gate", async (t) => {
  for (const route of ["own", "harness"] as const) await t.test(route, (t) => {
    const tree = gitRepo({ scope: t, kind: "empty-stdin-hook" }).dir;
    const gateRoot = route === "own" ? tree : join(tree, "harness");
    mkdirSync(gateRoot, { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(gateRoot, "node_modules"));
    writeFileSync(join(gateRoot, "tsconfig.json"), "{}\n");
    mkdirSync(join(gateRoot, "scripts"));
    mkdirSync(join(gateRoot, "hooks"));
    mkdirSync(join(tree, "bin"));
    const log = join(tree, "gate.log");
    for (const gate of [...GATES, ...CI_GATES]) {
      writeFileSync(join(gateRoot, "scripts", gate), "");
    }
    // Record direct scripts and the harness route's inline imports without starting gate runtimes.
    // Unknown invocations refuse without recording a gate, so missing gates still fail the assertion.
    const node = join(tree, "bin", "node");
    writeFileSync(node, `#!/bin/sh
for arg do
  for gate in ${[...GATES, ...CI_GATES].join(" ")}; do
    case "$arg" in
      */scripts/"$gate"|*'at("/scripts/'"$gate"'")'*)
        printf '%s\\n' "$gate" >> "$GATE_LOG"; exit 1 ;;
    esac
  done
done
exit 1
    `);
    chmodSync(node, 0o755);
    copyFileSync(join(REPO_ROOT, "hooks", "pre-push"), join(gateRoot, "hooks", "pre-push"));
    const res = spawnSync("sh", [join(gateRoot, "hooks", "pre-push")], {
      cwd: tree, encoding: "utf8", input: "",
      env: { PATH: `${join(tree, "bin")}:${process.env.PATH ?? ""}`, HOME: tree, RMD_PREPUSH_GATES: "1", GATE_LOG: log },
    });
    assert.equal(res.error, undefined);
    const ran = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    for (const gate of GATES) assert.ok(ran.includes(gate), `${gate} must still run on an empty stdin (ran: ${ran.join(", ")})`);
    for (const gate of CI_GATES) assert.ok(ran.includes(gate) || res.stderr.includes(CI_DELEGATION),
      `${gate} must run or explicitly name its CI replacement (ran: ${ran.join(", ")}; stderr: ${res.stderr})`);
    assert.equal(res.status, 1, "the recording gates refuse, so the hook refuses as before");
    assert.doesNotMatch(res.stderr, /dispatch-claim-only/, "an empty stdin never takes the claim fast path");
  });
});

/** A synchronous git runner over one fixture checkout, with the fixture's own identity and no host config. */
function realGit(dir: string): (args: string[]) => GitAnswer {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  };
  return (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.error, undefined, "fixture git must complete");
    return { status: r.status ?? 128, stdout: r.stdout, stderr: r.stderr };
  };
}
