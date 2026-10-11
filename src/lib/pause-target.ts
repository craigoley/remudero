import { existsSync } from "node:fs";

import { daemonInstanceRows, instanceForStateRoot } from "./deployer.js";
import { parseInstanceRegistry } from "./instance-registry.js";

/**
 * W1-T7727 — WHICH INSTANCE A `rmd pause` OR `rmd resume` ACTS ON.
 *
 * Core, site and console run the same checkout against the same origin, each from its own state
 * root (the registry's `state_dir`, bind-mounted as the container's `config.root`). The PAUSE flag
 * under that root is therefore already one instance's; what coupled them was the fleet-wide
 * `refs/rmd-pause/hold` the CLI pushed by default. A pause now targets ONE instance, resolved only
 * through the registry and the config — never from the cwd, the repository, the hostname or a pid:
 *   - `--instance <name>`: a declared, live registry row whose `state_dir` this process can reach;
 *   - no flag: `config.root` must be exactly one declared instance's `state_dir`
 *     ({@link instanceForStateRoot}, the match every other per-instance lookup uses).
 * Anything else is a refusal the caller prints BEFORE writing anything.
 */
export interface PauseTarget {
  instance: string;
  /** The instance's state root: the flag lives at `<root>/state/PAUSE`, its ledger under `<root>/state/`. */
  root: string;
  resolvedBy: "--instance" | "config-root";
}

export type PauseTargetResolution = { ok: true; target: PauseTarget } | { ok: false; refusal: string };

export interface PauseTargetInput {
  /** The process's own `config.root`. */
  configRoot: string;
  /** `--instance <name>`, when given. */
  instance?: string;
  /** The registry's text; `undefined` when it could not be read. */
  registryText: string | undefined;
  /** Where the registry was read from, named in every refusal. */
  registryPath: string;
  /** Whether a directory exists from this process; injectable for a test. */
  dirExists?: (dir: string) => boolean;
}

const INSTANCE_NAME = /^[A-Za-z0-9_-]+$/;

export function resolvePauseTarget(input: PauseTargetInput): PauseTargetResolution {
  const refuse = (why: string): PauseTargetResolution => ({ ok: false, refusal: `${why} — nothing was changed` });
  const dirExists = input.dirExists ?? existsSync;
  if (input.instance !== undefined && !INSTANCE_NAME.test(input.instance)) {
    return refuse(`--instance '${input.instance}' is not an instance name`);
  }
  if (input.registryText === undefined) {
    return refuse(`cannot tell which instance to act on: the instance registry ${input.registryPath} is unreadable`);
  }
  let live: Set<string>;
  try {
    live = new Set(parseInstanceRegistry(input.registryText).instances.filter((i) => i.live).map((i) => i.name));
  } catch (error) {
    // A registry the parser refuses is not "no instances": it is a refusal that names the parser's reason.
    return { ok: false, refusal: `cannot tell which instance to act on: ${(error as Error).message} (${input.registryPath}) — nothing was changed` };
  }
  const rows = daemonInstanceRows(input.registryText);
  const declared = [...live].filter((name) => rows.has(name)).sort();
  if (input.instance !== undefined) {
    const row = rows.get(input.instance);
    if (row === undefined) {
      return refuse(`--instance '${input.instance}' is not a declared instance with a state_dir in ${input.registryPath} (declared: ${declared.join(", ") || "none"})`);
    }
    if (!live.has(input.instance)) return refuse(`--instance '${input.instance}' is retired in ${input.registryPath}`);
    if (!dirExists(row.stateDir)) {
      return refuse(`instance '${input.instance}' state_dir ${row.stateDir} is not reachable from this process — run this on the host that holds it`);
    }
    return { ok: true, target: { instance: input.instance, root: row.stateDir, resolvedBy: "--instance" } };
  }
  const name = instanceForStateRoot(input.registryText, input.configRoot);
  if (name === undefined) {
    const want = input.configRoot.replace(/\/+$/, "");
    const matches = [...rows].filter(([, row]) => row.stateDir.replace(/\/+$/, "") === want).map(([n]) => n);
    return refuse(
      matches.length > 1
        ? `config.root ${input.configRoot} is the state_dir of ${matches.length} instances (${matches.join(", ")}) in ${input.registryPath}; pass --instance <name>`
        : `config.root ${input.configRoot} is not the state_dir of any instance in ${input.registryPath}; pass --instance <name> (declared: ${declared.join(", ") || "none"})`,
    );
  }
  if (!live.has(name)) return refuse(`config.root ${input.configRoot} belongs to instance '${name}', which is retired in ${input.registryPath}`);
  if (!dirExists(input.configRoot)) {
    return refuse(`instance '${name}' state_dir ${input.configRoot} is not reachable from this process — run this on the host that holds it`);
  }
  return { ok: true, target: { instance: name, root: input.configRoot, resolvedBy: "config-root" } };
}
