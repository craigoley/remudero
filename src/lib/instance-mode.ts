import { readFileSync } from "node:fs";

import { daemonInstanceRegistryPath } from "./deployer.js";
import { parseInstanceRegistry } from "./instance-registry.js";

/** A missing or malformed registry never invents a shadow declaration. */
export function instanceMode(ownerRepo: string, registryText: string | undefined): "shadow" | "live" {
  if (registryText === undefined) return "live";
  try {
    const registry = parseInstanceRegistry(registryText);
    const match = registry.instances.find((instance) => instance.repo.toLowerCase() === ownerRepo.toLowerCase());
    return match?.mode ?? "live";
  } catch {
    // Invalid text grants no shadow declaration. Preserve the documented absent-mode live policy.
    return "live";
  }
}

/** A missing or unreadable registry is unknown text, which resolves to live above. */
export function readInstanceRegistryText(repoRoot: string): string | undefined {
  try {
    return readFileSync(daemonInstanceRegistryPath(repoRoot), "utf8");
  } catch {
    // A missing/unreadable registry cannot establish shadow mode; legacy installs remain live.
    return undefined;
  }
}
