const Module = require("node:module");
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");

const logPath = process.env.RMD_MODULE_LOAD_LOG;
const seen = new Set();

function asPath(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && value.href && value.protocol === "file:") {
    return fileURLToPath(value);
  }
  return undefined;
}

function record(value) {
  if (!logPath) return;
  const path = asPath(value);
  if (!path || path === logPath || seen.has(path)) return;
  seen.add(path);
  try {
    fs.appendFileSync(logPath, path + "\n");
  } catch {
    // Best-effort recorder: the child command's behavior is the subject under test.
  }
}

const originalLoad = Module._load;
Module._load = function recordedLoad(request, parent, isMain) {
  try {
    record(Module._resolveFilename(request, parent, isMain));
  } catch {
    record(request);
  }
  return originalLoad.apply(this, arguments);
};

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function recordedReadFileSync(path, ...rest) {
  record(path);
  return originalReadFileSync.call(this, path, ...rest);
};
