/**
 * A path that is too long for what consumes it — a unix socket's sun_path, or a scratch dir whose
 * children bind sockets beneath it — moves to the short /tmp root. macOS's per-user TMPDIR
 * (/private/var/folders/<..>/T) is ~50 characters on its own, so a path derived from it overruns
 * those limits on a Mac while the same derivation fits on Linux, where /tmp is the default.
 */
import { realpathSync } from "node:fs";

/** The short root a too-long path moves to. */
export const SHORT_PATH_ROOT = "/tmp";

/** sun_path's capacity less its NUL terminator: 108 bytes on Linux, 104 on macOS and the BSDs. */
export const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;

/**
 * `long` when it `fits`. Otherwise `shortFor(<realpath of /tmp>)` when `admit` accepts the short
 * root and that path fits. Otherwise `long`, left for the caller's own guard to refuse. `admit`
 * must reject a root that does not exist (a device check or `existsSync` both do).
 */
export function shortPathWhenTooLong(
  long: string,
  shortFor: (root: string) => string,
  fits: (path: string) => boolean,
  admit: (root: string) => boolean,
): string {
  if (fits(long) || !admit(SHORT_PATH_ROOT)) return long;
  const short = shortFor(realpathSync(SHORT_PATH_ROOT));
  return fits(short) ? short : long;
}
