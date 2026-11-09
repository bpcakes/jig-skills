#!/usr/bin/env python3
"""Compare complete finding retrieval through full and automatic task views.

Development benchmark, not a provider-billing or end-to-end task-success claim.
Requires tiktoken; all state and socket traffic use disposable local fixtures.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from test_channel import ChannelFixture, channel, Engine
from state import canonical


class Fixture(ChannelFixture, unittest.TestCase):
    pass


def run_case(encoding, count, unresolved_count):
    fixture = Fixture()
    fixture.setUp()
    try:
        fixture.socket_server()
        token = channel.issue(fixture.run, "driver-A")
        findings = [{"id": "F" + str(index), "status": "resolved", "text": "Historical finding with evidence. " * 24}
                    for index in range(count)]
        for index in range(count - unresolved_count, count):
            findings[index].update(status="open", text="Unresolved requirement " + str(index) + ": preserve the original operation ID.")
        state = Engine.read(fixture.run)
        Engine.apply(fixture.run, {"op": "observe", "task_id": "A", "action_id": "findings",
                                   "expected_policy": state["policy_version"],
                                   "expected_task": state["tasks"]["A"]["version"],
                                   "fields": {"findings": findings}, "evidence": fixture.proof})
        expected = [item for item in findings if item["status"] == "open"]
        variants = {}
        for mode in ("full", "auto"):
            transcript = []
            started = time.perf_counter()

            def call(**request):
                response = fixture.call(token, **request)
                if "error" in response:
                    raise RuntimeError(response)
                transcript.extend((request, response))
                return response

            view = call(op="query", task_id="A", mode=mode)
            if view.get("mode") != "compact":
                actual = [item for item in view["task"]["findings"] if item["status"] == "open"]
            else:
                summary = view["blocking_summary"]
                indices = summary["unresolved_finding_indices"]

                def detail(path, **selection):
                    chunks, offset = [], 0
                    while True:
                        result = call(**view["detail_request"], path=path, offset=offset, **selection)
                        chunks.append(result["content"])
                        if result["complete"]:
                            return json.loads("".join(chunks))
                        offset = result["next_offset"]

                if len(indices) == summary["unresolved_findings"]:
                    actual = [detail(["task", "findings", index]) for index in indices]
                else:
                    actual = [item["finding"] for item in detail(["task", "findings"], select="unresolved_findings")]
            variants[mode] = {"payload_tokens": sum(len(encoding.encode(canonical(item), disallowed_special=())) for item in transcript),
                              "serialized_bytes": sum(len(canonical(item).encode()) for item in transcript),
                              "requests": len(transcript) // 2, "wall_seconds": time.perf_counter() - started,
                              "complete_correct_retrieval": actual == expected,
                              "selected_view": view.get("mode", "full"),
                              "transcript_sha256": hashlib.sha256(canonical(transcript).encode()).hexdigest()}
        return {"findings": count, "unresolved": unresolved_count, "variants": variants,
                "payload_token_reduction_fraction": 1 - variants["auto"]["payload_tokens"] / variants["full"]["payload_tokens"]}
    finally:
        fixture.doCleanups()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--encoding", default="o200k_base")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        import tiktoken
    except ImportError:
        parser.error("Install tiktoken in a development virtualenv; the runtime itself does not require it")
    encoding = tiktoken.get_encoding(args.encoding)
    result = {"schema": 1, "measured_at": datetime.now(timezone.utc).isoformat(),
              "runtime_sha256": hashlib.sha256(b"".join(
                  path.name.encode() + b"\0" + path.read_bytes()
                  for path in sorted((ROOT / "skills/herdr-orchestrate/scripts").glob("*.py")))).hexdigest(),
              "python": sys.version,
              "scope": "deterministic finding retrieval through the real gateway, including follow-up reads",
              "tokenizer": {"library": "tiktoken", "version": importlib.metadata.version("tiktoken"), "encoding": encoding.name},
              "provider_model": None, "provider_usage": None,
              "limitations": ["Payload counts exclude model context, tool schemas, hidden reasoning and provider billing.",
                              "The retrieval policy is deterministic; model decision quality and end-to-end task success are not measured.",
                              "Paths and session/snapshot IDs vary between runs; timings are single local samples, not tail-latency estimates."],
              "cases": [run_case(encoding, count, unresolved) for count, unresolved in ((0, 0), (16, 1), (128, 1), (128, 32))]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "cases": result["cases"]}, indent=2))
    return 0 if all(variant["complete_correct_retrieval"] for case in result["cases"] for variant in case["variants"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
