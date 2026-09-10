import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "../../src/lib/tmp.js";

/**
 * A `gh` stub on a throwaway PATH, for driving a shell gate that shells out to it.
 *
 * EXTRACTED RATHER THAN COPIED, because the fixture-copy census counts this exact shape — a literal
 * `gh` write plus a chmod plus a PATH mention — and two suites had grown their own. It reported
 * `ghPathShimFiles: 88 > baseline 86 (+2 over)`, naming the duplication rather than the size. The
 * census deliberately never descends into `test/helpers/`, so one shared builder is both the
 * smaller number and the thing the census was asking for; raising the ceiling would have recorded
 * the duplication instead of removing it.
 */
export function ghStubPath(script: string): string {
  const bin = join(makeTempDir("rmd-gh-stub-"), "bin");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  return bin;
}

/** A stub that answers every invocation with `sha` on stdout. */
export function ghAnswering(sha: string): string {
  return ghStubPath(`#!/bin/sh\necho ${sha}\n`);
}

/** A stub that fails, for the "the head could not be read" arm. */
export function ghFailing(): string {
  return ghStubPath("#!/bin/sh\nexit 1\n");
}

/** `PATH` with the stub's directory ahead of the real one. */
export function pathWith(bin: string): string {
  return `${bin}:${process.env.PATH ?? ""}`;
}
