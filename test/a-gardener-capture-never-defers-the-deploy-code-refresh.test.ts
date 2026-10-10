/**
 * 2026-10-10 04:39Z: the host-resource gardener handed a pinned-memory incident to SRE, and its
 * `captureFeedback(repoRoot, …)` wrote `plan/feedback/host-mem-<fp>.yaml` UNTRACKED into core's
 * live daemon checkout. The watchdog's `deploy_code_clean` read every `git status --porcelain
 * --untracked-files=all` line as a local edit, so every tick logged "deploy code -- local edits;
 * deferring" and core's code froze at one sha while main moved on.
 *
 * An untracked `plan/feedback/` file is the feedback-landing lane's inbox: the lane lands it and
 * removes the copy once origin/main holds its bytes (`acknowledgeLandedQueueCopies`). This suite
 * writes each gardener handoff's capture (disk, io, memory) into a REAL clone and runs the REAL
 * rendered `deploy_code_clean`: the capture must not defer it, and must survive it byte for byte.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureFeedback, feedbackEntryPath, type FeedbackOrigin } from "../src/lib/feedback.js";
import { incidentOrigin, ioIncidentOrigin, memoryIncidentOrigin } from "../src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

/** The rendered launcher's own `deploy_code_clean` body — the function the watchdog runs. */
function renderedCleanFunction(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-clean-render-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, "launcher");
  const render = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], {
    encoding: "utf8",
    env: { ...process.env, RMD_STATE_DIR: join(root, "state-root"), RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "bin"), RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(root, "revivals"), RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(render.status, 0, render.stderr);
  const body = /^deploy_code_clean\(\) \{\n[\s\S]*?\n\}$/m.exec(readFileSync(launcher, "utf8"));
  assert.ok(body, "the rendered launcher defines deploy_code_clean");
  return body[0];
}

interface DaemonHost {
  state: string;
  origin: GitRepo;
  daemon: GitRepo;
  clean: () => { status: number | null; stderr: string };
}

/** A bare origin, a daemon clone of it at `<state>/remudero`, and the real clean check over it. */
function daemonHost(t: TestContext): DaemonHost {
  const fn = renderedCleanFunction(t);
  const origin = gitRepo({ bare: true, kind: "deploy-clean-origin" });
  const seed = gitRepo({ kind: "deploy-clean-seed" });
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "feedback", "evidence-coverage-tracked.yaml"), "id: evidence-coverage-tracked\nstatus: new\n");
  seed.git("add", ".");
  seed.git("commit", "--quiet", "-m", "seed a tracked capture");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "deploy-clean-daemon" });
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-clean-state-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  symlinkSync(daemon.dir, join(state, "remudero"), "dir");
  const clean = () => {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\ndeploy_code_clean`], { encoding: "utf8", env: { ...process.env, STATE_DIR: state } });
    return { status: r.status, stderr: r.stderr };
  };
  return { state, origin, daemon, clean };
}

/** What host-resource-gardener's handoff port writes for one incident: its id shape and real
 *  origin, through the same `captureFeedback`; landing is offline here, as when GitHub is down. */
function gardenerHandoff(root: string, prefix: string, origin: string): string {
  const id = `${prefix}-${origin.slice("incident#".length, "incident#".length + 16)}`;
  const offline = () => {
    throw new Error("fixture: no network");
  };
  captureFeedback(root, { id, origin: origin as FeedbackOrigin, raw: `${prefix}\n\nevidence`, land: { git: offline, gh: offline } });
  return feedbackEntryPath(root, id);
}

const DISK = { prefix: "host-resource", origin: incidentOrigin("Remudero", "state") };
const IO = { prefix: "host-io", origin: ioIncidentOrigin("Remudero", "sda") };
const MEMORY = { prefix: "host-mem", origin: memoryIncidentOrigin("Remudero", "rmd-daemon") };

function assertCaptureNeverDefers(t: TestContext, h: { prefix: string; origin: string }): void {
  const host = daemonHost(t);
  const path = gardenerHandoff(host.daemon.dir, h.prefix, h.origin);
  const bytes = readFileSync(path, "utf8");
  // Precondition: the capture really is untracked in the checkout the watchdog reads.
  assert.match(host.daemon.git("status", "--porcelain", "--untracked-files=all"), new RegExp(`^\\?\\? plan/feedback/${h.prefix}-[0-9a-f]{16}\\.yaml$`));
  const r = host.clean();
  assert.doesNotMatch(r.stderr, /local edits/, r.stderr);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path), "the capture is never discarded");
  assert.equal(readFileSync(path, "utf8"), bytes, "the capture's bytes are untouched");
}

test("a disk gardener handoff's capture never makes deploy_code_clean defer, and survives it", (t) => assertCaptureNeverDefers(t, DISK));
test("a io gardener handoff's capture never makes deploy_code_clean defer, and survives it", (t) => assertCaptureNeverDefers(t, IO));
test("a memory gardener handoff's capture never makes deploy_code_clean defer, and survives it", (t) => assertCaptureNeverDefers(t, MEMORY));

test("with a capture in the inbox, the refresh's ff-only merge still advances and keeps the capture", (t) => {
  const host = daemonHost(t);
  const path = gardenerHandoff(host.daemon.dir, MEMORY.prefix, MEMORY.origin);
  const ahead = gitRepo({ cloneFrom: host.origin.dir, kind: "deploy-clean-ahead" });
  writeFileSync(join(ahead.dir, "src.ts"), "export {};\n");
  ahead.git("add", "src.ts");
  ahead.git("commit", "--quiet", "-m", "main moves on");
  ahead.git("push", "--quiet", "origin", "main");
  assert.equal(host.clean().status, 0);
  host.daemon.git("fetch", "--quiet", "origin", "main");
  host.daemon.git("merge", "--ff-only", "--quiet", "origin/main");
  assert.equal(host.daemon.git("rev-parse", "HEAD"), ahead.git("rev-parse", "HEAD"));
  assert.ok(existsSync(path), "the fast-forward keeps the capture");
  assert.equal(host.clean().status, 0, "the post-merge clean check passes too");
});

test("anything else still defers: a stray untracked file, an edited tracked capture, a sibling directory", (t) => {
  const cases: Array<[string, (dir: string) => void]> = [
    ["untracked source", (dir) => writeFileSync(join(dir, "stray.ts"), "x\n")],
    ["modified tracked capture", (dir) => writeFileSync(join(dir, "plan", "feedback", "evidence-coverage-tracked.yaml"), "edited\n")],
    ["untracked sibling of the inbox", (dir) => {
      mkdirSync(join(dir, "plan", "feedback-other"), { recursive: true });
      writeFileSync(join(dir, "plan", "feedback-other", "x.yaml"), "x\n");
    }],
  ];
  for (const [name, dirty] of cases) {
    const host = daemonHost(t);
    gardenerHandoff(host.daemon.dir, MEMORY.prefix, MEMORY.origin);
    dirty(host.daemon.dir);
    const r = host.clean();
    assert.equal(r.status, 1, `${name}: must defer`);
    assert.match(r.stderr, /local edits; deferring without discarding them/, name);
  }
});
