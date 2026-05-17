#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"; find "$plugin_root" -type d -name __pycache__ -prune -exec rm -rf {} +' EXIT

network_script="$plugin_root/skills/network-payload-zero-knowledge-test/scripts/zknet_scan.py"
network_fixtures="$plugin_root/skills/network-payload-zero-knowledge-test/fixtures"
crypto_script="$plugin_root/skills/crypto-implementation-static-review/scripts/crypto_static_scan.py"
crypto_fixtures="$plugin_root/skills/crypto-implementation-static-review/fixtures"
vdrm_script="$plugin_root/skills/vulnerability-disclosure-and-retest-manager/scripts/vdrm_register.py"
vdrm_fixtures="$plugin_root/skills/vulnerability-disclosure-and-retest-manager/fixtures"

PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" generate-sentinels \
  --seed fixture-seed \
  --run-id zknet-fixture \
  --output "$tmp_dir/generated-sentinels.json"

python3 - "$tmp_dir/generated-sentinels.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

assert data["metadata"]["seeded"] is True, data["metadata"]
assert data["metadata"]["run_id"] == "zknet-fixture", data["metadata"]
assert len(data["sentinels"]) == 6, data["sentinels"]
assert all(item["value"].startswith("ZKNET::zknet-fixture::") for item in data["sentinels"]), data["sentinels"]
PY

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$network_fixtures/third-party-http-leak.har" \
  --sentinels "$network_fixtures/sentinels.json" \
  --first-party app.example \
  --output "$tmp_dir/zknet.json"
network_status=$?
set -e
test "$network_status" -eq 1

python3 - "$tmp_dir/zknet.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

finding = data["findings"][0]
assert finding["classification"] == "third_party_unencrypted_transport", finding
assert "third_party_network_payload" in finding["classification_tags"], finding
assert "unencrypted_transport" in finding["classification_tags"], finding
assert data["summary"]["configuration_warnings"] == [], data["summary"]
PY

python3 - "$tmp_dir/sensitive-header.har" <<'PY'
import json
import sys

sentinel = "ZKNET::DO-NOT-USE::FIXTURE::PLAINTEXT_CONTENT::HeaderSentinel123"
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(
        {
            "log": {
                "entries": [
                    {
                        "request": {
                            "method": "GET",
                            "url": "https://app.example/api",
                            "headers": [
                                {
                                    "name": "Authorization",
                                    "value": f"Bearer SECRET-BEFORE {sentinel} SECRET-AFTER",
                                }
                            ],
                            "cookies": [],
                            "queryString": [],
                        },
                        "response": {"status": 200, "headers": [], "cookies": [], "content": {}},
                    }
                ]
            }
        },
        handle,
    )
PY

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$tmp_dir/sensitive-header.har" \
  --sentinel "ZKNET::DO-NOT-USE::FIXTURE::PLAINTEXT_CONTENT::HeaderSentinel123" \
  --first-party app.example \
  --output "$tmp_dir/zknet-sensitive-header.json"
sensitive_header_status=$?
set -e
test "$sensitive_header_status" -eq 1

python3 - "$tmp_dir/zknet-sensitive-header.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

excerpt = data["findings"][0]["evidence"][0]["excerpt"]
assert "redacted-sensitive-header" in excerpt, excerpt
assert "SECRET-BEFORE" not in excerpt, excerpt
assert "SECRET-AFTER" not in excerpt, excerpt
assert "HeaderSentinel123" not in excerpt, excerpt
PY

PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$network_fixtures/third-party-http-leak.har" \
  --sentinels "$network_fixtures/sentinels.json" \
  --output "$tmp_dir/zknet-no-first-party.json" >/dev/null || true

python3 - "$tmp_dir/zknet-no-first-party.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

warnings = data["summary"]["configuration_warnings"]
assert warnings and "No --first-party" in warnings[0], warnings
PY

python3 - "$tmp_dir/control-sentinel.json" "$tmp_dir/control.har" <<'PY'
import json
import sys

sentinel = "ZKNET::DO-NOT-USE::FIXTURE::LOW_SENSITIVITY_CONTROL::ControlSentinel123"
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump({"sentinels": [{"id": "control-001", "value": sentinel, "category": "low_sensitivity_control"}]}, handle)

with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(
        {
            "log": {
                "entries": [
                    {
                        "request": {
                            "method": "POST",
                            "url": "https://app.example/sync",
                            "headers": [],
                            "cookies": [],
                            "queryString": [],
                            "postData": {"text": sentinel, "params": []},
                        },
                        "response": {"status": 200, "headers": [], "cookies": [], "content": {}},
                    }
                ]
            }
        },
        handle,
    )
PY

PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$tmp_dir/control.har" \
  --sentinels "$tmp_dir/control-sentinel.json" \
  --first-party app.example \
  --output "$tmp_dir/zknet-control.json"

python3 - "$tmp_dir/zknet-control.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

assert data["summary"]["matches"] == 1, data["summary"]
assert data["summary"]["control_matches"] == 1, data["summary"]
assert data["summary"]["findings"] == 0, data["summary"]
assert data["findings"] == [], data["findings"]
PY

body_context_sentinel="ZKNET::DO-NOT-USE::FIXTURE::PLAINTEXT_CONTENT::BodyContextSentinel123"
python3 - "$tmp_dir/body-context.har" "$body_context_sentinel" <<'PY'
import json
import sys

har_path = sys.argv[1]
sentinel = sys.argv[2]
with open(har_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "log": {
                "entries": [
                    {
                        "request": {
                            "method": "POST",
                            "url": "https://app.example/login",
                            "headers": [],
                            "cookies": [],
                            "queryString": [],
                            "postData": {
                                "text": f"api_key=SECRETSECRETSECRETSECRETSECRETSECRET {sentinel} token=AFTERSECRETSECRETSECRETSECRET"
                            },
                        },
                        "response": {"status": 200, "headers": [], "cookies": [], "content": {}},
                    }
                ]
            }
        },
        handle,
    )
PY

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$tmp_dir/body-context.har" \
  --sentinel "$body_context_sentinel" \
  --first-party app.example \
  --output "$tmp_dir/zknet-body-context.json"
body_context_status=$?
set -e
test "$body_context_status" -eq 1

python3 - "$tmp_dir/zknet-body-context.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

finding = data["findings"][0]
excerpt = finding["evidence"][0]["excerpt"]
assert finding["classification"] == "outbound_plaintext_to_service", finding
assert "telemetry_payload" not in finding["classification_tags"], finding
assert "SECRETSECRET" not in excerpt, excerpt
assert "AFTERSECRET" not in excerpt, excerpt
assert "<redacted" in excerpt, excerpt
PY

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$network_fixtures/third-party-http-leak.har" \
  --sentinel "" \
  --output "$tmp_dir/zknet-empty-sentinel.json" >"$tmp_dir/empty-sentinel.stdout" 2>"$tmp_dir/empty-sentinel.stderr"
empty_sentinel_status=$?
set -e
test "$empty_sentinel_status" -ne 0
grep -q "must be non-empty" "$tmp_dir/empty-sentinel.stderr"

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$network_fixtures/third-party-http-leak.har" \
  --sentinel "short" \
  --output "$tmp_dir/zknet-short-sentinel.json" >"$tmp_dir/short-sentinel.stdout" 2>"$tmp_dir/short-sentinel.stderr"
short_sentinel_status=$?
set -e
test "$short_sentinel_status" -ne 0
grep -q "at least 16 characters" "$tmp_dir/short-sentinel.stderr"

python3 - "$network_script" <<'PY'
import base64
import gzip
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("zknet_scan", sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)

assert not module.is_plausible_text("\ufffd" * 100)
payload = gzip.compress(b"A" * 1000)
encoded = base64.b64encode(payload).decode("ascii")
assert module.decode_base64_to_text(encoded, max_output_bytes=100) is None
assert module.decode_base64_to_text(encoded, max_output_bytes=2000) == "A" * 1000
deep = "leaf"
for _ in range(1200):
    deep = [deep]
assert next(module.json_string_values(deep, "$"))[1] == "leaf"
sentinel = module.Sentinel(id="literal-001", value="ZKNET::LONG::SentinelValue123")
candidate = module.Candidate(
    artifact="fixture.har",
    entry_index=0,
    direction="request",
    surface="request_body",
    location="entries[0].request.postData.text",
    value=sentinel.value,
    method="POST",
    url="https://app.example/sync",
)
raw_match = module.build_match(candidate, module.DecodedValue(sentinel.value, "raw"), sentinel, 0, ["app.example"])
decoded_match = module.build_match(candidate, module.DecodedValue(sentinel.value, "raw -> base64"), sentinel, 0, ["app.example"])
assert raw_match["confidence"] == "high", raw_match
assert decoded_match["confidence"] == "medium", decoded_match
PY

large_decoded_sentinel="ZKNET::DO-NOT-USE::FIXTURE::PLAINTEXT_CONTENT::CompressedSentinel123"
python3 - "$tmp_dir/encoded-large.har" "$large_decoded_sentinel" <<'PY'
import base64
import gzip
import json
import sys

har_path = sys.argv[1]
sentinel = sys.argv[2]
payload = sentinel + ("A" * 1000)
encoded = base64.b64encode(gzip.compress(payload.encode("utf-8"))).decode("ascii")
assert len(encoded.encode("utf-8")) < 200, len(encoded)

with open(har_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "log": {
                "entries": [
                    {
                        "request": {
                            "method": "POST",
                            "url": "https://app.example/sync",
                            "headers": [],
                            "cookies": [],
                            "queryString": [],
                            "postData": {"text": encoded, "params": []},
                        },
                        "response": {"status": 200, "headers": [], "cookies": [], "content": {}},
                    }
                ]
            }
        },
        handle,
    )
PY

PYTHONDONTWRITEBYTECODE=1 python3 "$network_script" scan-har \
  "$tmp_dir/encoded-large.har" \
  --sentinel "$large_decoded_sentinel" \
  --first-party app.example \
  --max-field-bytes 200 \
  --output "$tmp_dir/zknet-large-decoded.json"

python3 - "$tmp_dir/zknet-large-decoded.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

assert data["summary"]["matches"] == 0, data["summary"]
assert data["summary"]["findings"] == 0, data["summary"]
assert data["summary"]["max_field_bytes"] == 200, data["summary"]
assert data["findings"] == [], data["findings"]
PY

PYTHONDONTWRITEBYTECODE=1 python3 "$crypto_script" \
  --root "$crypto_fixtures" \
  --format json > "$tmp_dir/crypto.json"

python3 - "$tmp_dir/crypto.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    results = json.load(handle)

categories = {item["category"] for item in results}
assert "hardcoded_secret_material" in categories, categories
assert "static_iv_or_salt_literal" in categories, categories
assert "weak_randomness" in categories, categories
assert "crypto_envelope_field" in categories, categories
PY

mkdir -p "$tmp_dir/crypto-target/tests"
cat > "$tmp_dir/crypto-target/tests/leaky.ts" <<'TS'
const apiKey = "fixture-api-key-abcdefgh";
TS

PYTHONDONTWRITEBYTECODE=1 python3 "$crypto_script" \
  --root "$tmp_dir/crypto-target" \
  --format json > "$tmp_dir/crypto-tests-dir.json"

python3 - "$tmp_dir/crypto-tests-dir.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    results = json.load(handle)

paths = {item["path"] for item in results}
assert "tests/leaky.ts" in paths, paths
test_path_matches = [item for item in results if item["path"] == "tests/leaky.ts"]
assert test_path_matches, results
assert all(item["test_path"] is True for item in test_path_matches), test_path_matches
PY

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" import \
  --input "$vdrm_fixtures/finding.json" \
  --output "$tmp_dir/retest-register.json"

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" import \
  --input "$vdrm_fixtures/finding.json" \
  --output "$tmp_dir/retest-register.json" >"$tmp_dir/import-overwrite.stdout" 2>"$tmp_dir/import-overwrite.stderr"
overwrite_status=$?
set -e
test "$overwrite_status" -ne 0
grep -q -- "--force" "$tmp_dir/import-overwrite.stderr"

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" import \
  --input "$vdrm_fixtures/finding.json" \
  --output "$tmp_dir/retest-register.json" \
  --force

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" status \
  --register "$tmp_dir/retest-register.json" \
  --finding ZK-NET-001 \
  --status fixed \
  --note "Fixture retest completed." \
  --output "$tmp_dir/retest-register-fixed.json"

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" summary \
  --register "$tmp_dir/retest-register-fixed.json" \
  --output "$tmp_dir/final-audit-summary.md"

grep -q "Fixture retest completed" "$tmp_dir/retest-register-fixed.json"
grep -q "Task title sent in plaintext" "$tmp_dir/final-audit-summary.md"

python3 - "$tmp_dir/retest-register-fixed.json" "$tmp_dir/timeline-register.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    register = json.load(handle)

register["disclosure"]["timeline"] = [
    {
        "date": "2026-01-01",
        "event": "Vendor | notified",
        "notes": "Fix | deployed\nFollow-up complete",
    }
]

with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(register, handle)
PY

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" summary \
  --register "$tmp_dir/timeline-register.json" \
  --output "$tmp_dir/timeline-summary.md"

grep -Fq "Vendor \\| notified" "$tmp_dir/timeline-summary.md"
grep -Fq "Fix \\| deployed Follow-up complete" "$tmp_dir/timeline-summary.md"

cat > "$tmp_dir/status-merge-findings.json" <<'JSON'
[
  {
    "id": "MERGE-001",
    "dedupe_key": "status-merge-fixture",
    "title": "Merged lifecycle status fixture",
    "severity": "medium",
    "confidence": "high",
    "status": "fixed",
    "evidence": []
  },
  {
    "id": "MERGE-002",
    "dedupe_key": "status-merge-fixture",
    "title": "Merged lifecycle status fixture",
    "severity": "medium",
    "confidence": "medium",
    "status": "partially_fixed",
    "evidence": []
  }
]
JSON

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" import \
  --input "$tmp_dir/status-merge-findings.json" \
  --output "$tmp_dir/status-merge-register.json"

python3 - "$tmp_dir/status-merge-register.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

finding = data["findings"][0]
assert finding["status"] == "partially_fixed", finding
assert finding["confidence"] == "medium", finding
PY

cat > "$tmp_dir/rerun-inference-findings.json" <<'JSON'
[
  {
    "id": "RERUN-001",
    "title": "Cryptocurrency wallet copy can remain stale after login",
    "surface": "auth",
    "impact": "User can log in and see stale wallet copy.",
    "recommended_fix": "Refresh the UI copy after login.",
    "evidence": []
  },
  {
    "id": "RERUN-002",
    "title": "Network request leaks metadata",
    "surface": "network",
    "impact": "Request payload includes metadata.",
    "recommended_fix": "Remove metadata from the request.",
    "evidence": []
  }
]
JSON

PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" import \
  --input "$tmp_dir/rerun-inference-findings.json" \
  --output "$tmp_dir/rerun-inference-register.json"

python3 - "$tmp_dir/rerun-inference-register.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    findings = {item["id"]: item for item in json.load(handle)["findings"]}

assert "crypto-architecture-review" not in findings["RERUN-001"]["affected_skills_to_rerun"], findings["RERUN-001"]
assert "telemetry-crash-logs-support-leakage-audit" not in findings["RERUN-001"]["affected_skills_to_rerun"], findings["RERUN-001"]
assert "network-payload-zero-knowledge-test" in findings["RERUN-002"]["affected_skills_to_rerun"], findings["RERUN-002"]
PY

cat > "$tmp_dir/ambiguous-register.json" <<'JSON'
{
  "schema_version": "1.0",
  "generated_at": "2026-01-01T00:00:00Z",
  "scope": {},
  "disclosure": {},
  "findings": [
    {"id": "VDRM-001", "source_ids": ["DUP-001"], "status": "open"},
    {"id": "VDRM-002", "source_ids": ["DUP-001"], "status": "open"}
  ]
}
JSON

set +e
PYTHONDONTWRITEBYTECODE=1 python3 "$vdrm_script" status \
  --register "$tmp_dir/ambiguous-register.json" \
  --finding DUP-001 \
  --status fixed \
  --output "$tmp_dir/ambiguous-out.json" >"$tmp_dir/ambiguous.stdout" 2>"$tmp_dir/ambiguous.stderr"
ambiguous_status=$?
set -e
test "$ambiguous_status" -ne 0
grep -q "ambiguous" "$tmp_dir/ambiguous.stderr"

echo "privacy-audit fixture tests passed"
