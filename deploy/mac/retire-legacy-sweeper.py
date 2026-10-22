#!/usr/bin/env python3
"""Disable only the positively identified legacy destructive sweep; never stop a process."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess

LABEL = "com.craigoley.disk-sweep"
LEGACY_ARGS = ["/bin/zsh", "-lc", "DRY=0 $HOME/bin/covtmp-sweep.zsh"]
LEGACY_SCRIPT_SHA256 = "eede2663c9d03b607fa8cffe13a6dec3fa30ff140e5f05285bac702d5d4b33ae"


def confirmed_disabled(output):
    # macOS 27 prints 'disabled'; older launchctl versions print 'true'.
    # Match one exact job and token, never a prefix, another label or ambiguous duplicates.
    values = re.findall(r'^\s*"' + re.escape(LABEL) + r'"\s*=>\s*(\S+)\s*$', output, re.MULTILINE)
    return values in (["true"], ["disabled"])


def retire(home, apply=False):
    path = home / "Library/LaunchAgents" / (LABEL + ".plist")
    if not path.exists():
        return {"state": "absent", "changed": False}
    before = path.lstat()
    if path.resolve() != path or not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
        return {"state": "held-unknown-ownership", "changed": False}
    raw = path.read_bytes()
    try:
        doc = plistlib.loads(raw)
    except (ValueError, plistlib.InvalidFileException):
        return {"state": "held-invalid-plist", "changed": False}
    # launchd executes Program, when present, rather than ProgramArguments[0].
    # Matching arguments alone cannot identify the executable being retired.
    if (doc.get("Label") != LABEL or doc.get("ProgramArguments") != LEGACY_ARGS
            or ("Program" in doc and doc["Program"] != LEGACY_ARGS[0])):
        return {"state": "held-different-job", "changed": False}
    script = home / "bin/covtmp-sweep.zsh"
    if (not script.is_file() or script.is_symlink() or script.resolve() != script
            or script.stat().st_uid != os.getuid()
            or hashlib.sha256(script.read_bytes()).hexdigest() != LEGACY_SCRIPT_SHA256):
        return {"state": "held-different-legacy-script", "changed": False}
    sha = hashlib.sha256(raw).hexdigest()
    if not apply:
        return {"state": "would-disable-identified-legacy-job", "changed": False, "sha256": sha}
    # disable changes future admission, not the lifecycle of any running job.
    # No bootout, kill, kickstart or restart is ever issued.
    result = subprocess.run(["launchctl", "disable", f"gui/{os.getuid()}/{LABEL}"],
                            capture_output=True, text=True, timeout=10)
    if result.returncode:
        return {"state": "held-disable-refused", "changed": False}
    disabled = subprocess.run(["launchctl", "print-disabled", f"gui/{os.getuid()}"],
                              capture_output=True, text=True, timeout=10)
    if disabled.returncode or not confirmed_disabled(disabled.stdout):
        return {"state": "disable-unverified", "changed": True}
    after = path.lstat()
    if ((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns)
            or path.read_bytes() != raw):
        return {"state": "disabled-job-plist-changed-retained", "changed": True}
    archived = path.with_suffix(".plist.disabled-" + sha[:12])
    if archived.exists():
        return {"state": "disabled-archive-collision-retained", "changed": True}
    os.rename(path, archived)
    return {"state": "disabled-legacy-job-plist-preserved", "changed": True,
            "sha256": sha, "archive": str(archived), "runningProcessesStopped": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        result = retire(Path.home(), args.apply)
    except (OSError, subprocess.TimeoutExpired):
        result = {"state": "held-probe-unavailable", "changed": None}
    print("legacy-sweeper: " + json.dumps(result, separators=(",", ":")))
    return 0 if result["state"] in {"absent", "would-disable-identified-legacy-job", "disabled-legacy-job-plist-preserved"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
