#!/usr/bin/env python3
"""Paired live model retrieval probes using an explicit private launch profile.

These are small acceptance probes, not statistically powered task benchmarks.
Profiles select the real model and runtime; this script never substitutes them.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch

from communication import Fixture, ROOT
from test_channel import channel, Engine, gateway, isolation
from state import canonical
from profiles import load

PROMPT = """You are driver-A for task A in a disposable orchestration acceptance probe.
Retrieve every unresolved finding (status other than resolved, fixed or rejected) for task A.
Use the authenticated client: Python import communicate from /opt/orchestration; communicate.request accepts a dict.
First query with {"op":"query","task_id":"A","mode":os.environ["BENCH_QUERY_MODE"]}.
For compact results, detail_request identifies an immutable snapshot. Add path:["task","findings"] and
select:"unresolved_findings" to fetch unresolved entries as {index,finding}; content is JSON text and complete/next_offset
indicate pagination. You may process all responses locally in Python; do not print the full historical findings.
Publish exactly one artifact with op:artifact_put, task_id:A, action_id:benchmark-answer, and content containing
JSON {"findings":[{"id":original_id,"text":complete_original_text}, ...]} in original order.
Then respond DONE. Do not change source, call other services, or communicate through another route.
"""


def usage(provider, raw):
    try:
        if provider == "claude":
            result = json.loads(raw)
            if not isinstance(result, dict) or not isinstance(result.get("modelUsage") or {}, dict):
                raise ValueError("Unexpected Claude usage envelope")
            return {"usage": result.get("usage"), "model_usage": result.get("modelUsage"),
                    "observed_models": sorted((result.get("modelUsage") or {}).keys()),
                    "reported_cost_usd": result.get("total_cost_usd")}
        records = [json.loads(line) for line in raw.splitlines() if line.strip()]
        completed = [item for item in records if isinstance(item, dict) and item.get("type") == "turn.completed"]
        models = sorted({item["model"] for item in records if isinstance(item, dict) and isinstance(item.get("model"), str)})
        return {"usage": [item.get("usage") for item in completed], "observed_models": models}
    except (ValueError, KeyError, TypeError):
        return {"usage": None, "observed_models": [], "parse_error": True}


def run_variant(provider, profile, mode, output, encoding):
    fixture = Fixture()
    fixture.setUp()
    try:
        fixture.socket_server()
        findings = [{"id": "F" + str(index), "status": "resolved", "text": "Old resolved evidence. " * 30}
                    for index in range(128)]
        for index in (95, 127):
            findings[index].update(status="open", text=f"R{index}: preserve the immutable operation identity after retry; inspect before redispatch.")
        state = Engine.read(fixture.run)
        Engine.apply(fixture.run, {"op": "observe", "task_id": "A", "action_id": "input-findings",
                                   "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
                                   "fields": {"findings": findings}, "evidence": fixture.proof})
        configured = copy.deepcopy(profile)
        configured["workspace_access"] = "none"
        configured.setdefault("environment", {})["BENCH_QUERY_MODE"] = mode
        directory = isolation.prepare(fixture.run, "driver-A", "A", profile=configured)
        traces = []
        handle = gateway.handle

        def traced(run_dir, session, request, *args, **kwargs):
            result = handle(run_dir, session, request, *args, **kwargs)
            traces.append({"request": request, "response": channel.public(result)})
            return result

        started = time.perf_counter()
        error = None
        stdout_path, stderr_path = output / (mode + ".stdout"), output / (mode + ".stderr")
        with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
            try:
                with patch.object(gateway, "handle", side_effect=traced):
                    result = isolation.launch(directory, [*configured["argv"], PROMPT], stdout=out, stderr=err, timeout=300)
                returncode = result.returncode
            except Exception as exc:
                error = {"type": type(exc).__name__, "message": str(exc)}
                returncode = None
        elapsed = time.perf_counter() - started
        state = Engine.read(fixture.run)
        reports = []
        for artifact in state["communication"].get("artifacts", {}).values():
            if artifact["owner"] == "driver-A":
                reports.append(json.loads((fixture.run / "artifacts" / artifact["sha256"]).read_text()))
        expected = {"findings": [{"id": item["id"], "text": item["text"]} for item in findings if item["status"] == "open"]}
        (output / (mode + ".trace.json")).write_text(json.dumps(traces, indent=2) + "\n")
        return {"mode": mode, "returncode": returncode, "error": error, "wall_seconds": elapsed,
                "complete_correct_retrieval": reports == [expected], "published_reports": reports,
                "gateway_requests": len(traces),
                "gateway_payload_tokens": sum(len(encoding.encode(canonical(item), disallowed_special=()))
                                              for record in traces for item in record.values()),
                **usage(provider, stdout_path.read_text())}
    finally:
        fixture.doCleanups()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("codex", "claude"), required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--requested-model", required=True)
    parser.add_argument("--effort", required=True)
    parser.add_argument("--cli-version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--order", choices=("full-first", "auto-first"), default="full-first")
    args = parser.parse_args()
    import tiktoken
    profile = load(args.profile)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    result = {"schema": 1, "measured_at": datetime.now(timezone.utc).isoformat(), "provider": args.provider,
              "requested_model": args.requested_model, "effort": args.effort, "cli_version": args.cli_version,
              "profile_sha256": hashlib.sha256(canonical(profile).encode()).hexdigest(),
              "runtime_sha256": hashlib.sha256(b"".join(path.name.encode() + b"\0" + path.read_bytes()
                  for path in sorted((ROOT / "skills/herdr-orchestrate/scripts").glob("*.py")))).hexdigest(),
              "prompt": PROMPT, "tokenizer": {"library": "tiktoken", "version": importlib.metadata.version("tiktoken"), "encoding": "o200k_base"},
              "limitations": ["One paired retrieval probe per provider; not a statistical or end-to-end task comparison.",
                              "Order and provider cache state can affect usage. Private homes do not imply cold provider caches.",
                              "Requested model/effort and CLI version are invocation metadata; observed model IDs are reported separately.",
                              "Provider-reported cost is not a verified invoice. Gateway token counts are separate from model input usage."],
              "variants": []}
    for mode in (("full", "auto") if args.order == "full-first" else ("auto", "full")):
        result["variants"].append(run_variant(args.provider, profile, mode, args.output, tiktoken.get_encoding("o200k_base")))
        (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result["variants"][-1]), flush=True)
    return 0 if all(item["complete_correct_retrieval"] for item in result["variants"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
