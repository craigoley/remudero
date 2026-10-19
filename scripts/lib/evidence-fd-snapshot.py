"""Darwin metadata-preserving snapshot of inherited FD 3, never a source pathname.

Uses the OS fcopyfile interface (COPYFILE_ALL | COPYFILE_NOCACHE); no packages,
network, configuration or credentials. The caller owns the exclusive destination.
"""
import ctypes
import os
import stat
import sys

if sys.platform != "darwin" or len(sys.argv) != 2:
    raise SystemExit("unqualified snapshot invocation")
source = os.fstat(3)
if not stat.S_ISREG(source.st_mode) or source.st_uid != os.getuid() or source.st_nlink != 1 or source.st_flags:
    raise SystemExit("unverified snapshot descriptor")
library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
copy = library.fcopyfile
copy.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
copy.restype = ctypes.c_int
target = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    if copy(3, target, None, 0xF | (1 << 14)) != 0:
        raise OSError(ctypes.get_errno(), "descriptor snapshot failed")
    os.fsync(target)
finally:
    os.close(target)
