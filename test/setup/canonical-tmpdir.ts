/**
 * #7598 — ONE CANONICAL TEMP ROOT FOR EVERY TEST. On macOS `os.tmpdir()` returns `/var/folders/...`
 * while git, `realpathSync` and `process.cwd()` inside it report `/private/var/folders/...` (`/var`
 * is a symlink), so a fixture comparing a path it built against one git or the OS resolved fails on
 * a Mac and passes on Linux CI, where the temp root has no symlink. Pinning TMPDIR to its real path
 * here makes `os.tmpdir()` (which reads TMPDIR on every call) and every child process agree with
 * what git reports. A no-op wherever the temp root is already canonical; production paths untouched.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const temp = tmpdir();
let real = temp;
try {
  real = realpathSync(temp);
} catch {
  // An unresolvable temp root is left exactly as configured; the suites report it themselves.
}
if (real !== temp) process.env.TMPDIR = real;
