// src/lib/child-entry-argv.ts — W1-T8775. Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
//
// One place decides how a daemon child is launched: the precompiled bundle under plain node when
// scripts/build-child-entries.mjs vouches it is current for the tree, tsx on the source entry otherwise.
// Currency is judged by that script's own childEntryIsCurrent (source hash, payload digest, path and
// shape), never by a second implementation here.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { childEntryIsCurrent } from "../../scripts/build-child-entries.mjs";

export type ChildEntryKind = "bundle" | "tsx";
export interface ChildEntryLaunch {
  /** Arguments for `node`: the bundle path, or `--import <tsx> <source entry>`, then `args`. */
  argv: string[];
  kind: ChildEntryKind;
  /** Why this kind ran: `source-hash-match` for a bundle, otherwise what childEntryIsCurrent gave. */
  reason: string;
}

/**
 * The argv that runs child entry `name` for the tree at `root`. A bundle is chosen only when
 * childEntryIsCurrent holds; any other answer, including a thrown one, takes the tsx fallback with the
 * reason, so a corrupt or stale bundle is never executed. tsx is resolved from this package, as
 * checkProofChildArgv does, so a tree without its own node_modules still launches.
 */
export function childEntryArgv(root: string, name: string, sourceEntry: string, args: readonly string[]): ChildEntryLaunch {
  let verdict: { current: boolean; reason: string; bundle?: string };
  try {
    verdict = childEntryIsCurrent(root, name);
  } catch (err) {
    verdict = { current: false, reason: `validation-error: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
  }
  if (verdict.current && typeof verdict.bundle === "string") {
    return { argv: [verdict.bundle, ...args], kind: "bundle", reason: verdict.reason };
  }
  const tsx = createRequire(import.meta.url).resolve("tsx");
  return { argv: ["--import", tsx, resolve(root, sourceEntry), ...args], kind: "tsx", reason: verdict.reason };
}
