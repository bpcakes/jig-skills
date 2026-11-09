"""Trusted, isolated command bootstrap. EOF is never permission to execute.

The host passes only the read end of a private pipe. Run this module with
Python -I -S so repository and home configuration cannot run before the gate.
"""
import json
import os
import sys


def main():
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        return 125
    allowed = sys.argv[1] == "direct"
    if not allowed:
        descriptor = int(sys.argv[1])
        try:
            allowed = os.read(descriptor, 1) == b"S"
        except OSError:
            allowed = False
        finally:
            os.close(descriptor)
    if not allowed:
        print("command start was not authorized", file=sys.stderr)
        return 125
    with open(sys.argv[2], encoding="utf-8") as source:
        environment = json.load(source)
    os.execvpe(sys.argv[4], sys.argv[4:], environment)


if __name__ == "__main__":
    raise SystemExit(main())
