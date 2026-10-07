/**
 * W1-T6148 — NO WORKER WRITES A GIT CONFIG THE HOST PUSH HONOURS.
 *
 * A codex writer used to get its tree's git dir and common dir as writable `--add-dir` roots, and the
 * host git leaf kept the pinned gitdir's own config, so a planted `credential.helper`, `include.path`,
 * `remote.origin.url`/`pushurl`, `url.*.insteadOf` or `core.askPass` ran in, or redirected, the
 * daemon's authenticated push. Now: no gitdir grant (the harness commits for codex), the Claude
 * worker's settings deny the config paths, and the leaf resets credential helpers to harness state,
 * neutralises askPass, and refuses keys the harness never writes before git runs.
 *
 * FIXTURES ONLY: every remote is a bare repository under this suite's mkdtemp root, served over HTTP by
 * a child process running `git http-backend` behind Basic auth; every planted key lives in a fixture
 * worktree cut from a fixture seed; every helper is a fixture script. Each hostile route is proven LIVE
 * by a raw `git -C` control first, so a marker that stays absent through the leaf is evidence.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import * as gitPush from "../src/lib/git-push.js";
import * as leaf from "../src/lib/worktree-git.js";
import * as provider from "../src/lib/worker-provider.js";
import { renderWorkerSettings, wireCredentialHelperSocket, worktreeAdd } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const USER = "fixture-user";
const PASS = "fixture-pass";
const SOCKET_PASS = "fixture-socket-pass";
const SAVED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS", "RMD_HARNESS_HOOKS_DIR"] as const;
const saved = new Map(SAVED.map((k) => [k, process.env[k]] as const));

let root: string;
let served: string;
let markers: string;
let globalWithHelper: string;
let globalEmpty: string;
let server: ChildProcess;
let base: string;
let n = 0;

/** The fixture git server: `git http-backend` behind Basic auth, logging each request's auth verdict. */
const SERVER = `
const http = require("http"), { spawn } = require("child_process"), fs = require("fs");
const [projectRoot, log, ...accepted] = process.argv.slice(2);
const ok = new Set(accepted.map((p) => "Basic " + Buffer.from(p).toString("base64")));
http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (!ok.has(req.headers.authorization)) {
    fs.appendFileSync(log, "challenge " + url.pathname + "\\n");
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
    return res.end();
  }
  fs.appendFileSync(log, "authorized " + Buffer.from(req.headers.authorization.slice(6), "base64") + " " + url.pathname + "\\n");
  const cgi = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, REMOTE_USER: "fixture",
    REMOTE_ADDR: "127.0.0.1", CONTENT_TYPE: req.headers["content-type"] || "", HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "" } });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), started = false;
  cgi.stdout.on("data", (d) => {
    if (started) return res.write(d);
    head = Buffer.concat([head, d]);
    const crlf = head.indexOf("\\r\\n\\r\\n"), lf = head.indexOf("\\n\\n");
    const at = crlf >= 0 ? crlf : lf;
    if (at < 0) return;
    started = true;
    let status = 200; const headers = {};
    for (const line of head.slice(0, at).toString().split(/\\r?\\n/)) {
      const i = line.indexOf(":"); const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10); else if (k) headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.slice(at + (crlf >= 0 ? 4 : 2)));
  });
  cgi.stdout.on("end", () => res.end());
}).listen(0, "127.0.0.1", function () { process.stdout.write(this.address().port + "\\n"); });
`;

function raw(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
}

function marker(name: string): string {
  return join(markers, name);
}

/** A shell helper/askpass command that leaves `name`'s marker and answers nothing. */
function markerCommand(name: string): string {
  return `!f() { touch '${marker(name)}'; }; f`;
}

function serverLog(): string {
  return existsSync(join(root, "server.log")) ? readFileSync(join(root, "server.log"), "utf8") : "";
}

/** A served bare remote, a seed whose origin is its HTTP URL, and a run worktree the real `worktreeAdd` cut. */
function cutLane(): { wt: string; bare: string; url: string; branch: string } {
  const i = ++n;
  const bare = join(served, `lane-${i}.git`);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const seed = gitRepo({ kind: `t6148-seed-${i}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", bare);
  seed.git("push", "-q", "origin", "main");
  const url = `${base}/lane-${i}.git`;
  seed.git("remote", "set-url", "origin", url);
  const wt = join(root, `t6148-wt-${i}`);
  const branch = `run-T6148-${i}-1`;
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  writeFileSync(join(wt, `f-${i}.txt`), `${i}\n`);
  leaf.hostWorktreeGit(wt, ["add", `f-${i}.txt`]);
  leaf.hostWorktreeGit(wt, ["commit", "-q", "-m", `feat: lane ${i}`]);
  return { wt, bare, url, branch };
}

function leafPush(wt: string, branch: string): void {
  gitPush.worktreePushExec(wt)("git", ["-C", wt, "push", "origin", `HEAD:refs/heads/${branch}`], { stdio: "ignore" });
}

function landed(bare: string, branch: string): string | undefined {
  try {
    return raw(bare, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).trim();
  } catch {
    // Absent ref: nothing landed.
    return undefined;
  }
}

function isRefusal(e: unknown): boolean {
  const cause = (e as { cause?: unknown })?.cause;
  return typeof leaf.WorktreeConfigRefusedError === "function" && cause instanceof leaf.WorktreeConfigRefusedError;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6148-`));
  served = join(root, "served");
  markers = join(root, "markers");
  for (const d of [served, markers, join(root, "harness-hooks")]) mkdirSync(d);
  globalWithHelper = join(root, "global-with-helper");
  globalEmpty = join(root, "global-empty");
  writeFileSync(globalEmpty, "");
  writeFileSync(globalWithHelper, `[credential]\n\thelper = "!f() { test \\"$1\\" = get && echo username=${USER} && echo password=${PASS}; }; f"\n`);
  for (const k of ["GIT_ASKPASS", "SSH_ASKPASS"] as const) delete process.env[k];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalWithHelper, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    RMD_HARNESS_HOOKS_DIR: join(root, "harness-hooks") });
  writeFileSync(join(root, "server.js"), SERVER);
  server = spawn(process.execPath, [join(root, "server.js"), served, join(root, "server.log"), `${USER}:${PASS}`, `${USER}:${SOCKET_PASS}`],
    { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve) => server.stdout!.once("data", (d: Buffer) => resolve(d.toString().trim())));
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.kill();
  leaf.setHarnessCredentialSocket?.(undefined);
  for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

describe("W1-T6148: a clean worktree still authenticates through the harness helper and lands", () => {
  it("the leaf push reaches the served remote with the fixture helper's credential", () => {
    const { wt, bare, branch } = cutLane();
    leafPush(wt, branch);
    assert.equal(landed(bare, branch), raw(wt, ["rev-parse", "HEAD"]).trim(), "the push landed in the real remote");
    assert.match(serverLog(), new RegExp(`authorized ${USER}:${PASS} /lane-${n}.git/git-receive-pack`), "it authenticated");
  });
});

describe("W1-T6148: a planted credential helper never runs on a leaf push", () => {
  for (const scope of ["--worktree", "--local"] as const) {
    it(`credential.helper planted with config ${scope}: the control runs it, the leaf push lands without it`, () => {
      const { wt, bare, branch } = cutLane();
      raw(wt, ["config", scope, "--add", "credential.helper", markerCommand(`helper${scope}-${n}`)]);
      raw(wt, ["push", "-q", "origin", `HEAD:refs/heads/control-${branch}`]);
      assert.ok(existsSync(marker(`helper${scope}-${n}`)), "control: the planted helper is live on a raw push");
      rmSync(marker(`helper${scope}-${n}`));
      leafPush(wt, branch);
      assert.equal(existsSync(marker(`helper${scope}-${n}`)), false, "the leaf push never ran the planted helper");
      assert.equal(landed(bare, branch), raw(wt, ["rev-parse", "HEAD"]).trim(), "and still authenticated and landed");
    });
  }
});

describe("W1-T6148: a planted core.askPass never runs", () => {
  for (const scope of ["--worktree", "--local"] as const) {
    it(`core.askPass planted with config ${scope}, no helper: the control runs it, the leaf does not`, () => {
      const { wt, bare, branch } = cutLane();
      const script = join(root, `askpass${scope}-${n}.sh`);
      writeFileSync(script, `#!/bin/sh\ntouch '${marker(`askpass${scope}-${n}`)}'\necho nope\n`, { mode: 0o755 });
      raw(wt, ["config", scope, "core.askPass", script]);
      process.env.GIT_CONFIG_GLOBAL = globalEmpty;
      try {
        assert.throws(() => raw(wt, ["push", "-q", "origin", `HEAD:refs/heads/control-${branch}`]));
        assert.ok(existsSync(marker(`askpass${scope}-${n}`)), "control: the planted askPass is live on a raw push");
        rmSync(marker(`askpass${scope}-${n}`));
        assert.throws(() => leafPush(wt, branch), gitPush.PushFailedError);
        assert.equal(existsSync(marker(`askpass${scope}-${n}`)), false, "the leaf push never ran the planted askPass");
        assert.equal(landed(bare, branch), undefined);
      } finally {
        process.env.GIT_CONFIG_GLOBAL = globalWithHelper;
      }
    });
  }
});

describe("W1-T6148: keys that redirect or include are refused before git runs", () => {
  const decoy = (): string => {
    const dir = join(root, `decoy-${n}.git`);
    execFileSync("git", ["init", "-q", "--bare", dir]);
    return dir;
  };
  const cases: ReadonlyArray<readonly [string, (wt: string, url: string, scope: string) => string]> = [
    ["include.path", (wt, _url, scope) => {
      const included = join(root, `included-${n}`);
      writeFileSync(included, `[credential]\n\thelper = "${markerCommand(`include-${n}`).replace(/"/g, '\\"')}"\n`);
      raw(wt, ["config", scope, "include.path", included]);
      return "";
    }],
    ["remote.origin.pushurl", (wt, _url, scope) => {
      const d = decoy();
      raw(wt, ["config", scope, "remote.origin.pushurl", d]);
      return d;
    }],
    ["url.insteadOf", (wt, url, scope) => {
      const d = decoy();
      raw(wt, ["config", scope, `url.${d}.insteadOf`, url]);
      return d;
    }],
    ["remote.origin.url", (wt, _url, scope) => {
      const d = decoy();
      raw(wt, ["config", scope, ...(scope === "--worktree" ? ["--add"] : []), "remote.origin.url", d]);
      return d;
    }],
  ];
  for (const scope of ["--worktree", "--local"] as const) {
    for (const [name, plant] of cases) {
      it(`${name} planted with config ${scope} is refused by name, and nothing reaches the planted target`, () => {
        const { wt, bare, url, branch } = cutLane();
        const target = plant(wt, url, scope);
        raw(wt, ["push", "-q", "origin", `HEAD:refs/heads/control-${branch}`]);
        const controlled = target === "" ? existsSync(marker(`include-${n}`)) : landed(target, `control-${branch}`) !== undefined;
        assert.ok(controlled, `control: the planted ${name} is live on a raw push`);
        rmSync(marker(`include-${n}`), { force: true });
        const rows: unknown[] = [];
        assert.throws(() => leaf.hostWorktreeGit(wt, ["status"], { log: (step, extra) => rows.push({ step, ...extra }) }),
          (e: unknown) => e instanceof leaf.WorktreeConfigRefusedError);
        assert.equal((rows[0] as { step?: string })?.step, "worktree_git.config_refused", "one named refusal row");
        assert.throws(() => leafPush(wt, branch), isRefusal);
        assert.equal(existsSync(marker(`include-${n}`)), false, "an included helper never ran");
        assert.equal(landed(bare, branch), undefined, "nothing was pushed");
        if (target !== "") assert.equal(landed(target, branch), undefined, "the planted target got nothing");
      });
    }
  }
});

describe("W1-T6148: the per-worktree socket helper is re-added from harness state", () => {
  it("a worktree wired to the daemon's registered socket authenticates through it, a stale one does not", async () => {
    const { wt, bare, branch } = cutLane();
    const socketPath = join(root, `s-${n}.sock`);
    const sockets: Server = createServer((c) => c.once("data", () => c.end(`username=${USER}\npassword=${SOCKET_PASS}\n`)));
    await new Promise<void>((resolve) => sockets.listen(socketPath, resolve));
    try {
      wireCredentialHelperSocket(wt, socketPath);
      process.env.GIT_CONFIG_GLOBAL = globalEmpty;
      leaf.setHarnessCredentialSocket(socketPath);
      await gitPush.worktreePushExecAsync(wt)("git", ["-C", wt, "push", "origin", `HEAD:refs/heads/${branch}`], { stdio: "ignore" });
      assert.equal(landed(bare, branch), raw(wt, ["rev-parse", "HEAD"]).trim());
      assert.match(serverLog(), new RegExp(`authorized ${USER}:${SOCKET_PASS} /lane-${n}.git/git-receive-pack`));
      leaf.setHarnessCredentialSocket(join(root, "another.sock"));
      await assert.rejects(async () => {
        await gitPush.worktreePushExecAsync(wt)("git", ["-C", wt, "push", "origin", `HEAD:refs/heads/x-${branch}`], { stdio: "ignore" });
      }, "a socket the harness does not own is never re-added from the file");
    } finally {
      sockets.close();
      process.env.GIT_CONFIG_GLOBAL = globalWithHelper;
      leaf.setHarnessCredentialSocket?.(undefined);
    }
  });
});

/** A fake codex child: optionally edits `cwd`, then ends its turn with `text`. */
function codexChild(onStart: () => void, text: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough() });
  let prompt = "";
  stdin.on("data", (d: Buffer) => { prompt += d.toString(); });
  return {
    proc,
    prompt: () => prompt,
    finish() {
      onStart();
      for (const event of [{ type: "thread.started", thread_id: "t6148" }, { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", text } }, { type: "turn.completed", usage: {} }]) {
        stdout.write(`${JSON.stringify(event)}\n`);
      }
      stdout.end();
      queueMicrotask(() => proc.emit("exit", 0));
    },
  };
}

async function runCodex(cwd: string, child: ReturnType<typeof codexChild>, extra: Record<string, unknown> = {}, configRoot = root): Promise<{ args: string[]; result: Record<string, unknown> }> {
  let args: string[] = [];
  const pending = provider.spawnCodexWorker({
    workerHome: mkdtempSync(join(root, "codex-home-")), cwd, prompt: "implement the task",
    settingsFile: join(process.cwd(), "settings", "worker.json"), tools: ["Read", "Write", "Edit", "Bash"], ...extra,
    containment: { spawn: (o) => { args = o.args; return { process: child.proc as never, pid: 61_480 }; }, teardown: () => {} },
  }, { claudeBin: "/unused", root: configRoot, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") } } as never);
  child.finish();
  return { args, result: (await pending) as unknown as Record<string, unknown> };
}

describe("W1-T6148: the codex lane has no gitdir grant and the harness commits for it", () => {
  it("a writer's argv names no --add-dir for the tree's git dir or common dir", async () => {
    const { wt } = cutLane();
    // config.root spans the seed and the tree, so the old grant (limited to config.root) would have fired.
    const { args } = await runCodex(wt, codexChild(() => {}, "nothing"), {}, realpathSync(tmpdir()));
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.deepEqual(args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : [])), [], "no writable git administrative root");
  });

  it("the edits a codex writer leaves are committed through the leaf under its COMMIT_MESSAGE, end to end", async () => {
    const { wt, bare, branch } = cutLane();
    const before = raw(wt, ["rev-parse", "HEAD"]).trim();
    const child = codexChild(() => writeFileSync(join(wt, "codex.txt"), "edit\n"), "done\nCOMMIT_MESSAGE: feat(codex): the edit");
    const { result } = await runCodex(wt, child);
    assert.match(child.prompt(), /The harness commits every change you leave/, "the worker is told it cannot commit");
    assert.equal(raw(wt, ["log", "-1", "--format=%s"]).trim(), "feat(codex): the edit");
    assert.equal(raw(wt, ["rev-parse", "HEAD~1"]).trim(), before);
    assert.equal(raw(wt, ["status", "--porcelain"]).trim(), "", "nothing left uncommitted");
    assert.equal((result.harnessCommit as { outcome?: string })?.outcome, "committed");
    leafPush(wt, branch);
    assert.equal(landed(bare, branch), raw(wt, ["rev-parse", "HEAD"]).trim(), "and the run branch pushes as before");
  });

  it("a caller that owns git (a declared cash surface) commits itself; the codex spawn leaves the edits", async () => {
    const { wt } = cutLane();
    const head = raw(wt, ["rev-parse", "HEAD"]).trim();
    const child = codexChild(() => writeFileSync(join(wt, "left.txt"), "edit\n"), "COMMIT_MESSAGE: feat: left");
    await runCodex(wt, child, { cashTools: ["Read", "Write"] });
    assert.equal(raw(wt, ["rev-parse", "HEAD"]).trim(), head);
    assert.match(raw(wt, ["status", "--porcelain"]), /left\.txt/);
  });
});

describe("W1-T6148: the rendered Claude worker settings deny writes to both git dirs' config", () => {
  it("denyWrite covers the common dir's and the linked gitdir's config, pointers and hooks", () => {
    const out = join(root, "rendered.json");
    renderWorkerSettings({ templatePath: join(process.cwd(), "settings", "worker.json"), hooksDir: "/hooks", outPath: out });
    const deny: string[] = JSON.parse(readFileSync(out, "utf8")).sandbox?.filesystem?.denyWrite ?? [];
    // `~` is the worker's redirected HOME, config.root/worker-home-<run>, so `~/..` is config.root ("/r" here).
    const esc = (t: string) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const glob = (g: string) => new RegExp(`^${g.replace(/^~\/\.\./, "/r").split("**").map((p) => p.split("*").map(esc).join("[^/]*")).join(".*")}$`);
    for (const path of ["/r/repos/x/.git/config", "/r/repos/x/.git/config.worktree", "/r/repos/x/.git/hooks/pre-push",
      "/r/repos/x/.git/worktrees/run-1/config.worktree", "/r/repos/x/.git/worktrees/run-1/commondir"]) {
      assert.ok(deny.some((g) => glob(g).test(path)), `the Claude sandbox denies writing ${path}`);
    }
    assert.equal(deny.some((g) => /objects|refs|index|logs/.test(g)), false, "objects, refs, the index and logs stay writable");
  });
});
