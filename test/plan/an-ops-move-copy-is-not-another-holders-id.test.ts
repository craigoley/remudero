// `rmd move-task --apply` (W1-T13680) refused its first live copy, W1-T13601 on 2026-11-19, at the plan-PR
// preflight's task-id-existence: the copy ADDS the id to the ops catalog, so the holder half read the public
// reservation (held by the public filer's branch) and refused the mover's plan-move- branch as a rival holder.
// Every id the copy cites already resolved through --code-root (W1-T12205). A byte-verified move now skips the
// holder half; an id that resolves nowhere, and a copy that is not the public record, are still refused.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { formatReservationAnchorMessage } from "#src/lib/task-id-reservation.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const gate = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

const MOVED = "W1-T950";
const PATH = `plan/tasks.d/${MOVED}-a-moved-record.yaml`;
const MOVER_BRANCH = `plan-move-${MOVED}-1795090000000`;
const record = (cites: string) => `- id: ${MOVED}\n  title: a moved record\n  depends_on: [${cites}]\n  status: queued\n`;

function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

/** A public origin holding refs/rmd-id for the cited and moved ids (the moved one held by its public filer), a
 *  public checkout declaring both records, and an ops checkout whose working tree adds the mover's copy. */
function world(t: TestContext, opts: { cites?: string; edit?: (copy: string) => string } = {}) {
  const root = ownedFixtureDir(t, "ops-move-copy").dir;
  const code = gitRepo({ scope: t, kind: "move-public" });
  const ops = gitRepo({ scope: t, kind: "move-ops" });
  const origin = gitRepo({ bare: true, scope: t }); const opsOrigin = gitRepo({ bare: true, scope: t });
  code.addRemote("origin", origin.dir); ops.addRemote("origin", opsOrigin.dir);
  const original = record(opts.cites ?? "W1-T940");
  put(join(code.dir, "plan/tasks.yaml"), "- id: W1-T940\n  title: a public task the moved record depends on\n");
  put(join(code.dir, PATH), original);
  code.git("add", "--all"); code.git("commit", "-qm", "public catalog");
  const publicCommit = code.git("rev-parse", "HEAD");
  code.git("push", "--quiet", "origin", "HEAD:refs/rmd-id/W1-T940");
  const anchor = code.git("commit-tree", "HEAD^{tree}", "-m", formatReservationAnchorMessage({ branch: "public-filer", startedAt: new Date().toISOString() }));
  code.git("push", "--quiet", "origin", `${anchor}:refs/rmd-id/${MOVED}`);
  put(join(ops.dir, "plan/tasks.yaml"), "[]\n");
  ops.git("add", "--all"); ops.git("commit", "-qm", "ops catalog");
  ops.git("update-ref", "refs/remotes/origin/main", "HEAD");
  // The copy exactly as movePlanTask writes it: the public bytes plus one moved_from line after the id line.
  const copy = original.replace(`- id: ${MOVED}\n`, `- id: ${MOVED}\n  moved_from: remudero@${publicCommit}\n`);
  put(join(ops.dir, PATH), (opts.edit ?? (s => s))(copy));
  const baseline = join(root, "baseline.json"); put(baseline, "[]\n");
  const shim = ghShim([{ when: "repos/fixture-owner/fixture-ops/pulls?", stdout: "[]" }], { kind: "ops-move-copy" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const argv = ["--cwd", ops.dir, "--code-root", code.dir, "--dir", "plan", "--baseline", baseline, "--base", "origin/main",
    "--head-ref", MOVER_BRANCH, "--owner", "fixture-owner", "--repo", "fixture-ops", "--require-open-prs"];
  return { code, ops, argv, publicCommit };
}

function runGateMain(argv: string[]): { out: string; err: string; exitCode: string | number | undefined } {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const out: string[] = []; const err: string[] = [];
  const log = console.log; const error = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    gate.main(argv);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = log; console.error = error; process.exitCode = previousExitCode;
  }
}

test("an ops move copy citing a public id passes task-id-existence under the mover's own branch", (t) => {
  const w = world(t);
  const r = runGateMain(w.argv);
  assert.equal(r.exitCode ?? 0, 0, `${r.out}\n${r.err}`);
  assert.doesNotMatch(r.err, /HELD by a different reservation holder/);
  assert.match(r.out, new RegExp(`${MOVED} is a verified move of the public record at remudero@${w.publicCommit}`));
  assert.match(r.out, /task-id-existence: OK/);
});

test("a move copy citing an id that resolves in neither catalog nor any reservation still fails", (t) => {
  const r = runGateMain(world(t, { cites: "W1-T940, W1-T999" }).argv);
  assert.equal(r.exitCode, 1, r.out);
  assert.match(r.err, /resolve to NEITHER a reservation ref NOR a declared plan record/);
  assert.match(r.err, /^ {2}W1-T999$/m);
  assert.doesNotMatch(r.err, /HELD by a different reservation holder/);
});

test("an ops record that is not byte for byte the public record keeps the holder refusal", (t) => {
  const r = runGateMain(world(t, { edit: copy => copy.replace("status: queued", "status: ready") }).argv);
  assert.equal(r.exitCode, 1, r.out);
  assert.match(r.err, new RegExp(`${MOVED} -- reserved by public-filer, while this filing is ${MOVER_BRANCH}`));
  assert.doesNotMatch(r.out, /verified move/);
});

test("verifiedMoveIds proves a move only with a code root, one moved_from line and a readable public original", (t) => {
  const w = world(t);
  const occurrences = new Map([[MOVED, [{ file: PATH, line: 1 }]]]);
  assert.deepEqual([...gate.verifiedMoveIds([MOVED], occurrences, w.ops.dir, w.code.dir)], [[MOVED, w.publicCommit]]);
  assert.equal(gate.verifiedMoveIds([MOVED], occurrences, w.ops.dir, undefined).size, 0, "no code root: no move");
  assert.equal(gate.verifiedMoveIds([MOVED], new Map(), w.ops.dir, w.code.dir).size, 0, "no declaring file: no move");
  const missing = "0".repeat(40);
  put(join(w.ops.dir, PATH), record("W1-T940").replace(`- id: ${MOVED}\n`, `- id: ${MOVED}\n  moved_from: remudero@${missing}\n`));
  assert.equal(gate.verifiedMoveIds([MOVED], occurrences, w.ops.dir, w.code.dir).size, 0, "an unreadable public commit: no move");
  put(join(w.ops.dir, PATH), record("W1-T940").replace(`- id: ${MOVED}\n`, `- id: ${MOVED}\n  moved_from: remudero@${w.publicCommit}\n  moved_from: remudero@${w.publicCommit}\n`));
  assert.equal(gate.verifiedMoveIds([MOVED], occurrences, w.ops.dir, w.code.dir).size, 0, "two moved_from lines: no move");
});
