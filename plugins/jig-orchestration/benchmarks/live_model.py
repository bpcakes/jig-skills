#!/usr/bin/env python3
"""Disposable acceptance runner; retain native provider output before parsing it.

Runs only inside a provisioned launch. The host supplies the selected CLI argv
in its private home. No credentials or alternate transport are configured here.
"""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import uuid


def invocation_metadata(provider, argv):
    def selected(*names):
        for index, item in enumerate(argv[:-1]):
            if item in names:
                return argv[index + 1]
        return None
    version = subprocess.run([argv[0], "--version"], stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=10)
    return {"provider": provider, "argv": argv, "cli_version": version.stdout.strip() if version.returncode == 0 else None,
            "requested_model": selected("--model", "-m"),
            "requested_effort": selected("--effort") or next((item.split("=", 1)[1].strip('"') for item in argv
                if item.startswith("model_reasoning_effort=")), None)}


def proxy(provider, executable, argv):
    """Transparent CLI measurement for the unmodified selected review adapter."""
    directory = Path.home() / "measurement" / uuid.uuid4().hex
    directory.mkdir(mode=0o700, parents=True)
    metadata = {**invocation_metadata(provider, [executable, *argv]), "role": "review-provider",
                "model_request": "-p" in argv if provider == "claude" else "exec" in argv,
                "started_at": time.time(), "returncode": None}
    (directory / "invocation.json").write_text(json.dumps(metadata))
    started = time.monotonic()
    process = subprocess.Popen([executable, *argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def copy(stream, target, filename):
        with (directory / filename).open("wb") as saved:
            while chunk := os.read(stream.fileno(), 16384):
                saved.write(chunk)
                saved.flush()
                target.write(chunk)
                target.flush()

    workers = [threading.Thread(target=copy, args=(process.stdout, sys.stdout.buffer, "stdout")),
               threading.Thread(target=copy, args=(process.stderr, sys.stderr.buffer, "stderr"))]
    for worker in workers:
        worker.start()
    code = process.wait()
    for worker in workers:
        worker.join()
    metadata.update(returncode=code, seconds=time.monotonic() - started)
    (directory / "invocation.json").write_text(json.dumps(metadata))
    return code


def final_text(provider, raw):
    if provider == "claude":
        value = json.loads(raw)
        if value.get("is_error"):
            raise ValueError(value.get("result", "Claude failed"))
        return value["result"]
    records = [json.loads(line) for line in raw.splitlines() if line.strip()]
    messages = [item["item"]["text"] for item in records if item.get("type") == "item.completed"
                and item.get("item", {}).get("type") == "agent_message"]
    if not messages:
        raise ValueError("Codex did not produce a final agent message")
    return messages[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt")
    parser.add_argument("--role", choices=("driver", "coordinator-smoke"), default="driver")
    parser.add_argument("--assignment", action="store_true")
    parser.add_argument("--hold", action="store_true")
    parser.add_argument("--commit", action="store_true")
    args = parser.parse_args()
    config = json.loads((Path.home() / ".bench/provider.json").read_text())
    assignment = json.load(sys.stdin) if args.assignment else None
    prompt = args.prompt
    if assignment is not None:
        prompt = ("Perform this review-fix controller assignment in the selected checkout. "
                  "Return exactly one JSON object matching resultSchema, with every required field. "
                  "Triage must assess each supplied finding using its evidence and recorded validation; "
                  "do not invent receipts. Repair may edit source only as authorized by the assignment. "
                  "Do not commit or change Git metadata. Use only the canonical communication client "
                  "for orchestration or evidence retrieval. The assigned source can be read and tested "
                  "using ordinary local tools within this sandbox. To read approved channel evidence, "
                  "run /usr/bin/python3 -B /opt/orchestration/communicate.py --json '<JSON>' with "
                  "op:artifact_read, task_id:os.environ['ORCHESTRATION_TASK'], and the supplied artifact_id. "
                  "Page using next_offset until complete. The trusted launcher already enforces the "
                  "execution boundary; context is an adapter attestation operation requiring the outer "
                  "launch namespace, not a prerequisite to source reads or artifact_read inside this "
                  "CLI's nested sandbox. Missing initial validation receipts mean validation is still "
                  "required; never invent a passed check.\n" + json.dumps(assignment))
    if not prompt:
        parser.error("supply --prompt or --assignment")
    directory = Path.home() / "measurement" / uuid.uuid4().hex
    directory.mkdir(mode=0o700, parents=True)
    started = time.monotonic()
    metadata = {**invocation_metadata(config["provider"], config["argv"]),
                "role": assignment.get("role") if assignment else args.role,
                "assignment_id": assignment.get("id") if assignment else None,
                "prompt": prompt, "started_at": time.time(), "returncode": None}
    (directory / "invocation.json").write_text(json.dumps(metadata))
    with (directory / "stdout").open("wb") as stdout, (directory / "stderr").open("wb") as stderr:
        result = subprocess.run([*config["argv"], prompt], stdin=subprocess.DEVNULL,
                                stdout=stdout, stderr=stderr)
    metadata.update(returncode=result.returncode, seconds=time.monotonic() - started)
    (directory / "invocation.json").write_text(json.dumps(metadata))
    raw = (directory / "stdout").read_text()
    if result.returncode:
        sys.stderr.write((directory / "stderr").read_text())
        sys.stdout.write(raw)
        return result.returncode
    if assignment is not None:
        text = final_text(config["provider"], raw).strip()
        if text.startswith("```json\n") and text.endswith("\n```"):
            text = text[8:-4]
        print(json.dumps(json.loads(text)), flush=True)
    else:
        sys.stdout.write(raw)
        sys.stdout.flush()
    if args.commit:
        git = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"]
        subprocess.run([*git, "add", "--", "api.py", "consumer.py"], check=True, stdout=sys.stderr)
        changed = subprocess.run([*git, "diff", "--cached", "--quiet"]).returncode
        if changed == 1:
            subprocess.run([*git, "commit", "-qm", "Implement the assigned interface contract"],
                           check=True, stdout=sys.stderr)
        elif changed:
            raise RuntimeError("Could not inspect the implementation changes")
    if args.hold:
        sys.path.insert(0, "/opt/orchestration")
        import communicate
        task = os.environ["ORCHESTRATION_TASK"]
        response = communicate.request({"op": "message", "task_id": task,
            "action_id": "runtime-model-complete-" + task, "recipient": "coordinator", "kind": "update",
            "body": json.dumps({"kind": "runtime_model_complete", "returncode": result.returncode})})
        if response.get("error"):
            raise RuntimeError(response)
        # Keep a real source writer alive after provider usage has been emitted.
        # This file is an effect witness, not a communication or authority route.
        while True:
            Path(".writer-witness").write_text(str(time.monotonic_ns()))
            try:
                communicate.request({"op": "query", "task_id": task}, timeout=2)
            except (OSError, ValueError):
                pass
            time.sleep(.25)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--proxy"]:
        raise SystemExit(proxy(sys.argv[2], sys.argv[3], sys.argv[4:]))
    raise SystemExit(main())
