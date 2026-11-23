import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { planTaskMovePorts } from "#src/lib/plan-task-move-janitor.js";
import { formatReservationAnchorMessage } from "#src/lib/task-id-reservation.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { moveWorld, OPS, PUBLIC, record, shard } from "#test/helpers/plan-move-world.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GATE_SCRIPT = join(REPO_ROOT, "scripts", "task-id-existence-check.mjs");
const gate = await import(pathToFileURL(GATE_SCRIPT).href);

const MOVED = "W1-T960";
const PATH = shard(MOVED);
const MOVER_BRANCH = `plan-move-${MOVED}-1795090000000`;
const TRACKING = "refs/remotes/origin/main";
const ON = { outcome: "on", repository: OPS, checkoutDir: "" } as const;

function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

/** A public origin whose main gained the moved record after the code root last fetched, so the code root's
 *  origin/main trails the live head and lacks its objects; an ops clone whose working tree holds the mover's copy. */
function trailingWorld(t: TestContext) {
  const w = moveWorld(t, {});
  const code = w.pub.clone, ops = w.ops.clone;
  const seeded = code.git("rev-parse", TRACKING);
  // Another writer lands the public record; the code root does not fetch it.
  const writer = gitRepo({ cloneFrom: w.pub.origin.dir, scope: t, kind: "public-writer" });
  put(join(writer.dir, PATH), record(MOVED));
  writer.git("add", PATH);
  writer.git("commit", "--quiet", "-m", "file the public record");
  writer.git("push", "--quiet", "origin", "HEAD:main");
  const pinned = w.main("public");
  const anchor = w.pub.origin.git("commit-tree", `${pinned}^{tree}`, "-m",
    formatReservationAnchorMessage({ branch: "public-filer", startedAt: new Date().toISOString() }));
  w.pub.origin.git("update-ref", `refs/rmd-id/${MOVED}`, anchor);
  // The gate reads owner/repo from the plan checkout's origin URL, as on the host.
  ops.git("remote", "set-url", "origin", `https://github.com/${OPS}.git`);
  const writeCopy = (...shas: string[]) => put(join(ops.dir, PATH), record(MOVED).replace(`- id: ${MOVED}\n`,
    `- id: ${MOVED}\n${shas.map(sha => `  moved_from: remudero@${sha}\n`).join("")}`));
  writeCopy(pinned);
  put(join(code.dir, "scripts", "task-id-existence-baseline.json"), "[]\n");
  const shim = ghShim([{ when: `repos/${OPS}/pulls?`, stdout: "[]" }], { kind: "move-copy-trails" });
  const env = { ...w.env, PATH: `${shim.dir}:${process.env.PATH ?? ""}`, RMD_SELF_SYNC_DONE: "1" };
  const ports = planTaskMovePorts({ publicRoot: code.dir, publicRepository: PUBLIC, readSwitch: () => ({ move: ON, dispatch: ON }),
    readOpsCatalog: () => "ok", cliEntry: "unused" });
  /** The janitor's production head read, with the world's URL rewrites in this process's environment. */
  const readHeads = async (publicRoot = code.dir) => {
    const read = publicRoot === code.dir ? ports : planTaskMovePorts({ publicRoot, publicRepository: PUBLIC,
      readSwitch: () => ({ move: ON, dispatch: ON }), readOpsCatalog: () => "ok", cliEntry: "unused" });
    const previous = new Map(Object.keys(w.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, w.env);
    try { return await read.readHeads({ repository: OPS, checkoutDir: ops.dir }); }
    finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };
  /** The task-id gate, launched as the plan-PR emitter launches it for an ops plan PR with a public code root. */
  const runGate = () => {
    const r = spawnSync(process.execPath, [GATE_SCRIPT, "--base", "origin/main", "--require-open-prs", "--head-ref", MOVER_BRANCH,
      "--code-root", code.dir, "--baseline", join(code.dir, "scripts", "task-id-existence-baseline.json")],
    { cwd: ops.dir, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const occurrences = new Map([[MOVED, [{ file: PATH, line: 1 }]]]);
  const verify = (root = code.dir) => gate.verifiedMoveIds([MOVED], occurrences, ops.dir, root);
  const holderRefusal = new RegExp(`${MOVED} -- reserved by public-filer, while this filing is ${MOVER_BRANCH}`);
  return { w, code, ops, seeded, pinned, writer, writeCopy, readHeads, runGate, verify, holderRefusal };
}

test("W1-T14387 criterion 1: after the janitor's head read fetches the live head, a trailing tracking ref moves to it and the gate passes the move copy", async (t) => {
  const x = trailingWorld(t);
  assert.notEqual(x.seeded, x.pinned, "control: the code root's tracking ref trails the live head");
  assert.notEqual(spawnSync("git", ["-C", x.code.dir, "cat-file", "-e", `${x.pinned}^{commit}`]).status, 0, "control: the head's objects are absent");
  const before = x.runGate();
  assert.equal(before.status, 1, "control: with the trailing ref the gate refuses the copy");
  assert.match(before.err, x.holderRefusal);

  const pin = await x.readHeads();
  assert.equal(pin.publicCommit, x.pinned, "the head read names the live head");
  assert.equal(x.code.git("cat-file", "-t", x.pinned), "commit", "and fetched it");
  assert.equal(x.code.git("rev-parse", TRACKING), x.pinned, "the tracking ref moved to the live head");
  assert.deepEqual([...x.verify()], [[MOVED, x.pinned]], "verifiedMoveIds gives the moved id");
  const after = x.runGate();
  assert.equal(after.status, 0, `${after.out}\n${after.err}`);
  assert.match(after.out, new RegExp(`${MOVED} is a verified move of the public record at remudero@${x.pinned}`));
  assert.match(after.out, /task-id-existence: OK/);
  assert.equal(x.ops.git("rev-parse", TRACKING), x.ops.git("rev-parse", "HEAD"), "the ops side's ref is unchanged");
});

test("W1-T14387 criterion 2: the tracking ref moves only as a fast-forward to the remote head", async (t) => {
  // A tracking ref the live head does not descend from stays where it is, and the gate keeps the holder refusal.
  const diverged = trailingWorld(t);
  const stray = diverged.code.git("commit-tree", `${diverged.seeded}^{tree}`, "-m", "a commit public main never held");
  diverged.code.git("update-ref", TRACKING, stray);
  assert.equal((await diverged.readHeads()).publicCommit, diverged.pinned);
  assert.equal(diverged.code.git("rev-parse", TRACKING), stray, "a pin that does not descend from the ref leaves it unchanged");
  assert.equal(diverged.verify().size, 0);
  const refused = diverged.runGate();
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.err, diverged.holderRefusal);

  // A remote HEAD that is not main's head leaves the ref unchanged.
  const side = trailingWorld(t);
  side.writer.git("checkout", "--quiet", "-b", "side");
  side.writer.git("commit", "--quiet", "--allow-empty", "-m", "a side branch commit");
  side.writer.git("push", "--quiet", "origin", "side");
  side.w.pub.origin.git("symbolic-ref", "HEAD", "refs/heads/side");
  const sideHead = side.w.pub.origin.git("rev-parse", "side");
  assert.equal((await side.readHeads()).publicCommit, sideHead, "control: ls-remote names the side branch as HEAD");
  assert.equal(side.code.git("rev-parse", TRACKING), side.seeded, "a head that is not main leaves the ref unchanged");
  side.writeCopy(sideHead);
  assert.equal(side.verify().size, 0);

  // An unpublished local commit with the record's bytes is never where the ref goes, and never proves a move.
  const local = trailingWorld(t);
  put(join(local.code.dir, PATH), record(MOVED));
  local.code.git("add", PATH);
  local.code.git("commit", "--quiet", "-m", "an unpublished copy of the record");
  const unpublished = local.code.git("rev-parse", "HEAD");
  await local.readHeads();
  assert.equal(local.code.git("rev-parse", TRACKING), local.pinned, "the ref moves to the remote head only");
  local.writeCopy(unpublished);
  assert.equal(local.verify().size, 0);
  const localGate = local.runGate();
  assert.equal(localGate.status, 1, localGate.out);
  assert.match(localGate.err, local.holderRefusal);
});

test("W1-T14387 criterion 3: after the ref moves, the gate's other refusals still fail verifiedMoveIds", async (t) => {
  const x = trailingWorld(t);
  await x.readHeads();
  assert.deepEqual([...x.verify()], [[MOVED, x.pinned]], "control: the proof passes");
  put(join(x.code.dir, PATH), record(MOVED));
  x.code.git("add", PATH);
  x.code.git("commit", "--quiet", "-m", "an unpublished local commit");
  x.code.git("tag", "-am", "tag of the public record", "public-record", x.pinned);
  const cases: [string, string[]][] = [
    ["a tree", [x.code.git("rev-parse", `${x.pinned}^{tree}`)]],
    ["an annotated tag", [x.code.git("rev-parse", "refs/tags/public-record")]],
    ["an unpublished local commit", [x.code.git("rev-parse", "HEAD")]],
    ["two moved_from lines", [x.pinned, x.pinned]],
    ["no moved_from line", []],
  ];
  for (const [reason, shas] of cases) {
    x.writeCopy(...shas);
    assert.equal(x.verify().size, 0, reason);
  }

  // A code root with the head's objects and no tracking ref: the head read writes none, and no move is proved.
  x.writeCopy(x.pinned);
  const bare = gitRepo({ scope: t, seedCommit: false, kind: "untracked-code" });
  bare.git("fetch", "--quiet", "--no-write-fetch-head", x.w.pub.origin.dir, "refs/heads/main");
  assert.equal(bare.git("cat-file", "-t", x.pinned), "commit", "control: the objects are local");
  await x.readHeads(bare.dir);
  assert.equal(spawnSync("git", ["-C", bare.dir, "rev-parse", "--verify", "--quiet", TRACKING]).status, 1, "a missing tracking ref stays missing");
  assert.equal(x.verify(bare.dir).size, 0, "a missing tracking ref");
});
