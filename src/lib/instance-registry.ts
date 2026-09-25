/**
 * W1-T4227 — THE FLEET'S ONE REGISTRY: the repo-tracked `daemon-instances.yaml`, read as
 * Account → Project → Repository → Instance.
 *
 * Before this module the fleet's repos and instances lived in four places that disagreed (the
 * console's hard-coded repository list, core's `managed-repos.json`, the host's
 * `/etc/remudero/daemon-instances.yaml` — which omits core — and the console's instance env var).
 * The repo-tracked registry already declared all three daemons for `deploy/recycle-container.sh`,
 * so it is the one that grows the project layer: each instance names its `project` (absent →
 * {@link DEFAULT_PROJECT}) and its `github_repo` (`owner/name`).
 *
 * DELIBERATELY THE SHELL READERS' LINE GRAMMAR, NOT A GENERAL YAML PARSER — the same choice
 * `deployer.ts`'s `daemonInstanceRows` made and for the same reason: `recycle-container.sh` and
 * `install-host-units.sh` read this file with `awk` (an instance is a 2-space-indented key, a field
 * a 4-space-indented `key: value`), and a reader that accepted shapes the scripts cannot see would
 * describe a fleet the deploy path does not run. Anything outside that grammar inside the
 * `instances:` block is a named refusal here, never a silently skipped line.
 *
 * `repo:` KEEPS ITS EXISTING MEANING — the bare name `rmd daemon --repo` is launched with — because
 * both scripts pass it straight to the daemon. The `owner/name` identity is the new `github_repo`
 * field; a registry that has not grown it yet may carry `owner/name` in `repo:` itself.
 *
 * W1-T4265 — THE ONBOARDING GATE: each instance also names its `mode` (`shadow` | `live`, absent
 * → `live`, so a registry row written before this task parses exactly as it always has). A
 * shadow instance's worker (`instanceMode`, `src/run-task.ts`) runs real tasks and opens real
 * pull requests, but never arms or merges one — proven in shadow before a newly onboarded repo
 * goes live (W1-T4266 flips this field, through a reviewed pull request, never a direct write to
 * disk).
 */
import { RmdError } from "./errors.js";

/** The project an instance belongs to when its registry row names none — a standalone repo. */
export const DEFAULT_PROJECT = "default";

/** Where the watchdog on the fleet host converges from; `GET /v1/registry` compares against it. */
export const DEFAULT_HOST_INSTANCE_REGISTRY_PATH = "/etc/remudero/daemon-instances.yaml";

export type InstanceRegistryErrorCode =
  | "no_instances_block"
  | "malformed_line"
  | "duplicate_instance"
  | "duplicate_field"
  | "missing_repo"
  | "invalid_repo"
  | "invalid_project"
  | "invalid_retired"
  | "invalid_mode"
  | "duplicate_live_repo";

/** A registry the parser refuses. `code` is stable for callers; `message` names the line/instance. */
export class InstanceRegistryError extends RmdError {
  readonly code: InstanceRegistryErrorCode;
  constructor(code: InstanceRegistryErrorCode, message: string) {
    super("registry", 1, `instance registry ${code}: ${message}`, { code });
    this.name = "InstanceRegistryError";
    this.code = code;
  }
}

export interface RegistryInstance {
  /** The instance name — the 2-space key, and the `/v1/i/<name>` prefix segment. */
  name: string;
  project: string;
  /** `owner/name` on GitHub. */
  repo: string;
  /** False only when the row says `retired: true`; a retired row may reuse a live row's repo. */
  live: boolean;
  /**
   * W1-T4265 — `shadow` or `live`. Absent `mode:` ⇒ `"live"`, so every registry row that predates
   * this field (every instance declared before this task) is unchanged. A shadow instance's own
   * worker never arms or merges a pull request (`instanceMode`,
   * `resolveShadowInstanceArmPermission`, `src/run-task.ts`) — the onboarding gate a new repo is
   * proven through before it goes live (W1-T4266 flips this field, through a reviewed pull
   * request, never a direct write).
   */
  mode: "shadow" | "live";
}

export interface InstanceRegistry {
  /** Every declared instance, in file order. */
  instances: RegistryInstance[];
}

const INSTANCE_LINE = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const FIELD_LINE = /^ {4}([A-Za-z_]+):\s*(.*)$/;
const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]*$/;

interface RawInstance {
  name: string;
  fields: Map<string, string>;
}

/** The `instances:` block as raw rows, in the shell readers' grammar. */
function scanInstances(text: string): RawInstance[] {
  const rows: RawInstance[] = [];
  const byName = new Map<string, RawInstance>();
  let inInstances = false;
  let sawBlock = false;
  let current: RawInstance | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // The awk readers strip a trailing ` # …` comment before matching; so does this.
    const line = lines[i].replace(/\s+#.*$/, "").replace(/\s+$/, "");
    if (line === "" || /^\s*#/.test(line)) continue;
    if (/^instances:$/.test(line)) {
      inInstances = true;
      sawBlock = true;
      continue;
    }
    if (/^\S/.test(line)) {
      // Any other top-level key ends the block, as in `daemonInstanceRows`.
      inInstances = false;
      current = undefined;
      continue;
    }
    if (!inInstances) continue;
    const instance = INSTANCE_LINE.exec(line);
    if (instance) {
      const name = instance[1];
      if (byName.has(name)) throw new InstanceRegistryError("duplicate_instance", `instance '${name}' is declared twice (line ${i + 1})`);
      current = { name, fields: new Map() };
      byName.set(name, current);
      rows.push(current);
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (field && current) {
      const [, key, rawValue] = field;
      if (current.fields.has(key)) {
        throw new InstanceRegistryError("duplicate_field", `instance '${current.name}' declares '${key}' twice (line ${i + 1})`);
      }
      current.fields.set(key, rawValue.replace(/^"|"$/g, ""));
      continue;
    }
    throw new InstanceRegistryError("malformed_line", `line ${i + 1} is neither an instance name nor a 4-space 'key: value' field`);
  }
  if (!sawBlock) throw new InstanceRegistryError("no_instances_block", "no top-level 'instances:' block");
  return rows;
}

/**
 * The declared instance NAMES only — enough to compare two registries, and tolerant of a registry
 * that has not grown the project layer (the host's copy). Same grammar and the same structural
 * refusals as {@link parseInstanceRegistry}.
 */
export function parseInstanceNames(text: string): string[] {
  return scanInstances(text).map((row) => row.name);
}

/** Parses and validates the registry: unique instance names, one live instance per repo. */
export function parseInstanceRegistry(text: string): InstanceRegistry {
  const instances = scanInstances(text).map((row): RegistryInstance => {
    const declared = row.fields.get("github_repo") ?? row.fields.get("repo");
    if (declared === undefined || declared === "") {
      throw new InstanceRegistryError("missing_repo", `instance '${row.name}' declares no github_repo (owner/name)`);
    }
    if (!OWNER_NAME.test(declared)) {
      throw new InstanceRegistryError("invalid_repo", `instance '${row.name}' repo '${declared}' is not owner/name`);
    }
    const project = row.fields.get("project") ?? DEFAULT_PROJECT;
    if (!PROJECT_ID.test(project)) {
      throw new InstanceRegistryError("invalid_project", `instance '${row.name}' project '${project}' is not a lower-case id`);
    }
    const retired = row.fields.get("retired");
    if (retired !== undefined && retired !== "true" && retired !== "false") {
      throw new InstanceRegistryError("invalid_retired", `instance '${row.name}' retired must be true or false`);
    }
    // W1-T4265: absent ⇒ "live" — an existing registry row that has not grown this field yet
    // parses exactly as it always has (design: "absent = live, so existing instances are
    // unchanged").
    const mode = row.fields.get("mode");
    if (mode !== undefined && mode !== "shadow" && mode !== "live") {
      throw new InstanceRegistryError("invalid_mode", `instance '${row.name}' mode '${mode}' is not "shadow" or "live"`);
    }
    return { name: row.name, project, repo: declared, live: retired !== "true", mode: mode ?? "live" };
  });
  const liveRepos = new Map<string, string>();
  for (const instance of instances) {
    if (!instance.live) continue;
    const key = instance.repo.toLowerCase();
    const holder = liveRepos.get(key);
    if (holder !== undefined) {
      throw new InstanceRegistryError(
        "duplicate_live_repo",
        `instances '${holder}' and '${instance.name}' are both live for ${instance.repo}`,
      );
    }
    liveRepos.set(key, instance.name);
  }
  return { instances };
}

export interface RegistryProjection {
  projects: Array<{
    id: string;
    repos: Array<{ repo: string; instances: Array<{ name: string; prefix: string }> }>;
  }>;
}

/**
 * The public shape `GET /v1/registry` serves: live instances grouped project → repo, each with
 * the `/v1/i/<name>` prefix it is reached under. Built field by field from names and repos ONLY,
 * so no state dir, credential dir, image or container ever reaches it — even if a row carries them.
 */
export function projectRegistry(registry: InstanceRegistry): RegistryProjection {
  const projects: RegistryProjection["projects"] = [];
  for (const instance of registry.instances) {
    if (!instance.live) continue;
    let project = projects.find((p) => p.id === instance.project);
    if (!project) {
      project = { id: instance.project, repos: [] };
      projects.push(project);
    }
    let repo = project.repos.find((r) => r.repo === instance.repo);
    if (!repo) {
      repo = { repo: instance.repo, instances: [] };
      project.repos.push(repo);
    }
    repo.instances.push({ name: instance.name, prefix: `/v1/i/${instance.name}` });
  }
  return { projects };
}

export interface RegistryDrift {
  hostOnly: string[];
  repoOnly: string[];
}

/** The instance-set difference between the host copy and the repo registry; undefined when equal. */
export function registryDrift(repoNames: readonly string[], hostNames: readonly string[]): RegistryDrift | undefined {
  const repo = new Set(repoNames);
  const host = new Set(hostNames);
  const hostOnly = [...host].filter((n) => !repo.has(n)).sort();
  const repoOnly = [...repo].filter((n) => !host.has(n)).sort();
  return hostOnly.length === 0 && repoOnly.length === 0 ? undefined : { hostOnly, repoOnly };
}
