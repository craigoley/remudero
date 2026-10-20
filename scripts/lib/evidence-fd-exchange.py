"""Exchange two basenames under inherited directory FD 3, preserving both inodes.

Apple renameatx_np(RENAME_SWAP), no rename fallback or retry. The caller must
retain both names if it cannot verify this process's terminal receipt.
"""
import ctypes
import os
import stat
import sys

if sys.platform != "darwin" or len(sys.argv) != 3:
    raise SystemExit("unqualified exchange invocation")
names = sys.argv[1:]
if any(name in ("", ".", "..") or "/" in name or "\x00" in name for name in names) or names[0] == names[1]:
    raise SystemExit("basenames required")
directory = os.fstat(3)
if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o022:
    raise SystemExit("unverified exchange directory")
library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
exchange = library.renameatx_np
exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
exchange.restype = ctypes.c_int
# RENAME_SWAP from Apple's <sys/stdio.h>; flags=0 would destroy the displaced inode.
if exchange(3, os.fsencode(names[0]), 3, os.fsencode(names[1]), 0x00000002) != 0:
    raise OSError(ctypes.get_errno(), "atomic exchange failed")
os.fsync(3)
print("EXCHANGED_AND_SYNCED", flush=True)
