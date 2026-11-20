import { join } from "node:path";

/** Directory under daemon state that belongs to the engine-tree owner. */
export const ENGINES_DIR = "engines";
export const ENGINE_BUILD_PREFIX = ".build-";
export const ENGINE_SOURCE_HASH = /^[0-9a-f]{64}$/;

/** Names the engine-tree owner creates directly under `<state>/engines`. */
export function isEngineTreeEntryName(name: string): boolean {
  return ENGINE_SOURCE_HASH.test(name) || name.startsWith(ENGINE_BUILD_PREFIX);
}

/** The owner root shared by engine-tree and worker lifecycle code. */
export const engineTreesRoot = (stateRoot: string): string => join(stateRoot, ENGINES_DIR);
