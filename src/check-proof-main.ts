import { checkProofCommand } from "./lib/check-proof.js";
import { withSyncChildReservation } from "./lib/host-memory-learning.js";

process.exitCode = withSyncChildReservation("check-proof", () => checkProofCommand(process.argv.slice(2)), { bindSelf: true });
