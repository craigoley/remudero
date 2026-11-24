import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14716 (invariant checkout-registry-never-pages-under-test): under a test runner a daemon boot pages the SRE lane
// only for a registry outside the checkout it runs from. The guard-mutation ratchet runs suites from a scratch copy of
// the checkout under tmpdir, where the checkout's own registry used to look like a tmpdir fixture and page.

/** A registry with exactly one live primary, so an unresolved lane on the container state root would page. */
const REGISTRY = ["instances:", "  core:", "    github_repo: craigoley/remudero", "    primary: true",
  "    state_dir: /srv/host-core-state", ""].join("\n");

/** The state root inside a daemon container, which no registry state_dir names: the lane stays unresolved. */
const CONTAINER_ROOT = "/home/node/Remudero";

function scratch(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14716-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Boot the SRE lane in a child process whose checkout (`--repo-root`) is `checkout`; returns the pages it raised. */
function bootPages(t: TestContext, checkout: string, registry: string): number {
  writeFileSync(registry, REGISTRY);
  const script = join(scratch(t, "script"), "boot.mjs");
  writeFileSync(script, [
    `const { daemonSreLaneEnabled } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src/cli/commands/daemon.ts")).href)});`,
    "let pages = 0;",
    "const page = { escalate: async () => { pages += 1; }, clear: async () => undefined };",
    `await daemonSreLaneEnabled(${JSON.stringify(CONTAINER_ROOT)}, ${JSON.stringify(checkout)}, () => undefined, page);`,
    "process.stdout.write(`PAGES=${pages}\\n`);",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_INSTANCE_REGISTRY: registry, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child" };
  for (const name of ["RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_NAME", "RMD_SRE_LANE"]) delete env[name];
  const run = spawnSync(process.execPath, ["--import", "tsx", script, "--repo-root", checkout],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000 });
  const m = /^PAGES=(\d+)$/m.exec(run.stdout ?? "");
  assert.ok(m, `the child boot reported its pages (status ${run.status}): ${run.stderr}`);
  return Number(m[1]);
}

test("W1-T14716: a daemon boot from a checkout under tmpdir pages no SRE lane", (t) => {
  const checkout = scratch(t, "checkout");
  assert.equal(bootPages(t, checkout, join(checkout, "daemon-instances.yaml")), 0,
    "the checkout's own registry never pages under test, though the checkout sits under tmpdir");

  // Positive control: the same boot from the same checkout pages for a fixture registry outside it, so the zero above
  // is the guard, not a boot that could never page.
  const fixture = scratch(t, "fixture");
  assert.equal(bootPages(t, checkout, join(fixture, "daemon-instances.yaml")), 1);
});
