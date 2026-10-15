/**
 * THE DAEMON'S OWN CHECKOUT KEEPS ITS OWN GIT CREDENTIALS.
 *
 * On 2026-10-14 at 23:44Z a head-rehome quietness judgment ran with `cwd: repoRoot` through the
 * sweep's credential-socket spawn, so `wireCredentialHelperSocket` wrote the per-run socket helper
 * into the daemon's OWN checkout (`.git/config.worktree`), clearing the GH_TOKEN helper there. From
 * then on every daemon push from that checkout went through the socket, which only listens once
 * the daemon has finished booting: each boot-time feedback landing failed with "could not read
 * Username" (03:05Z, 03:43Z and 05:41Z on 10-15). helper.sock's mtime, 05:41:57.398Z, landed 0.2 s
 * after the third refusal.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitCredentialFixSpawn, unwireOwnCheckoutCredentialHelper } from "../src/run-task.js";
import { sharesHarnessCheckout, unwireCredentialHelperSocket, wireCredentialHelperSocket, type SpawnWorkerArgs, type WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const ENTRYPOINT_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

function credentialFill(dir: string): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync("git", ["-C", dir, "credential", "fill"], {
    input: "protocol=https\nhost=github.com\npath=o/r.git\n\n",
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "fixture-fleet-token", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test("a fix-rung spawn into the daemon's own checkout carries no git credential socket, while a run worktree still does", async () => {
  const harness = gitRepo({ kind: "own-checkout-harness" });
  const elsewhere = gitRepo({ kind: "own-checkout-run" });
  const seen: SpawnWorkerArgs[] = [];
  const spawn = gitCredentialFixSpawn("/nonexistent/helper.sock", async (args) => {
    seen.push(args);
    return { result: "", costUsd: 0, numTurns: 0, subtype: "success" } as unknown as WorkerResult;
  }, harness.dir);

  await spawn({ cwd: harness.dir, prompt: "judge", permissionMode: "bypassPermissions" } as SpawnWorkerArgs);
  await spawn({ cwd: elsewhere.dir, prompt: "fix", permissionMode: "bypassPermissions" } as SpawnWorkerArgs);

  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.secretBoundary?.credentialHelperSocketPath, undefined, "the daemon's own checkout is never handed the socket");
  assert.equal(seen[1]!.secretBoundary?.credentialHelperSocketPath, "/nonexistent/helper.sock", "a run worktree still is");
});

test("the boot repair removes a socket wiring from the daemon's own checkout and its git authenticates again", () => {
  const checkout = gitRepo({ kind: "own-checkout-wired" });
  checkout.git("config", "extensions.worktreeConfig", "true");
  checkout.git("config", "credential.helper", ENTRYPOINT_HELPER);
  const socketDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}own-sock-`));
  try {
    wireCredentialHelperSocket(checkout.dir, join(socketDir, "helper.sock"));
    const wired = credentialFill(checkout.dir);
    assert.notEqual(wired.status, 0, "control: with the socket not listening, git has no credential");
    assert.match(wired.stderr, /could not read Username/, "control: the exact 2026-10-15 failure");

    const rows: Array<[string, Record<string, unknown> | undefined]> = [];
    const removed = unwireOwnCheckoutCredentialHelper(checkout.dir, (step, extra) => rows.push([step, extra]));

    assert.ok(removed.some((h) => h.includes("git-credential-socket-helper.mjs")), "the socket helper is what was removed");
    assert.deepEqual(rows.map(([step]) => step), ["daemon.own_checkout_credential_unwired"], "and the repair is ledgered");
    const healed = credentialFill(checkout.dir);
    assert.equal(healed.status, 0, healed.stderr);
    assert.match(healed.stdout, /password=fixture-fleet-token/, "git reaches the checkout's own GH_TOKEN helper again");
    assert.equal(
      execFileSync("git", ["-C", checkout.dir, "config", "--local", "--get", "credential.helper"], { encoding: "utf8" }).trim(),
      ENTRYPOINT_HELPER,
      "the checkout's own helper is untouched",
    );

    const again: string[] = [];
    assert.deepEqual(unwireOwnCheckoutCredentialHelper(checkout.dir, (step) => again.push(step)), [], "an unwired checkout is left alone");
    assert.deepEqual(again, [], "and logs nothing");
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test("an unreadable or half-wired checkout neither stops the boot repair nor hides what it did", () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const failed = unwireOwnCheckoutCredentialHelper("/checkout", (step, extra) => rows.push([step, extra]), () => {
    throw new Error("config locked");
  });
  assert.deepEqual(failed, [], "a repair that cannot run removes nothing");
  assert.deepEqual(rows, [["daemon.own_checkout_credential_unwired", { checkout: "/checkout", error: "config locked" }]], "and says why");

  const calls: string[][] = [];
  const halfWired = unwireCredentialHelperSocket("/checkout", (args) => {
    calls.push(args);
    if (args[0] === "--get-all") return '\n!node "/x/scripts/git-credential-socket-helper.mjs" "/s.sock"\n';
    if (args[0] === "--unset") throw new Error("key does not exist");
    return "";
  });
  assert.equal(halfWired.length, 2, "both helper entries are reported");
  assert.deepEqual(calls.map((c) => c[0]), ["--get-all", "--unset-all", "--unset"], "the helpers go even with no useHttpPath to unset");

  const gone = join(tmpdir(), `${RMD_TMP_PREFIX}never-created`);
  assert.equal(sharesHarnessCheckout(gone, `${gone}/.`), true, "a path that does not exist still compares by its resolved form");
});
