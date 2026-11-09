#!/usr/bin/env python3
"""Paired two-task live acceptance through an explicitly selected installation.

Models implement and review code; a deterministic coordinator relays task-scoped
messages and injects restart/replacement/cancellation. This is a bounded fixture,
not evidence about large repositories, hosted PR delivery or statistical savings.
Private profiles and raw provider output stay in the private output directory.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
import argparse
import copy
import hashlib
import importlib.metadata
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
RUNNER = "/opt/tools/live-model.py"
REVIEW_SELECTION = {"claude": {"model": "opus", "effort": "xhigh"},
                    "codex": {"model": "gpt-6-astra", "effort": "xhigh"}}

CLIENT = """Use only the canonical gateway for orchestration and shared evidence:
Python: sys.path.insert(0,'/opt/orchestration'); import communicate; communicate.request(dict).
CLI: /usr/bin/python3 -B /opt/orchestration/communicate.py --json '<JSON>'.
Start with query {op:'query',task_id:TASK,mode:os.environ['BENCH_QUERY_MODE']} and obtain
every unresolved finding. A compact response provides detail_request; add
path:['task','findings'],select:'unresolved_findings'. Decode content as JSON and
page using next_offset until complete. Read inbox {op:'inbox',task_id:TASK}; events
contain messages. Follow its cursor/more fields; wait with watch when necessary.
An inbox response supplies next_request: use it after processing the page. It
reads remaining pages or waits with view:'inbox'; a task-state watch will not wake
for messages. The supported wait duration is timeout_seconds, at most 30.
Only act on messages for your task. Retry a lost reply with the SAME action_id.
artifact_put publishes UTF-8 content with task_id and a unique action_id; default
readers include coordinator. message sends {op:'message',task_id:TASK,action_id:ID,
recipient:'coordinator',kind:'update',body:JSON_TEXT}. Never use files or another
service to exchange instructions with peers. If the gateway restarts, reconnect
and continue with the same credential and action IDs. Do not commit; the runtime
will commit the two allowed source files after you exit. Do not edit test inputs
or .gitignore. Do not read credentials or files outside this checkout.
"""

PROMPTS = {
    "A": """You are driver-A. Modify api.py so summarize(values) returns a dictionary
with count equal to the number of inputs and their sum under the exact key requested
by the consumer's interface-change message. The initial brief intentionally does
not know that key. Wait for the coordinator's message of kind interface_change,
read it and implement that contract. Do not change consumer.py. Validate empty,
positive and negative integer cases. Preserve support for any finite iterable of
integers, including single-use iterators and generators without len(). Publish api.py's complete text as artifact
action_id api-source. Then send update action_id api-ready with JSON body
{kind:'api_ready',artifact_id:<returned ID>,field:<the requested field>}.
Do not declare success before the artifact and update are accepted. Finish DONE.
""",
    "B": """You are driver-B. Read the unresolved consumer contract from your task
view. Send update action_id interface-request with JSON body
{kind:'interface_request',field:<the required field from the contract>}.
Wait for the coordinator's api_source message containing an artifact_id in task B.
Read that artifact through artifact_read (including pagination), write its exact
content to api.py, and update consumer.py: render(values) must use summarize(values)
and return '<count> items: <sum> cents', using the agreed dictionary key. Test
empty, positive and negative integers, including single-use iterators and generators;
preserve support for any finite iterable of integers. Publish consumer.py's complete text as
artifact action_id consumer-source, then send update action_id consumer-ready
with JSON body {kind:'consumer_ready',artifact_id:<returned ID>} and finish DONE.
""",
}


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def source_check(task):
    check = """from api import summarize
for values, expected in [([], {'count': 0, 'amount_minor': 0}), ([12, -4, 7], {'count': 3, 'amount_minor': 15})]:
    for inputs in (values, tuple(values), iter(values), (value for value in values)):
        assert summarize(inputs) == expected
"""
    if task == "B":
        check += """from consumer import render
for values, expected in [([], '0 items: 0 cents'), ([12, -4, 7], '3 items: 15 cents')]:
    for inputs in (values, tuple(values), iter(values), (value for value in values)):
        assert render(inputs) == expected
"""
    return check


def wait_until(predicate, seconds=600):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.25)
    raise TimeoutError("Acceptance predicate was not satisfied before its deadline")


def gateway_child(scripts, run, trace):
    # This wrapper only records protocol payloads. The installed server still
    # owns authentication, admission, dispatch, replies and maintenance.
    sys.path.insert(0, scripts)
    import gateway
    import channel
    from state import Engine
    import threading
    original, lock = gateway.handle, threading.Lock()

    def observed(run_dir, session, request, *args, **kwargs):
        started = time.monotonic()
        result = {"error": "interrupted"}
        try:
            result = original(run_dir, session, request, *args, **kwargs)
            return result
        except Exception as error:
            result = {"error": getattr(error, "code", type(error).__name__), "message": str(error)}
            raise
        finally:
            principal = Engine.read(run_dir)["communication"]["sessions"].get(session.id, {})
            row = {"actor": principal.get("actor"), "role": principal.get("role"),
                   "session_id": session.id, "gateway_pid": os.getpid(),
                   "provider": (principal.get("review_contract") or {}).get("provider"),
                   "request": channel.public(request), "response": channel.public(result),
                   "seconds": time.monotonic() - started, "at": time.time()}
            with lock, open(trace, "a") as file:
                file.write(json.dumps(row) + "\n")

    gateway.handle = observed
    with gateway.server(run) as server:
        server.serve_forever()


class Workflow:
    def __init__(self, args, mode, output):
        self.args, self.mode, self.output = args, mode, output
        output.mkdir(mode=0o700)
        self.pool = ThreadPoolExecutor(max_workers=4)
        self.process = None
        self.futures = []
        self.controls = []
        self.review_results = {}
        self.source_acceptance = {}
        self.inboxes = {task: {"cursor": None, "messages": {}} for task in ("A", "B")}
        self.started = time.monotonic()
        self.profiles = {name: json.loads(getattr(args, name + "_profile").read_text()) for name in ("claude", "codex")}
        from test_compatibility import RollbackTests
        self.fixture = RollbackTests("test_finish_current_preserves_running_boundary_across_gateway_restart")
        self.fixture.setUpClass()
        self.fixture.setUp()
        self.run = self.fixture.run
        self.trees = self.fixture.trees
        self.scripts = args.installed_skills / "herdr-orchestrate/scripts"
        self.base = {}
        for task in ("A", "B"):
            tree = self.trees / task
            (tree / ".gitignore").write_text("__pycache__/\n.writer-witness\n")
            (tree / "api.py").write_text("def summarize(values):\n    return str(sum(values))\n")
            (tree / "consumer.py").write_text("from api import summarize\n\ndef render(values):\n    return summarize(values)\n")
            self.git(task, "config", "user.name", "Acceptance Fixture")
            self.git(task, "config", "user.email", "fixture@example.invalid")
            self.git(task, "add", ".")
            self.git(task, "commit", "-qm", "Initial interface")
            self.base[task] = self.git(task, "rev-parse", "HEAD").strip()
        self.coordinator = channel.issue(self.run, "coordinator")
        self.start_gateway()

    def admit_tasks(self):
        for task in ("A", "B"):
            self.fixture.admit(task)
            findings = [{"id": f"old-{i}", "status": "resolved", "text": "Prior resolved implementation evidence. " * 24} for i in range(96)]
            findings[-1] = {"id": "current-contract", "status": "open", "text": (
                "The consumer requires the sum under dictionary key amount_minor; count is a separate field."
                if task == "B" else "The consumer will request its exact dictionary key through the coordinator. Apply it before publishing source.")}
            state = Engine.read(self.run)
            Engine.apply(self.run, {"op": "observe", "action_id": "requirements-" + task, "task_id": task,
                "expected_policy": state["policy_version"], "expected_task": state["tasks"][task]["version"],
                "fields": {"findings": findings}, "evidence": self.fixture.proof})

    def git(self, task, *argv):
        return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", *argv],
                                       cwd=self.trees / task, text=True, stderr=subprocess.STDOUT)

    def call(self, request, token=None, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Gateway remained busy; original request identity is unchanged")
            result = communicate.request(request, socket_path=str(self.run / "endpoint/gateway.sock"),
                                         credential=token or self.coordinator, timeout=remaining)
            if result.get("error") in {"busy", "state_busy", "restarting"}:
                # A control-plane admission refusal is not task failure. Keep
                # the same action/cursor and a bounded observation deadline.
                time.sleep(min(.1, max(0, deadline - time.monotonic())))
                continue
            if result.get("error"):
                raise RuntimeError(result)
            return result

    def start_gateway(self):
        log = (self.output / "gateway.log").open("ab")
        self.process = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--gateway",
            str(self.scripts), str(self.run), str(self.output / "trace.jsonl")], stdout=log, stderr=log)
        log.close()
        def ready():
            if self.process.poll() is not None:
                raise RuntimeError("Gateway exited; inspect gateway.log")
            try:
                return self.call({"op": "query"})
            except (OSError, ValueError):
                return None
        wait_until(ready, 15)

    def stop_gateway(self):
        if self.process is not None:
            self.process.terminate()
            self.process.wait(10)
            self.process = None

    def profile(self, provider, *, worker=False):
        profile = copy.deepcopy(self.profiles[provider])
        argv = profile.pop("argv")
        if worker and provider == "codex":
            setting = 'permissions.channel.extends=":read-only"'
            if setting not in argv:
                raise ValueError("Codex profile must explicitly select the verified channel permissions")
            argv[argv.index(setting)] = 'permissions.channel.extends=":workspace"'
        profile["workspace_access"] = "write" if worker else "read"
        profile.setdefault("mounts", []).append({"source": str(HERE / "live_model.py"), "target": RUNNER})
        profile.setdefault("environment", {})["BENCH_QUERY_MODE"] = self.mode
        profile.setdefault("files", []).append({"target": ".bench/provider.json",
            "content": json.dumps({"provider": provider, "argv": argv})})
        return profile

    def launch_driver(self, task, provider, *, resume=False):
        profile = self.profile(provider, worker=True)
        directory = isolation.prepare(self.run, "driver-" + task, task, profile=profile)
        prompt = CLIENT.replace("TASK", repr(task)) + (PROMPTS[task] if not resume else
            "Your predecessor finished implementation and was replaced. Query the current state and inbox; verify api.py implements the agreed interface, run its checks, and publish artifact action_id replacement-verified with your actual verification evidence. Do not change the source. Finish DONE.")
        argv = ["/usr/bin/python3", "-B", RUNNER, "--prompt", prompt]
        if not resume:
            argv += ["--hold", "--commit"]
        return directory, argv

    def start_driver(self, directory, argv):
        def run():
            with (self.output / (directory.name + ".stdout")).open("wb") as out, (self.output / (directory.name + ".stderr")).open("wb") as err:
                return isolation.launch(directory, argv, stdout=out, stderr=err, timeout=900)
        future = self.pool.submit(run)
        self.futures.append(future)
        return future

    def messages(self, task):
        # The fixture coordinator reads only its own task-scoped inbox.
        saved = self.inboxes[task]
        while True:
            request = {"op": "inbox", "task_id": task, "limit": 32}
            if saved["cursor"]:
                request["after"] = saved["cursor"]
            result = self.call(request)
            saved["messages"].update({event["message"]["id"]: event["message"] for event in result["events"]
                if "message" in event and event["message"]["recipient"] == "coordinator"})
            saved["cursor"] = result["cursor"]
            if not result["more"]:
                return list(saved["messages"].values())

    def message(self, task, identifier):
        for future in self.futures:
            if future.done() and future.exception():
                raise future.exception()
            if future.done() and future.result().returncode:
                raise RuntimeError("Driver exited before its required message; inspect provider logs")
        return next((row for row in self.messages(task) if row["id"] == identifier), None)

    def send(self, task, identifier, body):
        return self.call({"op": "message", "task_id": task, "action_id": identifier,
            "recipient": "driver-" + task, "kind": "assignment", "body": json.dumps(body)})

    def control(self, task, action):
        state = Engine.read(self.run)
        result = self.call({"op": "control", "task_id": task, "action_id": action + "-" + task + "-" + str(len(self.controls)),
                           "control": action, "expected_policy": state["policy_version"],
                           "expected_task": state["tasks"][task]["version"]})
        self.controls.append({"task": task, "action": action, "policy_version": result["policy_version"]})

    def exercise(self):
        self.coordinator_smoke()
        self.admit_tasks()
        parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
        canary = self.fixture.root / "host-only-canary"
        canary.write_text("This must not be visible inside the worker")
        probe = isolation.prepare(self.run, "boundary-probe-A", "A", role="executor", parent_session=parent,
                                  profile=self.profile("codex", worker=True))
        program = """import json,pathlib,socket,sys,shutil
sys.path.insert(0,'/opt/orchestration'); import communicate
assert not pathlib.Path(sys.argv[1]).exists()
assert not pathlib.Path(sys.argv[2]).exists()
assert shutil.which('herdr') is None
assert communicate.request({'op':'query','task_id':'B'})['error']=='wrong_task'
connection=socket.socket(); connection.settimeout(.3)
try: connection.connect(('1.1.1.1',443))
except OSError: pass
else: raise AssertionError('direct network route is available')
finally: connection.close()
assert communicate.request({'op':'query','task_id':'A'})['task']['id']=='A'
print('boundary-denied-alternate-routes')
"""
        tested = isolation.launch(probe, ["/usr/bin/python3", "-B", "-c", program, str(canary), str(self.run / "state.json")],
                                  capture_output=True, timeout=15)
        if tested.returncode or tested.stdout.strip() != b"boundary-denied-alternate-routes":
            raise AssertionError(tested.stderr.decode())
        self.controls.append({"alternate_route_probe": "passed"})
        launches = {task: self.launch_driver(task, provider) for task, provider in (("A", "codex"), ("B", "claude"))}
        running = {task: self.start_driver(*launch) for task, launch in launches.items()}
        request = json.loads(wait_until(lambda: self.message("B", "interface-request"))["body"])
        if request != {"kind": "interface_request", "field": "amount_minor"}:
            raise AssertionError(request)
        self.send("A", "interface-change", {"kind": "interface_change", "field": request["field"]})
        published = json.loads(wait_until(lambda: self.message("A", "api-ready"))["body"])
        source = self.call({"op": "artifact_read", "task_id": "A", "artifact_id": published["artifact_id"], "limit": 65536})
        if not source["complete"]:
            raise AssertionError("Fixture source exceeded its explicit artifact size")
        transferred = self.call({"op": "artifact_put", "task_id": "B", "action_id": "shared-api",
            "content": source["content"], "readers": ["coordinator", "driver-B"]})
        self.send("B", "handoff-api-to-B", {"kind": "api_source", "artifact_id": transferred["artifact"]["id"]})
        for task in ("A", "B"):
            wait_until(lambda task=task: self.message(task, "runtime-model-complete-" + task))
        wait_until(lambda: self.message("B", "consumer-ready"))
        # A live writer remains after model completion. Revocation fences its
        # protocol authority; explicit cancellation below owns job settlement.
        old_pid = self.process.pid
        self.stop_gateway()
        old_token = (launches["A"][0] / "credential").read_text().strip()
        replacement = self.launch_driver("A", "codex", resume=True)
        try:
            isolation.launch(*replacement, capture_output=True, timeout=10)
        except StateError as error:
            if error.code != "unsettled":
                raise
        else:
            raise AssertionError("Replacement overlapped the surviving writer")
        time.sleep(.75)
        self.start_gateway()
        stale = communicate.request({"op": "query", "task_id": "A"},
            socket_path=str(self.run / "endpoint/gateway.sock"), credential=old_token)
        if stale.get("error") != "session_revoked":
            raise AssertionError(stale)
        surviving_session = channel.parse_credential((launches["B"][0] / "credential").read_text().strip()).id
        def reconnected():
            # Client retries can conceal the disconnect. Observe the original
            # session succeeding at the new server, not a particular error log.
            content = (self.output / "trace.jsonl").read_text()
            complete_lines = content.splitlines() if content.endswith("\n") else content.splitlines()[:-1]
            return any(row.get("session_id") == surviving_session and row.get("gateway_pid") == self.process.pid
                and row["request"].get("op") == "query" and row["response"].get("task", {}).get("id") == "B"
                for row in (json.loads(line) for line in complete_lines))
        wait_until(reconnected, 15)
        with ExitStack() as connections:
            for _ in range(64):
                connection = connections.enter_context(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
                connection.settimeout(2)
                connection.connect(str(self.run / "endpoint/gateway.sock"))
            stopped = threading.Event()
            requests, failures = [], []
            def traffic():
                while not stopped.is_set():
                    started = time.monotonic()
                    try:
                        self.call({"op": "query", "task_id": "B", "mode": self.mode}, timeout=5)
                        requests.append(time.monotonic() - started)
                    except Exception as error:
                        failures.append(type(error).__name__)
                    stopped.wait(.01)
            with ThreadPoolExecutor(max_workers=8) as pressure:
                workers = [pressure.submit(traffic) for _ in range(8)]
                try:
                    wait_until(lambda: len(requests) >= 8, 10)
                    started = time.monotonic()
                    for task in ("A", "B"):
                        self.control(task, "cancel")
                    elapsed = time.monotonic() - started
                finally:
                    stopped.set()
                    for worker in workers:
                        worker.result(timeout=10)
            self.controls.append({"idle_connections": 64, "authenticated_clients": 8,
                "authenticated_requests": len(requests), "load_failures": failures,
                "maximum_query_seconds": max(requests), "cancel_seconds": elapsed, "cancel_deadline_seconds": 20})
            if failures:
                raise AssertionError("Authenticated traffic failed during cancellation: " + repr(failures))
            if elapsed > 20:
                raise AssertionError("Cancellation exceeded the declared control deadline under idle-connection load")
        for task, future in running.items():
            result = future.result(timeout=30)
            if result.returncode == 0:
                raise AssertionError("Surviving writer was not terminated")
            record = Engine.read(self.run)["communication"]["jobs"][launches[task][0].name]
            if not record["local_settled"]:
                raise AssertionError(record)
        for task in ("A", "B"):
            self.control(task, "resume")
        resumed = self.start_driver(*replacement).result(timeout=600)
        if resumed.returncode:
            raise AssertionError("Replacement model did not complete verification")
        self.controls.append({"restart_old_pid": old_pid, "restart_new_pid": self.process.pid,
                              "surviving_session_reconnected": True,
                              "replacement_overlap_denied": True, "stale_credential_denied": True})
        self.check_source()
        self.source_acceptance["before_review"] = True
        self.review()

    def coordinator_smoke(self):
        from live_model import final_text
        if Engine.read(self.run)["tasks"]:
            raise AssertionError("Coordinator startup must be tested before task admission")
        for provider in ("claude", "codex"):
            directory = isolation.prepare(self.run, "coordinator", None, profile=self.profile(provider))
            prompt = ("You are the coordinator startup probe. There is no assigned task and no ORCHESTRATION_TASK. "
                "Use your terminal tool to call /usr/bin/python3 -B /opt/orchestration/communicate.py "
                "--json '{\"op\":\"query\"}'. Check that it succeeds, then reply COORDINATOR_READY. "
                "Do not modify files, read credentials, or perform any other work.")
            result = isolation.launch(directory, ["/usr/bin/python3", "-B", RUNNER, "--role", "coordinator-smoke", "--prompt", prompt],
                                      capture_output=True, timeout=180)
            (self.output / (provider + "-coordinator.stdout")).write_bytes(result.stdout)
            (self.output / (provider + "-coordinator.stderr")).write_bytes(result.stderr)
            if result.returncode or "COORDINATOR_READY" not in final_text(provider, result.stdout.decode()):
                raise AssertionError("Selected provider coordinator startup failed: " + provider)
            session = channel.parse_credential((directory / "credential").read_text().strip()).id
            trace = [json.loads(line) for line in (self.output / "trace.jsonl").read_text().splitlines()]
            if not any(row["session_id"] == session and row["request"].get("op") == "query"
                       and "error" not in row["response"] for row in trace):
                raise AssertionError("Coordinator did not query the canonical gateway: " + provider)
            self.controls.append({"coordinator_smoke_provider": provider, "coordinator_smoke_session": session,
                                  "before_admission": True, "gateway_query": True})
        self.coordinator = channel.issue(self.run, "coordinator")

    def check_source(self):
        for task in ("A", "B"):
            check = source_check(task)
            directory = isolation.prepare(self.run, "acceptance-" + task, task, role="executor",
                parent_session=channel.authorizing_session(Engine.read(self.run),
                    Engine.read(self.run)["communication"]["active"]["driver-" + task], task),
                profile={"schema": 1, "workspace_access": "read"})
            result = isolation.launch(directory, ["/usr/bin/python3", "-B", "-c", check], capture_output=True, timeout=15)
            if result.returncode:
                raise AssertionError(result.stderr.decode())
            for filename in ("api.py", "consumer.py"):
                (self.output / (task + "-" + filename)).write_bytes((self.trees / task / filename).read_bytes())

    def review(self):
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("The installed controller requires Node")
        node = str(Path(node).resolve())
        root = self.args.installed_skills
        profiles = {}
        for provider in ("claude", "codex"):
            profile = self.profile(provider)
            executable = self.profiles[provider]["argv"][0]
            meter = self.output / (provider + "-meter")
            # Both paths are host-defined constants, never model/repository text.
            meter.write_text(f'#!/bin/sh\nexec /usr/bin/python3 -B {RUNNER} --proxy {provider} {executable} "$@"\n')
            meter.chmod(0o700)
            target = "/opt/tools/bin/" + provider + "-meter"
            profile["mounts"] += [{"source": str(meter), "target": target},
                {"source": node, "target": "/opt/tools/bin/node"},
                {"source": str(root), "target": "/opt/tools/review-skills"}]
            profile["environment"]["JIG_" + provider.upper() + "_BIN"] = target
            profiles[provider] = profile
        profiles["triage"] = self.profile("codex")
        profiles["repair"] = self.profile("codex", worker=True)
        profiles["validate"] = {"schema": 1, "workspace_access": "read"}
        adapters = {}
        for task in ("A", "B"):
            criterion = ("summarize(values) returns exactly count and amount_minor with the count and sum of integer inputs."
                if task == "A" else "render(values) consumes the agreed summarize dictionary and returns '<count> items: <sum> cents'.")
            criterion += " Preserve any finite iterable of integers, including single-use iterators and generators without len()."
            check = source_check(task) + "\nprint('workflow-validation-" + task + "')"
            adapters["review-" + task] = {"kind": "review", "host": "local", "timeout_seconds": 900,
                "controller": {"task_id": task, "node": node, "skill_root": str(root / "review-fix-loop"),
                    "options": ["--base", self.base[task], "--commit-mode", "per-round", "--reviewers", "claude,codex",
                        "--max-rounds", "2", "--claude-model", REVIEW_SELECTION["claude"]["model"],
                        "--claude-effort", REVIEW_SELECTION["claude"]["effort"], "--claude-launcher", "none",
                        "--codex-runtime", "cli", "--codex-model", REVIEW_SELECTION["codex"]["model"],
                        "--codex-effort", REVIEW_SELECTION["codex"]["effort"], "--codex-launcher", "none"],
                    "config": {"reviewers": [{"id": provider, "command": [node,
                        str(root / "review-fix-loop/scripts/provider-bridge.mjs"), provider]} for provider in ("claude", "codex")],
                        "triageCommand": ["/usr/bin/python3", "-B", str(HERE / "live_model.py"), "--assignment"],
                        "repairCommand": ["/usr/bin/python3", "-B", str(HERE / "live_model.py"), "--assignment"],
                        "timeoutMs": 240000, "validationMode": "checkout", "reviewConcurrency": 2},
                    "contract": {"goal": criterion, "nonGoals": ["Floating-point money, external services or UI"],
                        "compatibilityConstraints": ["When validationEvidence provides logArtifact references, retrieve their ordered parts using the canonical communication client and report the observed workflow-validation marker as evidence."],
                        "permittedBehaviorChanges": [criterion], "acceptanceCriteria": [{"id": "interface", "description": criterion}],
                        "requiredValidation": [{"id": "unit", "argv": ["/usr/bin/python3", "-B", "-c", check]}]},
                    "profiles": profiles}}
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "configure", "action_id": "configure-live-reviews",
            "expected_policy": state["policy_version"], "fields": {"adapters": adapters}, "evidence": self.fixture.proof})
        for task in ("A", "B"):
            state = Engine.read(self.run)
            request = {"op": "execute", "task_id": task, "action_id": "review-combined-" + task,
                "kind": "review", "adapter": "review-" + task, "target": {"worktree": str(self.trees / task)},
                "refs": {}, "evidence": self.fixture.proof, "expected_policy": state["policy_version"],
                "expected_task": state["tasks"][task]["version"]}
            result = self.call(request, timeout=920)
            self.review_results[task] = result
            dump(self.output / (task + "-review.json"), result)
            if result.get("outcome") != "succeeded" or result.get("receipt", {}).get("controller", {}).get("phase") != "CONVERGED":
                raise AssertionError("Live controller did not converge: " + task)
        self.check_source()
        self.source_acceptance["after_review"] = True

    def collect(self, error):
        # Copy every native invocation before parsing any provider output.
        # Local CLI probes may emit arrays instead of model event envelopes.
        copied = []
        for file in sorted((self.run / "launches").glob("*/home/measurement/*/invocation.json")):
            destination = self.output / "provider-output" / file.parents[3].name / file.parent.name
            destination.mkdir(parents=True, exist_ok=True)
            for captured in file.parent.iterdir():
                shutil.copyfile(captured, destination / captured.name)
            copied.append(destination)
        for task, result in self.review_results.items():
            from workflow_evidence import retain_controller
            retain_controller(result, run=self.run, workspace=self.trees / task,
                              destination=self.output / "controller-output" / task)
        invocations = []
        for destination in copied:
            metadata = json.loads((destination / "invocation.json").read_text())
            raw = (destination / "stdout").read_text() if (destination / "stdout").exists() else ""
            from live_communication import usage
            invocations.append({**{key: value for key, value in metadata.items() if key not in {"argv", "prompt"}},
                                "output": str(destination), **(usage(metadata["provider"], raw)
                                    if metadata.get("model_request", True) else {"usage": None, "observed_models": []})})
        trace = [json.loads(line) for line in (self.output / "trace.jsonl").read_text().splitlines()]
        import tiktoken
        encoding = tiktoken.get_encoding("o200k_base")
        helper_sessions, model_rows = set(), []
        coordinator_sessions = {row["coordinator_smoke_session"] for row in self.controls if "coordinator_smoke_session" in row}
        for row in trace:
            action = row["request"].get("action_id", "")
            if action.startswith("runtime-model-complete-"):
                helper_sessions.add(row["session_id"])
            if ((row.get("actor") != "coordinator" or row["session_id"] in coordinator_sessions) and row["session_id"] not in helper_sessions
                    and not row.get("actor", "").startswith(("boundary-probe-", "acceptance-"))):
                model_rows.append(row)
        log_reads = {task: {provider: sum(row.get("provider") == provider and row["request"].get("task_id") == task
            and row["request"].get("op") == "artifact_read" and "workflow-validation-" + task in row["response"].get("content", "")
            for row in model_rows) for provider in ("claude", "codex")} for task in ("A", "B")}
        from workflow_evidence import summarize as summarize_evidence
        sessions = Engine.read(self.run)["communication"]["sessions"]
        evidence = summarize_evidence({key: {**record, "review_contract": channel.contract(self.run, record)}
                                       for key, record in sessions.items()}, trace)
        if error is None and not evidence["all_selected_reviewers_present"]:
            error = {"type": "AssertionError", "message": "Selected reviewer evidence metadata is missing"}
        if error is None and not evidence["all_supplied_logs_retrieved"]:
            error = {"type": "AssertionError", "message": "A reviewer did not completely retrieve a supplied validation log"}
        from workflow_usage import summarize
        result = {"mode": self.mode, "seconds": time.monotonic() - self.started, "error": error,
            "workflow_success": error is None, "source_acceptance": self.source_acceptance,
            "joint_source_acceptance": self.source_acceptance.get("after_review", False),
            "controls": self.controls, "invocations": invocations,
            "provider_usage": summarize(invocations),
            "gateway_payload_tokens": sum(len(encoding.encode(json.dumps(row[key], sort_keys=True), disallowed_special=()))
                for row in model_rows for key in ("request", "response")), "model_gateway_requests": len(model_rows),
            "review_completed": len(self.review_results) == 2 and all(row.get("outcome") == "succeeded" for row in self.review_results.values()),
            "validation_log_reads": log_reads, "validation_evidence": evidence, "synthetic_roles": ["coordinator"],
            "live_roles": sorted({row["role"] for row in invocations if row.get("model_request", True)}),
            "configured_model_roles": ["coordinator startup probe", "implementation", "replacement verification", "review", "triage", "repair if requested"]}
        dump(self.output / "result.json", result)
        return result

    def settle(self):
        # Owned fixture cleanup is a trusted host operation, including when a
        # deliberately interrupted gateway cannot serve model requests.
        import jobs
        for task in ("A", "B"):
            for attempt in range(5):
                state = Engine.read(self.run)
                if task not in state["tasks"]:
                    break  # A coordinator startup failure can precede admission.
                try:
                    Engine.apply(self.run, {"op": "control", "task_id": task, "action_id": "cleanup-" + task,
                        "control": "cancel", "expected_policy": state["policy_version"],
                        "expected_task": state["tasks"][task]["version"]})
                    break
                except StateError as error:
                    if error.code not in {"stale_task", "stale_policy"} or attempt == 4:
                        raise
        jobs.cancel_requested(self.run)
        self.pool.shutdown(wait=True)
        self.stop_gateway()


def required_evidence_access(args, output, runtime):
    """Run the real-adapter log probe before spending on the paired workflow."""
    from workflow_evidence import live_access_complete
    destination = output / "evidence-access"
    command = [sys.executable, "-B", str(HERE / "live_controller.py"),
               "--installed-skills", str(args.installed_skills), "--output", str(destination)]
    for provider, selected in REVIEW_SELECTION.items():
        command += ["--" + provider + "-profile", str(getattr(args, provider + "_profile")),
                    "--" + provider + "-model", selected["model"],
                    "--" + provider + "-effort", selected["effort"]]
    with (output / "evidence-access.stdout").open("wb") as stdout, (output / "evidence-access.stderr").open("wb") as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr)
    record = {"status": "failed", "returncode": result.returncode,
              "summary": str(destination / "summary.json")}
    try:
        raw = (destination / "summary.json").read_bytes()
        probe = json.loads(raw)
        record["summary_sha256"] = hashlib.sha256(raw).hexdigest()
        if result.returncode != 0 or not live_access_complete(probe, runtime):
            record["error"] = "Selected-provider log access is absent, incomplete or bound to another runtime"
        else:
            record.update(status="passed", validation_log_reads=probe["validation_log_reads"],
                          seconds=probe["seconds"], boundary_contexts=probe["boundary_contexts"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        record["error"] = str(error)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-skills", required=True, type=Path)
    parser.add_argument("--claude-profile", required=True, type=Path)
    parser.add_argument("--codex-profile", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--order", choices=("full-first", "auto-first"), default="full-first")
    parser.add_argument("--variant", choices=("full", "auto"), help="Single diagnostic variant; not a paired comparison")
    args = parser.parse_args()
    args.installed_skills = args.installed_skills.resolve(strict=True)
    output = args.output.resolve()
    if output == REPOSITORY or REPOSITORY in output.parents:
        parser.error("raw execution evidence must stay outside the checkout")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.environ["JIG_ORCHESTRATION_TEST_SCRIPTS"] = str(args.installed_skills / "herdr-orchestrate/scripts")
    os.environ["JIG_ORCHESTRATION_REQUIRE_ISOLATION"] = "1"
    sys.path.insert(0, str(HERE.parent / "tests"))
    global channel, communicate, isolation, Engine, StateError
    from test_channel import channel, communicate, isolation, Engine, StateError
    summary = {"measured_at": datetime.now(timezone.utc).isoformat(), "variants": [],
        "installed_skills": str(args.installed_skills), "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "runner_sha256": hashlib.sha256((HERE / "live_model.py").read_bytes()).hexdigest(),
        "usage_aggregator_sha256": hashlib.sha256((HERE / "workflow_usage.py").read_bytes()).hexdigest(),
        "evidence_verifier_sha256": hashlib.sha256((HERE / "workflow_evidence.py").read_bytes()).hexdigest(),
        "evidence_probe_harness_sha256": hashlib.sha256((HERE / "live_controller.py").read_bytes()).hexdigest(),
        "evidence_access": {"status": "not_run"}, "paired_acceptance": False,
        "profile_sha256": {provider: hashlib.sha256(getattr(args, provider + "_profile").read_bytes()).hexdigest()
                           for provider in ("claude", "codex")},
        "runtime_sha256": {str(file.relative_to(args.installed_skills)): hashlib.sha256(file.read_bytes()).hexdigest()
            for skill in ("herdr-orchestrate", "review-fix-loop", "panel-review")
            for file in sorted((args.installed_skills / skill / "scripts").rglob("*"))
            if file.is_file() and "__pycache__" not in file.parts},
        "tokenizer": {"library": "tiktoken", "version": importlib.metadata.version("tiktoken"), "encoding": "o200k_base"},
        "limitations": ["One bounded fixture, no statistical reliability or tail-latency claim.",
            "Task coordination is deterministic. Separate selected-provider coordinator startup probes query the gateway before admission.",
            "Provider usage includes native CLI context and tools; missing counters remain unknown.",
            "Private homes do not imply cold provider caches; execution order can affect costs.",
            "The mandatory separate log-access probe is excluded from variant time, payload and provider-usage comparisons.",
            "This fixture does not exercise GitHub publication or tracker closure."]}
    modes = [args.variant] if args.variant else (["full", "auto"] if args.order == "full-first" else ["auto", "full"])
    summary["requested_variants"] = modes
    dump(output / "result.json", summary)
    if args.variant is None:
        summary["evidence_access"] = required_evidence_access(args, output, summary["runtime_sha256"])
        dump(output / "result.json", summary)
        print(json.dumps({"required_evidence_access": summary["evidence_access"]}), flush=True)
        if summary["evidence_access"]["status"] != "passed":
            return 1
    else:
        summary["evidence_access"] = {"status": "not_required_single_variant_diagnostic"}
        dump(output / "result.json", summary)
    for mode in modes:
        if any(hashlib.sha256(getattr(args, provider + "_profile").read_bytes()).hexdigest() != digest
               for provider, digest in summary["profile_sha256"].items()):
            raise ValueError("A selected private profile changed during the comparison")
        workflow = Workflow(args, mode, output / mode)
        error, collected = None, False
        try:
            workflow.exercise()
        except Exception as failure:
            error = {"type": type(failure).__name__, "message": str(failure), "traceback": traceback.format_exc()}
            dump(workflow.output / "failure.json", error)
            # Capture the failed state before cleanup changes cancellation and
            # settlement, so a successful cleanup cannot hide the original fault.
            dump(workflow.output / "failure-jobs.json", Engine.read(workflow.run).get("communication", {}).get("jobs", {}))
            dump(workflow.output / "failure-controls.json", workflow.controls)
        finally:
            try:
                try:
                    workflow.settle()
                except Exception as failure:
                    cleanup_error = {"type": type(failure).__name__, "message": str(failure), "traceback": traceback.format_exc()}
                    error = {"primary": error, "cleanup": cleanup_error}
                    dump(workflow.output / "failure.json", error)
                result = workflow.collect(error)
                collected = True
                summary["variants"].append(result)
                dump(output / "result.json", summary)
                print(json.dumps({"mode": mode, "error": result["error"], "seconds": result["seconds"], "invocations": len(result["invocations"])}), flush=True)
            finally:
                jobs = Engine.read(workflow.run).get("communication", {}).get("jobs", {})
                if collected and all(job.get("local_settled") for job in jobs.values()):
                    workflow.fixture.doCleanups()
                else:
                    workflow.fixture.temp._finalizer.detach()
                    print(json.dumps({"fixture_retained": str(workflow.fixture.root),
                                      "collection_complete": collected}), flush=True)
    successful = all(row["error"] is None for row in summary["variants"])
    summary["paired_acceptance"] = args.variant is None and successful and summary["evidence_access"]["status"] == "passed"
    dump(output / "result.json", summary)
    return 0 if successful else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--gateway"]:
        gateway_child(*sys.argv[2:])
    else:
        raise SystemExit(main())
