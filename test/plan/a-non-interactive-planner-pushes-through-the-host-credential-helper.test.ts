import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  hostAppIdentityEnv, openPlannerGitCredential, plannerHostGitCredential, realScopedMint, startRunChildGitCredentialSocket,
  type HostAppIdentity, type PlannerHostGitCredential,
} from "#src/lib/secret-boundary.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { unwireCredentialHelperSocket, wireCredentialHelperSocket } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// W1-T11851: `rmd plan` launched from a non-interactive shell had no credential for its own pushes — the only
// token was a ~/.bashrc export, which bash reads only for an interactive shell. Its pushes now present a
// repo-scoped token minted from the host registry's App identity at the git credential-helper boundary.

const FAKE_TOKEN = "ghs_W1T11851fakescopedtoken";
const DECOY_TOKEN = "ghp_W1T11851bashrcdecoy";
const REQUEST = "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n";

function scratch(tag: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-t11851-${tag}-`));
}

function writeKey(path: string): void {
  writeFileSync(path, generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey);
}

function registry(dir: string, instances: string): string {
  const path = join(dir, "daemon-instances.yaml");
  writeFileSync(path, `instances:\n${instances}`);
  return path;
}

const instance = (name: string, fields: Record<string, string>): string =>
  `  ${name}:\n${Object.entries(fields).map(([k, v]) => `    ${k}: ${v}\n`).join("")}`;

/** A checkout and a linked worktree carrying split worktree config, as a lane worktree has. */
function laneFixture(dir: string): { main: string; worktree: string; cleanup: () => void } {
  const main = gitRepo({ kind: "t11851-main" });
  main.git("config", "extensions.worktreeConfig", "true");
  const worktree = join(dir, "lane");
  main.addWorktree(worktree, "lane");
  return { main: main.dir, worktree, cleanup: () => main.cleanup() };
}

/** A HOME whose only token is an interactive-only .bashrc export, and whose global helper answers from $GH_TOKEN. */
function decoyHome(dir: string): string {
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".bashrc"), `export GH_TOKEN=${DECOY_TOKEN}\n`);
  writeFileSync(join(home, ".gitconfig"),
    "[credential]\n\thelper = \"!f() { test -n \\\"$GH_TOKEN\\\" && printf 'username=x-access-token\\\\npassword=%s\\\\n' \\\"$GH_TOKEN\\\"; }; f\"\n");
  return home;
}

/** `git credential fill` in a bash child whose env is built from scratch: no GH_TOKEN, no GH_APP_* variable. */
function bashCredentialFill(flags: "-c" | "-ic", cwd: string, home: string): Promise<{ code: number; stdout: string }> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  // stdin is /dev/null, never a pipe: bash sources ~/.bashrc for `-c` too when stdin is a socket (its
  // remote-shell heuristic), and node's pipes are socketpairs. MEASURED here: a piped `bash -c` read the decoy.
  return new Promise((resolve) => {
    const child = spawn("bash", [flags, `printf '%s' "$REQ" | git -C "${cwd}" credential fill`],
      { env: { ...env, REQ: REQUEST }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function password(reply: string): string | undefined {
  return /^password=(.*)$/m.exec(reply)?.[1];
}

/** A `mintScopedToken` stand-in recording the private env it was handed, answering with the fake token. */
function recordingMint(seen: NodeJS.ProcessEnv[]): Parameters<typeof realScopedMint>[1] {
  return async (_repo, _ttl, opts) => {
    seen.push({ ...(opts?.env ?? {}) });
    return { ok: true, token: FAKE_TOKEN };
  };
}

test("the planner credential resolver reads the host registry: app, ambient, and a named refusal for each unusable source", async () => {
  const dir = scratch("resolver");
  try {
    const key = join(dir, "app.pem");
    writeKey(key);
    const claudeDir = join(dir, "claude");
    mkdirSync(claudeDir);
    writeKey(join(claudeDir, "rmd-app.pem"));
    const app = { github_repo: "acme/widgets", gh_app_id: "11", gh_app_installation_id: "22" };

    const explicit = await plannerHostGitCredential("acme/widgets", {
      registryPath: registry(dir, instance("core", { ...app, gh_app_private_key_path: "/home/node/.claude/rmd-app.pem", gh_app_private_key_host_path: key })),
    });
    assert.deepEqual(explicit, { kind: "app", registryPath: join(dir, "daemon-instances.yaml"), appId: "11", installationId: "22", keyPath: key });

    const mapped = await plannerHostGitCredential("ACME/widgets", {
      registryPath: registry(dir, instance("core", { ...app, gh_app_private_key_path: "/home/node/.claude/rmd-app.pem", claude_dir: `${claudeDir}/` })),
    });
    assert.equal(mapped.kind === "app" && mapped.keyPath, join(claudeDir, "rmd-app.pem"), "the container key path maps under claude_dir");

    assert.deepEqual(await plannerHostGitCredential("acme/widgets", { registryPath: join(dir, "absent.yaml") }),
      { kind: "ambient", registryPath: join(dir, "absent.yaml") }, "only a missing registry keeps today's helpers");

    const refused = async (text: string, opts: { access?: (p: string) => Promise<void> } = {}): Promise<string> => {
      const got: PlannerHostGitCredential = await plannerHostGitCredential("acme/widgets", { registryPath: registry(dir, text), ...opts });
      assert.equal(got.kind, "refused", `refused: ${JSON.stringify(got)}`);
      return got.kind === "refused" ? got.reason : "";
    };
    const keyed = { ...app, gh_app_private_key_host_path: key };
    assert.match(await refused("  core:\n   bad-indent: x\n"), /malformed/);
    assert.match(await refused(instance("core", { github_repo: "acme/widgets", gh_app_installation_id: "22", gh_app_private_key_host_path: key })), /no gh_app_id/);
    assert.match(await refused(instance("core", { ...app, gh_app_private_key_host_path: join(dir, "missing.pem") })), /not readable: ENOENT/);
    assert.match(await refused(instance("core", keyed), { access: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /not readable: EACCES/);
    assert.match(await refused(instance("core", { ...app, gh_app_private_key_path: "/srv/key.pem" })), /does not map onto this host/);
    assert.match(await refused(instance("other", { ...keyed, github_repo: "acme/gadgets" })), /no host instance names acme\/widgets/);
    assert.match(
      await refused(instance("core", keyed) + instance("old", { ...keyed, gh_app_id: "99", retired: "true" })),
      /2 host instances name acme\/widgets with different App identities/,
    );
    const unreadable = await plannerHostGitCredential("acme/widgets", { registryPath: dir });
    assert.ok(unreadable.kind === "refused" && /unreadable: EISDIR/.test(unreadable.reason), "a registry that cannot be read is not absence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11851 criterion 3: a non-interactive child whose only token is a .bashrc export gets the scoped token from the wired helper", async () => {
  const dir = scratch("helper");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const seen: NodeJS.ProcessEnv[] = [];
  const released: string[] = [];
  const cleanups: Array<() => void> = [];
  const envBefore = JSON.stringify(process.env);
  try {
    const key = join(dir, "app.pem");
    writeKey(key);
    const credential = await plannerHostGitCredential("acme/widgets", {
      registryPath: registry(dir, instance("core", { github_repo: "acme/widgets", gh_app_id: "11", gh_app_installation_id: "22", gh_app_private_key_host_path: key })),
    });
    assert.equal(credential.kind, "app");
    const { main, worktree, cleanup } = laneFixture(dir);
    cleanups.push(cleanup);
    const home = decoyHome(dir);
    const runDir = join(dir, "plan-cred-run");
    const log = (step: string, fields: Record<string, unknown>) => rows.push({ step, fields });
    // The plan lane's own credential, as planCommand opens it — only the mint is a stand-in.
    const opened = await openPlannerGitCredential(credential, {
      runDir, log, wire: wireCredentialHelperSocket, unwire: unwireCredentialHelperSocket, shared: (cwd) => cwd === main,
      startSocket: (opts) => startRunChildGitCredentialSocket({ ...opts, mint: realScopedMint(opts.log, recordingMint(seen), opts.identity) }),
    });
    assert.ok(opened.ok, "an App identity opens a socket");
    const lane = opened.lane;
    try {
      assert.equal(statSync(runDir).mode & 0o777, 0o700, "the socket directory is owner-only");
      assert.equal(lane.wire(worktree), undefined, "the lane's own worktree is wired");
      const wired = await bashCredentialFill("-c", worktree, home);
      assert.equal(password(wired.stdout), FAKE_TOKEN, `the wired helper answers a non-interactive child: ${JSON.stringify(wired)}`);
      assert.deepEqual(seen, [hostAppIdentityEnv(credential as HostAppIdentity)], "the mint read exactly the registry identity, from a private env");
      assert.deepEqual(seen[0], { GH_APP_ID: "11", GH_APP_INSTALLATION_ID: "22", GH_APP_PRIVATE_KEY_PATH: key });
      // The harness git leaf every reservation and run-branch push takes carries the same helper.
      assert.equal(password(await hostWorktreeGitAsync(worktree, ["credential", "fill"], { input: REQUEST })), FAKE_TOKEN);

      // RED CONTROL: the decoy is observable, so the fixture can see the original failure.
      const bare = await bashCredentialFill("-c", main, home);
      assert.equal(password(bare.stdout), undefined, "an unwired checkout in a non-interactive child has no credential");
      assert.notEqual(bare.code, 0);
      const interactive = await bashCredentialFill("-ic", main, home);
      assert.equal(password(interactive.stdout), DECOY_TOKEN, "bash -ic does read the .bashrc decoy");
      assert.notEqual(password(interactive.stdout), FAKE_TOKEN, "an unwired worktree never gets the scoped token");
      assert.match(lane.wire(main) ?? "", /shared checkout/, "the operator checkout is never wired");

      // Teardown: the release still presents the scoped token, so it runs before the unwire.
      lane.retire(worktree, (cwd) => {
        released.push(cwd);
        assert.match(execFileSync("git", ["-C", cwd, "config", "--worktree", "--get-all", "credential.helper"], { encoding: "utf8" }),
          /git-credential-socket-helper/, "the release runs while the worktree is still wired");
      });
      assert.throws(() => execFileSync("git", ["-C", worktree, "config", "--worktree", "--get-all", "credential.helper"], { stdio: "ignore" }),
        "then the worktree is unwired");
    } finally {
      await lane.close();
    }
    assert.deepEqual(released, [worktree], "unfiled ids go back from the wired worktree");
    assert.equal(existsSync(runDir), false, "the socket directory is removed");
    assert.ok(rows.some((r) => r.step === "boundary.request" && r.fields.status === "minted"), "the mint is ledgered value-free");
    assert.ok(!JSON.stringify(rows).includes(FAKE_TOKEN), "no ledger row carries the token");
    assert.equal(JSON.stringify(process.env), envBefore, "no GH_TOKEN, App variable or token enters the planner's process.env");
  } finally {
    for (const cleanup of cleanups) cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the identity reaches the real mint and the real socket thread, and a pathless request mints nothing", async () => {
  const dir = scratch("thread");
  try {
    const key = join(dir, "app.pem");
    writeKey(key);
    const identity: HostAppIdentity = { appId: "11", installationId: "22", keyPath: key };
    // The real mintScopedToken: with the identity it reaches the owner/repo check; without it, it has no App at all.
    assert.deepEqual(await realScopedMint(() => {}, undefined, identity)("github.com"), { ok: false, reason: "request names no owner/repo to scope to" });
    assert.deepEqual(await realScopedMint(() => {})("github.com"), { ok: false, reason: "app not configured" });

    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const socket = await startRunChildGitCredentialSocket({ runDir: dir, log: (step, fields) => rows.push({ step, fields }), identity });
    try {
      const lane = laneFixture(dir);
      try {
        wireCredentialHelperSocket(lane.worktree, socket.socketPath);
        await assert.rejects(hostWorktreeGitAsync(lane.worktree, ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n",
          env: { GIT_TERMINAL_PROMPT: "0" } }), "a pathless request is answered with nothing");
      } finally {
        lane.cleanup();
      }
    } finally {
      await socket.close();
    }
    assert.ok(rows.some((r) => r.fields.decision === "refuse" && /owner\/repo/.test(String(r.fields.reason))),
      `the thread minted as the identity and refused the pathless request: ${JSON.stringify(rows)}`);
    assert.ok(!rows.some((r) => r.fields.status === "minted"), "nothing was minted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unusable credential source refuses the plan lane before any socket, wiring or release", async () => {
  const dir = scratch("lane");
  try {
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const base = {
      runDir: join(dir, "run"), log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }),
      wire: (cwd: string, socketPath: string) => { calls.push(`wire ${cwd} ${socketPath}`); },
      unwire: (cwd: string) => { calls.push(`unwire ${cwd}`); return []; }, shared: (cwd: string) => cwd === "/operator",
    };
    const app = { kind: "app" as const, registryPath: "/r.yaml", appId: "11", installationId: "22", keyPath: "/k.pem" };

    const refused = await openPlannerGitCredential({ kind: "refused", registryPath: "/etc/remudero/daemon-instances.yaml", reason: "no host instance names acme/widgets" },
      { ...base, startSocket: async () => { calls.push("socket"); throw new Error("unreachable"); } });
    assert.deepEqual(refused, { ok: false, reason: "no host instance names acme/widgets" });
    assert.equal(calls.length, 0, "a refused source starts no socket");
    assert.deepEqual(rows.at(-1), { step: "plan.credential_refused", fields: { reason: "no host instance names acme/widgets", registry_path: "/etc/remudero/daemon-instances.yaml" } });

    const unbound = await openPlannerGitCredential(app, { ...base, startSocket: async () => { throw new Error("bind refused"); } });
    assert.deepEqual(unbound, { ok: false, reason: "git credential socket did not start: bind refused" });
    assert.equal(existsSync(base.runDir), false, "a socket that did not start leaves no directory");

    const seenIdentity: unknown[] = [];
    const opened = await openPlannerGitCredential(app, { ...base, startSocket: async (opts) => {
      seenIdentity.push(opts.identity);
      return { socketPath: "/run/git.sock", close: async () => { throw new Error("close refused"); } };
    } });
    assert.ok(opened.ok);
    assert.deepEqual(seenIdentity, [{ appId: "11", installationId: "22", keyPath: "/k.pem" }], "the socket gets ids and the key path only");
    const released: string[] = [];
    opened.lane.retire("/lane", (cwd) => released.push(cwd));
    assert.equal(released.length, 0, "an unwired lane releases nothing early");
    assert.match(opened.lane.wire("/operator") ?? "", /shared checkout/);
    assert.equal(opened.lane.wire("/lane"), undefined);
    opened.lane.retire("/lane", (cwd) => { released.push(cwd); calls.push(`release ${cwd}`); });
    opened.lane.retire("/lane", (cwd) => released.push(cwd));
    assert.deepEqual(calls, ["wire /lane /run/git.sock", "release /lane", "unwire /lane"], "release, then unwire — once");
    await opened.lane.close();
    await opened.lane.close();
    assert.equal(rows.filter((r) => r.step === "plan.credential_close_failed").length, 1, "a socket that will not close is ledgered once, never thrown");

    const unwritable = await openPlannerGitCredential(app, { ...base, wire: () => { throw new Error("config write refused"); },
      startSocket: async () => ({ socketPath: "/run/git.sock", close: async () => {} }) });
    assert.ok(unwritable.ok);
    assert.equal(unwritable.lane.wire("/lane"), "git credential helper not wired: config write refused");
    assert.equal(rows.at(-1)?.step, "plan.credential_refused");
    await unwritable.lane.close();

    const ambient = await openPlannerGitCredential({ kind: "ambient", registryPath: "/absent.yaml" }, { ...base, startSocket: async () => { throw new Error("unreachable"); } });
    assert.ok(ambient.ok);
    assert.equal(ambient.lane.wire("/lane"), undefined, "ambient wires nothing: today's helpers apply unchanged");
    ambient.lane.retire("/lane", (cwd) => released.push(cwd));
    await ambient.lane.close();
    assert.deepEqual(released, ["/lane"], "ambient releases from where it always did");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
