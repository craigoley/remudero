import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

// Native CLI discovery for loopback tests that supply their own private credential environment.
// This rejects shebang scripts only; it does not validate ELF/Mach-O or exclude every wrapper.
function nativeCli(name: "gh" | "jq"): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    let fd: number | undefined;
    try {
      fd = openSync(candidate, "r");
      const magic = Buffer.alloc(4);
      if (readSync(fd, magic, 0, magic.length, 0) !== magic.length) continue;
      if (magic[0] === 0x23 && magic[1] === 0x21) continue;
      return realpathSync(candidate);
    } catch { /* Missing PATH entries are not a binary; an absent native CLI fails below. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  throw new Error(`the loopback integration control requires the actual ${name} binary`);
}

/** The named native-tool port; executable shim writers remain managed by ghShim. */
export function nativeGhAndJq(): { gh: string; jq: string } {
  return {
    gh: nativeCli("gh"),
    jq: nativeCli("jq"),
  };
}
