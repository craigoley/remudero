/** Read only the existing instance config; never call loadConfig or provision defaults. */
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { configPath } from "./config.js";
import { validateConfigShape } from "./config-schema.js";
import type { Config } from "./config-schema.js";

export type ExistingNativeCanaryConfigResult =
  | { state: "available"; configPath: string; config: Config }
  | { state: "unavailable"; reason: string };
const MAX_CONFIG_BYTES = 1024 * 1024;
export function readExistingNativeCanaryConfig(): ExistingNativeCanaryConfigResult {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0)
    return { state: "unavailable", reason: "native-config-platform-unsupported" };
  const path = configPath();
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES || (info.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid()))
      return { state: "unavailable", reason: "native-config-existing-private-file-required" };
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) return { state: "unavailable", reason: "native-config-bound" };
    const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    const config = validateConfigShape(parsed, path);
    return { state: "available", configPath: path, config };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: "unavailable", reason: code === "ENOENT" ? "native-config-not-found" : "native-config-unreadable" };
  } finally { if (fd !== undefined) closeSync(fd); }
}
