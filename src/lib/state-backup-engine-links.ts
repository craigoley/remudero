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
function readRegular(file: string): Buffer | "non-regular" | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
function linkEvidence(root: string, path: string): EngineDependencyLink {
  const sourceHash = LINK_PATH.exec(path)?.[1];
  if (!sourceHash) refuse(`invalid link path ${path}`);
  const engine = dirname(path);
  for (const rel of ["engines", engine]) {
    if (!lstatSync(join(root, rel)).isDirectory()) refuse(`non-directory engine parent ${rel}`);
  }
  const link = join(root, path);
  if (!lstatSync(link).isSymbolicLink()) refuse(`expected a symbolic link at ${path}`);
  const identities: Record<string, string> = {};
  const evidence = (name: string): Buffer | undefined => {
    const file = join(root, engine, name);
    const bytes = readRegular(file);
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
  return { path, target: readlinkSync(link), sourceHash, revision: record.sha, identities };
}

/** Staged metadata contains identities and link text, never dependency payloads. */
export function preserveEngineDependencyLinks(root: string, staged: string, entries: readonly string[]): EngineLinkManifest | undefined {
  if (lstatSync(join(root, ENGINE_LINK_MANIFEST), { throwIfNoEntry: false })) {
    refuse(`reserved archive metadata exists in live state: ${ENGINE_LINK_MANIFEST}`);
  }
  const paths = entries.filter((rel) => isEngineDependencyLinkPath(rel) && lstatSync(join(root, rel)).isSymbolicLink());
  if (paths.length === 0) return undefined;
  try {
    const manifest: EngineLinkManifest = {
      version: 1,
      status: "requires-engine-dependency-reconstruction",
      criticalState: CRITICAL_STATE.filter((rel) => entries.includes(rel)),
      links: paths.map((rel) => linkEvidence(root, rel)),
    };
    restoreEngineDependencyLinks(staged, manifest);
    writeFileSync(join(staged, ENGINE_LINK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } catch (error) {
    throw new Error(`engine dependency reconstruction: cannot preserve links: ${(error as Error).message}`, { cause: error });
  }
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
