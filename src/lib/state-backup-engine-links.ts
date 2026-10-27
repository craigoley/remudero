import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LEDGER_FILENAME } from "./ledger-path.js";

export const ENGINE_LINK_MANIFEST = "state-backup-engine-links.json";
const LINK_PATH = /^engines\/([0-9a-f]{64})\/node_modules$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PIN_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];
const CRITICAL_STATE = [LEDGER_FILENAME, "inbox-proposals.json"];

export function engineTreePath(rel: string): string | undefined {
  return /^(engines\/[0-9a-f]{64})(?:\/|$)/.exec(rel)?.[1];
}

export function isEngineEvidenceName(name: string): boolean {
  return name === "engine.json" || name === "node_modules" || PIN_FILES.includes(name);
}

/** A dangling link still exists: only a removed directory entry excuses ENOENT. */
export function stateEntryVanished(error: unknown, path: string): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" &&
    lstatSync(path, { throwIfNoEntry: false }) === undefined;
}

interface EngineDependencyLink {
  path: string;
  target: string;
  sourceHash: string;
  revision: string;
  identities: Record<string, string>;
}

interface EngineLinkManifest {
  version: 1;
  status: "requires-engine-dependency-reconstruction";
  criticalState: string[];
  links: EngineDependencyLink[];
}

function refuse(detail: string): never {
  throw new Error(`engine dependency reconstruction: ${detail}`);
}

export function isEngineDependencyLinkPath(rel: string): boolean {
  return LINK_PATH.test(rel);
}

/** One descriptor answers both "is it a regular file?" and "what are its bytes?", so no path is checked and then
 *  re-opened (CodeQL js/file-system-race). O_NOFOLLOW refuses a link (ELOOP, thrown), O_NONBLOCK keeps a FIFO from
 *  hanging the open. Absent is `undefined`; a directory or other non-regular file is `"non-regular"`. */
function readRegular(file: string, listed = false): Buffer | "non-regular" | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (!listed && stateEntryVanished(error, file)) return undefined;
    throw error;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : "non-regular";
  } finally {
    closeSync(fd);
  }
}

function objectJson(bytes: Buffer, path: string): Record<string, unknown> {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`invalid JSON object at ${path}`);
  return value;
}

/** Read only the engine's own regular evidence files; never its dependency target. */
function linkEvidence(root: string, path: string, listed?: readonly string[], onVanished?: () => void): EngineDependencyLink {
  const sourceHash = LINK_PATH.exec(path)?.[1];
  if (!sourceHash) refuse(`invalid link path ${path}`);
  const engine = dirname(path);
  const touch = <T>(rel: string, read: () => T): T => {
    try {
      return read();
    } catch (error) {
      if (onVanished && stateEntryVanished(error, join(root, rel))) onVanished();
      throw error;
    }
  };
  for (const rel of ["engines", engine]) {
    if (!touch(rel, () => lstatSync(join(root, rel))).isDirectory()) refuse(`non-directory engine parent ${rel}`);
  }
  const link = join(root, path);
  if (!touch(path, () => lstatSync(link)).isSymbolicLink()) refuse(`expected a symbolic link at ${path}`);
  const identities: Record<string, string> = {};
  const evidence = (name: string): Buffer | undefined => {
    const file = join(root, engine, name);
    const bytes = touch(`${engine}/${name}`, () => readRegular(file, listed?.includes(`${engine}/${name}`)));
    if (bytes === undefined) return undefined;
    if (bytes === "non-regular") refuse(`expected regular reconstruction evidence at ${file}`);
    if (bytes.length === 0) refuse(`empty reconstruction evidence at ${file}`);
    identities[name] = createHash("sha256").update(bytes).digest("hex");
    return bytes;
  };
  const engineRecord = evidence("engine.json") ?? refuse(`missing reconstruction evidence at ${engine}/engine.json`);
  const record = objectJson(engineRecord, `${engine}/engine.json`);
  if (typeof record.sha !== "string" || !REVISION.test(record.sha) || record.sourceHash !== sourceHash ||
      typeof record.builtAt !== "number" || !Number.isFinite(record.builtAt) ||
      (record.nodeModulesTarget !== undefined && typeof record.nodeModulesTarget !== "string")) {
    refuse(`invalid engine.json revision or identity at ${engine}`);
  }
  for (const name of PIN_FILES) {
    const bytes = evidence(name);
    if (bytes === undefined) continue;
    if (name.endsWith(".json")) {
      const pin = objectJson(bytes, `${engine}/${name}`);
      if (name !== "package.json" && (!Number.isInteger(pin.lockfileVersion) || Number(pin.lockfileVersion) < 1)) {
        refuse(`invalid lockfile identity at ${engine}/${name}`);
      }
    }
  }
  return { path, target: touch(path, () => readlinkSync(link)), sourceHash, revision: record.sha, identities };
}

/** Staged metadata contains identities and link text, never dependency payloads. */
export function preserveEngineDependencyLinks(root: string, staged: string, entries: readonly string[], vanished: string[] = []): EngineLinkManifest | undefined {
  if (lstatSync(join(root, ENGINE_LINK_MANIFEST), { throwIfNoEntry: false })) {
    refuse(`reserved archive metadata exists in live state: ${ENGINE_LINK_MANIFEST}`);
  }
  try {
    const links: EngineDependencyLink[] = [];
    for (const rel of entries.filter(isEngineDependencyLinkPath)) {
      let reaped = false;
      try {
        if (lstatSync(join(root, rel)).isSymbolicLink()) {
          links.push(linkEvidence(root, rel, entries, () => { reaped = true; }));
        }
      } catch (error) {
        if (!reaped && !stateEntryVanished(error, join(root, rel))) throw error;
        vanished.push(dirname(rel));
      }
    }
    if (links.length === 0) return undefined;
    const manifest: EngineLinkManifest = {
      version: 1,
      status: "requires-engine-dependency-reconstruction",
      criticalState: CRITICAL_STATE.filter((rel) => entries.includes(rel)),
      links,
    };
    restoreEngineDependencyLinks(staged, manifest);
    writeFileSync(join(staged, ENGINE_LINK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } catch (error) {
    throw new Error(`engine dependency reconstruction: cannot preserve links: ${(error as Error).message}`, { cause: error });
  }
}

/** Omit an incomplete engine as one unit, touching staging only. */
export function omitVanishedEngines(staged: string, vanished: string[], manifest?: EngineLinkManifest): EngineLinkManifest | undefined {
  const paths = [...new Set(vanished.map((rel) => engineTreePath(rel) ?? rel))];
  vanished.splice(0, vanished.length, ...paths);
  const engines = new Set(paths.filter((rel) => engineTreePath(rel) === rel));
  for (const engine of engines) rmSync(join(staged, engine), { recursive: true, force: true });
  if (!manifest || !manifest.links.some((link) => engines.has(dirname(link.path)))) return manifest;
  manifest = { ...manifest, links: manifest.links.filter((link) => !engines.has(dirname(link.path))) };
  if (manifest.links.length === 0) {
    rmSync(join(staged, ENGINE_LINK_MANIFEST), { force: true });
    return undefined;
  }
  writeFileSync(join(staged, ENGINE_LINK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Validate disk evidence before publication or any restore destination write. */
export function validateEngineDependencyLinks(root: string, entries: readonly string[], expected?: EngineLinkManifest): EngineLinkManifest | undefined {
  const paths = entries.filter((rel) => isEngineDependencyLinkPath(rel) && lstatSync(join(root, rel)).isSymbolicLink());
  const manifestBytes = readRegular(join(root, ENGINE_LINK_MANIFEST));
  if (manifestBytes === undefined && paths.length === 0 && !expected) return undefined;
  try {
    if (manifestBytes === undefined) refuse("missing manifest");
    if (manifestBytes === "non-regular") refuse("non-regular manifest");
    if (paths.length === 0) refuse("manifest has no engine dependency links");
    const raw = objectJson(manifestBytes, ENGINE_LINK_MANIFEST);
    if (!Array.isArray(raw.criticalState) || raw.criticalState.some((rel) => !CRITICAL_STATE.includes(rel)) ||
        new Set(raw.criticalState).size !== raw.criticalState.length) {
      refuse("invalid critical-state identities");
    }
    for (const rel of raw.criticalState) if (!entries.includes(rel)) refuse(`missing ${rel}, irreplaceable state`);
    const actual: EngineLinkManifest = {
      version: 1,
      status: "requires-engine-dependency-reconstruction",
      criticalState: CRITICAL_STATE.filter((rel) => entries.includes(rel)),
      links: paths.map((rel) => linkEvidence(root, rel)),
    };
    if (!isDeepStrictEqual(raw, actual) || (expected && !isDeepStrictEqual(raw, expected))) {
      refuse("manifest version, link identity or pinned evidence mismatch");
    }
    return actual;
  } catch (error) {
    throw new Error(`engine dependency reconstruction: invalid archive: ${(error as Error).message}`, { cause: error });
  }
}

/** Preflight every destination path so an existing link cannot redirect a restore write. */
export function assertStateRestorePaths(target: string, entries: readonly string[], manifest?: EngineLinkManifest): void {
  const links = new Set(manifest?.links.map((link) => link.path));
  for (const rel of entries) {
    const destination = resolve(target, rel);
    let path = destination;
    for (;;) {
      const st = lstatSync(path, { throwIfNoEntry: false });
      const isLinkDestination = path === destination && links.has(rel);
      if (st && (isLinkDestination ? !st.isSymbolicLink() : st.isSymbolicLink())) {
        refuse(`unsafe restore destination ${path}`);
      }
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
}

/** Recreate link text only; existing links are unlinked without touching their targets. */
export function restoreEngineDependencyLinks(target: string, manifest?: EngineLinkManifest): void {
  for (const link of manifest?.links ?? []) {
    const path = join(target, link.path);
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    symlinkSync(link.target, path);
  }
}
