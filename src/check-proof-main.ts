import { checkProofCommand, MISSING_EXPORT_OBSERVATION_FLAG } from "./lib/check-proof.js";
import { withSyncChildReservation } from "./lib/host-memory-learning.js";
import { readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PROOF_FILE_READ_BYTES } from "./lib/proof-file-reader-child.js";

if (process.argv[2] === MISSING_EXPORT_OBSERVATION_FLAG) {
  try {
    if (process.argv.length !== 3) throw Error("unexpected observation arguments");
    const parts: Buffer[] = []; let used = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, PROOF_FILE_READ_BYTES + 1 - used));
      const size = readSync(0, buffer);
      if (size === 0) break;
      used += size;
      if (used > PROOF_FILE_READ_BYTES) throw Error("observation request exceeds source-read bound");
      parts.push(buffer.subarray(0, size));
    }
    const request: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (typeof request !== "object" || request === null) throw Error("invalid observation request");
    const { output, base, head } = request as Record<string, unknown>;
    if (typeof output !== "string" || typeof base !== "string" || typeof head !== "string" ||
        !isAbsolute(base) || !isAbsolute(head)) throw Error("invalid observation context");
    const { baseLacksPrAddedExports } = await import("./lib/proof-missing-export.js");
    console.log(JSON.stringify(await baseLacksPrAddedExports(output, base, head) ?? null));
  } catch { console.log("null"); }
} else {
  process.exitCode = withSyncChildReservation("check-proof", () => checkProofCommand(process.argv.slice(2)), { bindSelf: true });
}
