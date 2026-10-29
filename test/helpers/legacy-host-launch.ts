import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** Run the shipped scripts with a disposable legacy default, without an explicit private selection. */
export function legacyHostScript(root: string, script: string, registry?: string): string {
  const host = join(root, "legacy-host");
  const deploy = join(host, "deploy");
  mkdirSync(deploy, { recursive: true });
  for (const entry of readdirSync(join(REPO_ROOT, "deploy"))) {
    if (!entry.endsWith(".sh")) continue;
    writeFileSync(join(deploy, entry), readFileSync(join(REPO_ROOT, "deploy", entry)));
  }
  // Preserve a caller's mutation of the actual launcher while retaining its shipped dependencies.
  const target = join(deploy, basename(script));
  writeFileSync(target, readFileSync(resolve(script)));
  mkdirSync(join(host, ".remudero"), { recursive: true });
  writeFileSync(join(host, ".remudero", "daemon-instances.yaml"), registry === undefined ? "instances:\n" : readFileSync(registry));
  return target;
}

export function withoutRegistrySelection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("RMD_INSTANCE_REGISTRY")));
}
