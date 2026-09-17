#!/usr/bin/env python3
"""macOS system calls unavailable in Node's standard library; no packages needed."""
import ctypes
import errno
import fcntl
import json
import sys


class ProcBsdInfo(ctypes.Structure):
    # Public libproc PROC_PIDTBSDINFO layout from sys/proc_info.h.
    _fields_ = [
        (name, ctypes.c_uint32) for name in (
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
            "ruid", "rgid", "svuid", "svgid", "rfu_1")
    ] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in (
            "nfiles", "pgid", "pjobc", "e_tdev", "e_tpgid")
    ] + [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64),
         ("start_usec", ctypes.c_uint64)]


def process_identity(pid):
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                   ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
    info = ProcBsdInfo()
    count = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if count == 0 and ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
        return None
    if count != ctypes.sizeof(info):
        raise RuntimeError(f"proc_pidinfo failed: bytes={count}, errno={ctypes.get_errno()}")
    if info.pid != pid or not info.start_sec:
        raise RuntimeError("proc_pidinfo returned an invalid process identity")
    return {"token": f"{info.start_sec}:{info.start_usec}", "running": info.status != 5}


def lock(fd):
    # This inherited descriptor shares the controller's open file description.
    # Do not explicitly unlock: the controller retains the lock after we exit.
    try:
        fcntl.flock(int(fd), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 75
    return 0


def group_running(pgid):
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_listpgrppids.argtypes = [ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_listpgrppids.restype = ctypes.c_int
    size = 4096
    while True:
        pids = (ctypes.c_int * size)()
        ctypes.set_errno(0)
        count = libproc.proc_listpgrppids(pgid, pids, ctypes.sizeof(pids))
        if count < 0 or (count == 0 and ctypes.get_errno()):
            raise RuntimeError(f"Cannot inspect process group: errno={ctypes.get_errno()}")
        # Unlike proc_listpids, this wrapper returns a PID count, not bytes.
        if count < size:
            break
        size *= 2
    return any(info and info["running"] for pid in pids[:count]
               if pid > 0 for info in [process_identity(pid)])


if __name__ == "__main__":
    if sys.argv[1] == "lock":
        sys.exit(lock(sys.argv[2]))
    if sys.argv[1] == "identity":
        print(json.dumps(process_identity(int(sys.argv[2]))))
    elif sys.argv[1] == "group":
        print(json.dumps(group_running(int(sys.argv[2]))))
    else:
        raise SystemExit("Use lock, identity, or group")
