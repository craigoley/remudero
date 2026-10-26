/**
 * W1-T10325 — the pre-open gate argv for an engine-backed run is deterministic and host-independent, so the
 * check that guards it cannot fail a round on a runner quirk: it needs no bwrap and no PATH lookup.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { preopenGateEnv, preopenGateSandboxArgv } from "#src/lib/preopen-gate.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("W1-T10325: check:test:test/an-engine-backed-gate-starts-sandboxed.test.ts is prevented, not retried", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-engine-prevent-`)));
  dirs.push(root);
  const canonical = join(root, "remudero");
  mkdirSync(join(canonical, "node_modules"), { recursive: true });
  const engine = join(root, "state", "engines", "e".repeat(64));
  mkdirSync(engine, { recursive: true });
  symlinkSync(join(canonical, "node_modules"), join(engine, "node_modules"));
  writeFileSync(join(engine, ".git"), "gitdir: /elsewhere\n");
  const work = join(root, "worktrees", "run-W1-T0-1");
  mkdirSync(work, { recursive: true });
  symlinkSync(join(engine, "node_modules"), join(work, "node_modules"));
  const home = join(root, "home");
  mkdirSync(home);
  const input = { cwd: work, home, harnessRoot: engine, env: preopenGateEnv(home, { PATH: process.env.PATH }) };

  const first = preopenGateSandboxArgv(input, {});
  assert.deepEqual(preopenGateSandboxArgv(input, {}), first, "the argv is a pure function of its input");
  const pairs = (flag: string) => first.flatMap((a, i) => (a === flag ? [[first[i + 1]!, first[i + 2]!]] : []));
  assert.ok(!pairs("--ro-bind").some(([, to]) => to === join(engine, "node_modules")), "the engine's own link is never a bind destination");
  assert.ok(pairs("--ro-bind").some(([from, to]) => from === to && to === engine), "the harness is bound read-only");
  assert.ok(pairs("--bind").some(([from, to]) => from === to && to === work), "the worktree stays writable");
  assert.ok(first.includes("--unshare-net") && first.at(-1) === "--");
});
