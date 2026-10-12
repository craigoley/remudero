// test/a-review-proof-reads-the-origin-without-its-credentials.test.ts
//
// PR #10667's review FAILED a proof that passes in CI: `daemonCommand` → `resolveOwnerRepo` threw
// OwnerRepoUnresolvableError "remote.origin.url is not set" inside the review worktree. The cause was
// proofSandboxArgv binding an EMPTY file over the git common dir's `config`, so a sandboxed proof read
// no origin at all, while CI's checkout always has one. The mask now carries ONLY the origin url with
// its credentials stripped. FIXTURES ONLY: every token below is a fixture string.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A NAMESPACE import, deliberately: at the merge base these exports do not exist, and a named import
// would fail the whole file at load. Read through the namespace, each test fails at its own assertion.
import * as review from "../src/lib/review.js";
import { resolveOwnerRepoAt } from "../src/lib/owner-repo.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const TOKEN_URL = "https://x-access-token:fixture-secret@github.com/o/r";
const real = (p: string) => execFileSync("realpath", [p], { encoding: "utf8" }).trim();
const readUrl = (configFile: string) =>
  execFileSync("git", ["config", "--file", configFile, "--get", "remote.origin.url"], { encoding: "utf8" }).trim();

test("a review proof's masked git config carries the origin url with its credentials stripped", () => {
  const root = makeTempDir("origin-mask-argv");
  const common = join(root, "managed", ".git");
  const gitdir = join(common, "worktrees", "review-PR1");
  const cwd = join(root, "worktrees", "review-PR1");
  const home = join(root, "proof-home");
  for (const d of [gitdir, cwd, home]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(common, "config"),
    `[http]\n\textraheader = AUTHORIZATION: basic fixture-secret\n[remote "origin"]\n\turl = ${TOKEN_URL}\n`,
  );
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitdir}\n`);
  const argv = review.proofSandboxArgv({ cwd, home, env: {} });
  const target = join(real(common), "config");
  const mask = argv.find((a, i) => argv[i - 1] === "--ro-bind" && argv[i + 1] === target);
  assert.ok(mask !== undefined && mask.startsWith(`${real(home)}/`), "the config is masked by a file in the throwaway HOME");
  const text = readFileSync(mask!, "utf8");
  assert.doesNotMatch(text, /fixture-secret/, "no credential from the shared config crosses into the mask");
  assert.doesNotMatch(text, /extraheader/i, "no key other than the origin url crosses into the mask");
  assert.equal(readUrl(mask!), "https://github.com/o/r", "git reads the credential-free origin url from the mask");
});

test("a sandboxed review proof resolves this repo's owner/repo from the masked origin, as CI's checkout does", () => {
  // The review checkout's shape: a worktree whose common dir (and its config) sits outside the checkout.
  // bwrap cannot run here on every host, so the bind is reproduced by copying the mask over the shared config.
  const managed = gitRepo({ kind: "origin-mask-managed" });
  managed.addRemote("origin", TOKEN_URL);
  const cwd = join(makeTempDir("origin-mask-review"), "review-PR1");
  managed.addWorktree(cwd, "review-pr1");
  const home = makeTempDir("origin-mask-home");
  const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const argv = review.proofSandboxArgv({ cwd, home, env: {} });
  const target = join(real(common), "config");
  const mask = argv.find((a, i) => argv[i - 1] === "--ro-bind" && argv[i + 1] === target);
  assert.ok(mask !== undefined, "the shared config is masked");
  copyFileSync(mask!, target);
  assert.deepEqual(resolveOwnerRepoAt(cwd), { owner: "o", repo: "r" }, "resolveOwnerRepo reads the origin under the mask");
  assert.doesNotMatch(readFileSync(target, "utf8"), /fixture-secret/, "the token never reaches the proof");
});

test("credentialFreeOriginUrl strips userinfo, query and fragment from every origin shape", () => {
  const strip = review.credentialFreeOriginUrl;
  assert.equal(strip(TOKEN_URL), "https://github.com/o/r");
  assert.equal(strip("https://fixture-secret@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(strip("https://github.com/o/r?access_token=fixture-secret#x"), "https://github.com/o/r");
  assert.equal(strip("ssh://git:fixture-secret@github.com/o/r.git"), "ssh://github.com/o/r.git");
  assert.equal(strip("git@github.com:o/r.git"), "github.com:o/r.git", "an scp-like remote loses its user");
  assert.equal(strip("/srv/git/r.git"), "/srv/git/r.git", "a local path carries no credential and is kept");
  assert.equal(strip("https://fixture-secret@github.com:badport/o/r"), undefined, "an unparseable url crosses as nothing");
  assert.equal(strip("https://github.com/o/r\nfixture-secret"), undefined, "a multi-line value crosses as nothing");
  assert.equal(strip(""), undefined);
});

test("proofMaskedGitConfig is empty when the shared config names no usable origin, and quotes what it writes", () => {
  const root = makeTempDir("origin-mask-config");
  const none = join(root, "none");
  writeFileSync(none, "[core]\n\tbare = false\n");
  assert.equal(review.proofMaskedGitConfig(none), "", "no origin: the proof sees no remote");
  assert.equal(review.proofMaskedGitConfig(join(root, "absent")), "", "an unreadable config: the proof sees no remote");
  const bad = join(root, "bad");
  writeFileSync(bad, '[remote "origin"]\n\turl = "https://fixture-secret@github.com:badport/o/r"\n');
  assert.equal(review.proofMaskedGitConfig(bad), "", "an unparseable origin: the proof sees no remote");
  const unrelated = join(root, "unrelated");
  writeFileSync(unrelated, '[remote "origin"]\n\turl = https://github.com/o/r\n[core]\n\turl = https://fixture-secret/ignored\n');
  assert.equal(readUrl(writeMask(unrelated)), "https://github.com/o/r", "a later section cannot replace the origin");
  const repeated = join(root, "repeated");
  writeFileSync(repeated, '[remote "origin"]\n\turl = https://github.com/o/r\n\turl = https://fixture-secret/other\n');
  assert.equal(review.proofMaskedGitConfig(repeated), "", "an ambiguous origin is not guessed");
  const odd = join(root, "odd");
  writeFileSync(odd, '[remote "origin"]\n\turl = "/srv/git/a\\"b\\\\c;d#e.git"\n');
  const mask = join(root, "mask");
  writeFileSync(mask, review.proofMaskedGitConfig(odd));
  assert.equal(readUrl(mask), '/srv/git/a"b\\c;d#e.git', "quotes, backslashes and comment characters round-trip");

  function writeMask(config: string): string {
    const path = join(root, "unrelated-mask");
    writeFileSync(path, review.proofMaskedGitConfig(config));
    return path;
  }
});

test("a malformed long quoted section is rejected without exponential backtracking", () => {
  const path = join(makeTempDir("origin-mask-long-section"), "config");
  writeFileSync(path, `[remote "${"\\!".repeat(20_000)}]\nurl = https://example.test/repo.git\n`);
  const started = performance.now();
  assert.equal(review.proofMaskedGitConfig(path), "");
  assertWallClockBound(performance.now() - started, 1_000, "malformed quoted input stays linear-time");
});
