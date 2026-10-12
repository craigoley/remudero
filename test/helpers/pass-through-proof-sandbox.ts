// W1-T6156: the coverage precheck's real runner starts the worker's script only under the proof sandbox, and skips by
// name when none can start (macOS, a CI runner without user namespaces). A suite that drives that real runner for
// something OTHER than the sandbox pins this stand-in: it drops the sandbox argv up to `--` and execs the rest, so
// the suite still runs the real spawn, env and output path on every host.

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { setProofSandboxForTests } from "../../src/lib/review.js";
import { makeTempDir } from "../../src/lib/tmp.js";

export function usePassThroughProofSandbox(): void {
  let dir: string | undefined;
  before(() => {
    dir = makeTempDir("pass-through-sandbox");
    const binary = join(dir, "bwrap");
    writeFileSync(binary, '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
    chmodSync(binary, 0o755);
    setProofSandboxForTests({ mode: "bwrap", binary });
  });
  after(() => {
    setProofSandboxForTests();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
}
