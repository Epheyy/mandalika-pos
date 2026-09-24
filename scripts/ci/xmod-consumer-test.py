#!/usr/bin/env python3
"""Bounded, offline execution of the real selected x/mod test library.

Compilation uses the normal authenticated module setup. The test executable has
only in-memory ClientOps/TileReader fixtures, no proxy, HTTP service or disk cache.
The ordinary backend race suite also runs these tests; this separate non-race
lane enforces an address/process-memory cap without constraining TSan's shadow map.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

EXPECTED = {
    "TestXModLookupValid", "TestXModLookupRejectsUnauthenticatedLines",
    "TestXModTileValid", "TestXModTileRejectsTamperedAncestry",
    "TestXModConsumerParsing",
}


def linux_limits():
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (4 << 30, 4 << 30))
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))


def windows_job(process):
    from ctypes import wintypes as w

    class Basic(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", w.DWORD), ("min_ws", ctypes.c_size_t),
                    ("max_ws", ctypes.c_size_t), ("processes", w.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ["read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes"]]

    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", IO), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                    ("peak_job", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise OSError("cannot create owned memory-limit job")
    limits = Extended()
    limits.basic.flags = 0x100 | 0x2000  # process memory / kill on job close
    limits.process_memory = 512 << 20
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, w.HANDLE(process._handle)):
        kernel.CloseHandle(job)
        raise OSError("cannot attach owned test process memory limit")
    return lambda: kernel.CloseHandle(job)


def bounded(command, cwd, env, seconds, cap, constrain=False):
    start = time.monotonic()
    child = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT,
                             preexec_fn=linux_limits if constrain and os.name != "nt" else None)
    output = bytearray()
    exceeded = threading.Event()
    close_job = None

    def read():
        while chunk := child.stdout.read(4096):
            remaining = max(0, cap - len(output))
            output.extend(chunk[:remaining])
            if len(chunk) > remaining:
                exceeded.set()
                child.kill()

    reader = threading.Thread(target=read, daemon=True)
    timed_out = False
    try:
        if constrain and os.name == "nt":
            close_job = windows_job(child)
        reader.start()
        try:
            child.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()
            child.wait(timeout=5)
        reader.join(timeout=5)
        if reader.is_alive():
            raise RuntimeError("output pipe did not close")
        return {"command": command, "cwd": str(cwd), "exit": child.returncode,
                "timeout": timed_out, "outputLimitExceeded": exceeded.is_set(),
                "seconds": round(time.monotonic() - start, 3), "output": output.decode("utf8", errors="replace"),
                "reaped": child.poll() is not None}
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        if close_job:
            close_job()
        child.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2] / "backend")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    env = dict(os.environ, GOWORK="off", GOFLAGS="-mod=readonly")
    version = subprocess.check_output(["go", "env", "GOVERSION"], cwd=root, env=env, text=True, timeout=30).strip()
    match = re.fullmatch(r"go(\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (1, 26, 6):
        raise RuntimeError("select an already-qualified Go >=1.26.6 process toolchain first")
    temporary = Path(tempfile.mkdtemp(prefix="mandalika-xmod-test-")).resolve()
    parent = Path(tempfile.gettempdir()).resolve()
    report = {"go": version, "platform": os.name, "phases": [], "status": "fail",
              "bounds": {"fixtureBytes": 65536, "testSeconds": 20, "outputBytes": 262144,
                         "goSoftMemoryBytes": 64 << 20,
                         "hardMemory": "Windows process commit512MiB; job attached before waiting" if os.name == "nt" else "Linux address space4GiB + CPU15s"},
              "network": "in-memory public APIs; no HTTP/disk-cache implementation"}
    try:
        binary = temporary / ("xmod.test.exe" if os.name == "nt" else "xmod.test")
        build = bounded(["go", "test", "-c", "-o", str(binary), "./internal/dependencycheck"], root, env, 240, 1 << 20)
        report["phases"].append(build)
        if build["exit"] != 0 or build["timeout"] or build["outputLimitExceeded"]:
            return 1
        report["binarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        test_env = dict(env, GOPROXY="off", GOMEMLIMIT="64MiB")
        result = bounded([str(binary), "-test.v", "-test.run=^TestXMod", "-test.timeout=10s"], temporary, test_env, 20, 262144, constrain=True)
        report["phases"].append(result)
        passed = re.findall(r"^--- PASS: (\w+)", result["output"], re.M)
        report["passed"] = passed
        report["skipped"] = re.findall(r"^--- SKIP: (\w+)", result["output"], re.M)
        report["status"] = "pass" if result["exit"] == 0 and not result["timeout"] and not result["outputLimitExceeded"] and set(passed) == EXPECTED and len(passed) == len(EXPECTED) and not report["skipped"] else "fail"
        return 0 if report["status"] == "pass" else 1
    finally:
        if temporary.parent != parent or not temporary.name.startswith("mandalika-xmod-test-") or temporary.is_symlink():
            raise RuntimeError("owned fixture path identity changed")
        shutil.rmtree(temporary)
        report["cleanup"] = "owned binary directory removed" if not temporary.exists() else "uncertain"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
