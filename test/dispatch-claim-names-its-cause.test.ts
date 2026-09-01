// W1-T2552: every dispatch refused with "cannot reach origin to claim refs/rmd-dispatch/<id>" after
// the fleet moved to GitHub App auth, and the message named a CATEGORY rather than a cause.
//
// THE ROOT CAUSE, MEASURED 2026-08-30 by reproducing mintAnchor + attempt verbatim against the
// production repoDir with a token minted by the repo's own refreshInstallationToken:
//
//   push origin <anchor>:refs/rmd-dispatch/<id>
//     status=128
//     stderr="fatal: could not read Username for 'https://github.com': No such device or address"
//
// That is a MISSING CREDENTIAL HELPER, not an unreachable remote. deploy/entrypoint.sh installed the
// helper only `if [ -n "${GH_TOKEN:-}" ]`, and W1-T2311 deliberately made the boot env carry an EMPTY
// GH_TOKEN — so the helper was never installed on any boot, the daemon's minted App token sat in
// process.env where git had been told nothing about it, and git fell through to prompting.
//
// TWO THINGS THIS PINS. (1) The helper install is unconditional, because whether GH_TOKEN holds
// anything AT BOOT says nothing about whether it will at CALL TIME — which is the helper's entire
// purpose. (2) The refusal carries git's own stderr, because recovering that one line cost an hour
// of bisection that the gate had already made unnecessary and then thrown away.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  decideDispatchClaim,
  dispatchClaimRef,
  gitDispatchClaimReserver,
  type DispatchClaimReserver,
} from "../src/lib/dispatch-claim.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The exact stderr the production reproduction produced. */
const REAL_STDERR = "fatal: could not read Username for 'https://github.com': No such device or address\n";

// ── The refusal names its cause ──────────────────────────────────────────────────────────────

test("an unreachable claim refusal carries git's OWN stderr, so the cause is readable without bisecting for it", () => {
  const d = decideDispatchClaim("unreachable", { taskId: "W1-T9001", stderr: REAL_STDERR });
  assert.equal(d.proceed, false);
  assert.match(d.reason, /cannot reach origin to claim/, "the category survives");
  assert.match(d.reason, /git said:/, "and now names git as the source of what follows");
  assert.match(
    d.reason,
    /could not read Username/,
    `the CAUSE must appear verbatim — this is the line an hour was spent recovering. Got: ${d.reason}`,
  );
  assert.equal(d.reason.includes("\n"), false, "collapsed to one line: this lands in a ledger row");
});

test("the refusal is unchanged when no stderr is available, so a fake reserver keeps today's wording", () => {
  const withNothing = decideDispatchClaim("unreachable", { taskId: "W1-T9001" });
  const withEmpty = decideDispatchClaim("unreachable", { taskId: "W1-T9001", stderr: "   \n  " });
  assert.equal(withNothing.reason, withEmpty.reason, "whitespace-only stderr adds nothing");
  assert.equal(withNothing.reason.includes("git said:"), false);
  assert.match(withNothing.reason, /cannot reach origin to claim refs\/rmd-dispatch\/W1-T9001/);
});

test("a long stderr is bounded, and contention is untouched by any of this", () => {
  const long = decideDispatchClaim("unreachable", { taskId: "W1-T9001", stderr: "x".repeat(5000) });
  assert.ok(long.reason.length < 700, `bounded, got ${long.reason.length}`);
  const taken = decideDispatchClaim("taken", { taskId: "W1-T9001", holder: "abc123", stderr: REAL_STDERR });
  assert.equal(taken.reason.includes("git said:"), false, "a taken claim is contention, not a git failure");
  assert.match(taken.reason, /already claimed by another lane/);
});

// ── The reserver captures it, and only for the attempt it belongs to ─────────────────────────

test("gitDispatchClaimReserver records a failing attempt's stderr and CLEARS it on the next success", () => {
  const calls: string[][] = [];
  let fail = true;
  const reserver = gitDispatchClaimReserver({
    anchor: () => "deadbeef",
    run: (args) => {
      calls.push(args);
      if (args[0] === "push" && fail) return { status: 128, stdout: "", stderr: REAL_STDERR };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(reserver.lastAttemptStderr?.(), undefined, "nothing recorded before any attempt");
  assert.equal(reserver.attempt("W1-T9001", "deadbeef"), "unreachable");
  assert.match(String(reserver.lastAttemptStderr?.()), /could not read Username/);

  fail = false;
  assert.equal(reserver.attempt("W1-T9001", "deadbeef"), "created");
  assert.equal(reserver.lastAttemptStderr?.(), undefined, "a success must not leave a stale cause behind");
  assert.deepEqual(calls[0], ["push", "origin", `deadbeef:${dispatchClaimRef("W1-T9001")}`]);
});

test("a reserver that omits lastAttemptStderr still satisfies the interface — the seam is optional", () => {
  const minimal: DispatchClaimReserver = {
    mintAnchor: () => "abc",
    attempt: () => "unreachable",
    holder: () => undefined,
    drop: () => true,
  };
  assert.equal(minimal.lastAttemptStderr?.(), undefined);
  assert.equal(
    decideDispatchClaim("unreachable", { taskId: "W1-T9001", stderr: minimal.lastAttemptStderr?.() }).reason.includes("git said:"),
    false,
  );
});

// ── The hypothesis this measurement KILLED, pinned so it is not re-investigated ──────────────

test("mintAnchor produces a NON-EMPTY anchor against a real git repo — an empty one would make attempt() a ref DELETE", () => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-claim-anchor-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], { stdio: "pipe", env });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"], { stdio: "pipe", env });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "pipe", env });
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", repo, "add", "seed.txt"], { stdio: "pipe", env });
  execFileSync("git", ["-C", repo, "commit", "-qm", "seed"], { stdio: "pipe", env });

  const reserver = gitDispatchClaimReserver({
    run: (args) => {
      const r = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
      return { status: 0, stdout: r, stderr: "" };
    },
  });
  const anchor = reserver.mintAnchor();
  assert.match(anchor, /^[0-9a-f]{40}$/, `mintAnchor must yield a real sha, got ${JSON.stringify(anchor)}`);
  // The falsifier that made this worth pinning: an EMPTY anchor turns the refspec into ":<ref>",
  // which is a DELETE of a ref that does not exist — a plausible-looking cause that is NOT this one.
  assert.notEqual(`${anchor}:${dispatchClaimRef("W1-T9001")}`[0], ":", "a non-empty anchor cannot render a delete refspec");
});

// ── The entrypoint installs the helper unconditionally ───────────────────────────────────────

test("deploy/entrypoint.sh installs the credential helper UNCONDITIONALLY — the boot env is empty by design since W1-T2311", () => {
  const sh = readFileSync(join(REPO_ROOT, "deploy", "entrypoint.sh"), "utf8");
  const helperLine = sh.indexOf("git config --global credential.helper");
  assert.ok(helperLine > 0, "the helper install must still exist");

  // The 400 characters BEFORE the install must not re-introduce a GH_TOKEN emptiness gate.
  const preceding = sh.slice(Math.max(0, helperLine - 400), helperLine);
  assert.equal(
    /if \[ -n "\$\{GH_TOKEN:-\}" \]; then\s*$/.test(preceding),
    false,
    "the helper must NOT be gated on a non-empty boot GH_TOKEN — that gate is the outage",
  );
  // And it must still read the variable at call time rather than baking a value in.
  assert.match(sh, /password=\$GH_TOKEN/, "the helper still reads GH_TOKEN at call time");
  assert.equal(sh.includes("password=${GH_TOKEN}"), false, "and must not be expanded at write time");
});
