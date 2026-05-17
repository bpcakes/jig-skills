#!/usr/bin/env python3
"""Sentinel generation and HAR scanning for network zero-knowledge tests."""

from __future__ import annotations

import argparse
import base64
import binascii
import gzip
import hashlib
import html
import io
import json
import random
import re
import secrets
import string
import sys
import urllib.parse
import zlib
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


AUDIT_SKILL = "network-payload-zero-knowledge-test"
DEFAULT_LIMITATIONS = [
    "Absence of sentinel matches only applies to the supplied captures and configured sentinels.",
    "HAR exports may omit bodies, binary content, service-worker traffic, websocket messages, or sensitive headers depending on browser settings.",
    "Encoded matches prove reversible exposure, not necessarily intentional plaintext handling.",
]
SENSITIVE_CATEGORIES = {
    "plaintext_content",
    "encryption_key",
    "recovery_secret",
    "credential",
}
TOKEN_RE = re.compile(r"[A-Za-z0-9_\-+/=]{16,}")
HEX_RE = re.compile(r"\b[0-9A-Fa-f]{16,}\b")
TELEMETRY_HINTS = (
    "analytics",
    "telemetry",
    "sentry",
    "segment",
    "amplitude",
    "mixpanel",
    "datadog",
    "bugsnag",
    "crash",
    "log",
    "logs",
    "metrics",
)
REDACTED_HEADER_NAMES = {"authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"}
MIN_BASE64_DECODE_LENGTH = 16
MIN_SENTINEL_LENGTH = 16
DEFAULT_DECOMPRESS_LIMIT_BYTES = 2_000_000
LONG_TOKEN_VALUE_RE = re.compile(r"\b[A-Za-z0-9._~+/=-]{32,}\b")
SENSITIVE_KEY_VALUE_RE = re.compile(
    r"(?i)\b(api[_-]?key|authorization|bearer|secret|password|passphrase|token)\b"
    r"\s*[:=]\s*['\"]?[^'\"&\s,}]{8,}"
)


@dataclass(frozen=True)
class Sentinel:
    id: str
    value: str
    category: str = "plaintext_content"
    use: str = ""


@dataclass(frozen=True)
class Candidate:
    artifact: str
    entry_index: int
    direction: str
    surface: str
    location: str
    value: str
    method: str
    url: str
    status: int | None = None


@dataclass(frozen=True)
class DecodedValue:
    value: str
    transform: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate sentinels and scan HAR files for network leaks.")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate-sentinels", help="Create a synthetic sentinel manifest.")
    gen.add_argument("--run-id", default=None, help="Run identifier to embed in sentinel values.")
    gen.add_argument("--seed", default=None, help="Deterministic seed for fixtures only.")
    gen.add_argument("--output", required=True, help="Path to write the sentinel manifest JSON.")

    scan = sub.add_parser(
        "scan-har",
        help="Scan HAR files for configured sentinels. Exits 1 when finding candidates are detected.",
    )
    scan.add_argument("har", nargs="+", help="HAR files to scan.")
    scan.add_argument("--sentinels", action="append", default=[], help="Sentinel manifest JSON. May be repeated.")
    scan.add_argument("--sentinel", action="append", default=[], help="Literal sentinel value. May be repeated.")
    scan.add_argument("--first-party", action="append", default=[], help="First-party domain suffix. May be repeated.")
    scan.add_argument("--output", default="-", help="Output JSON path, or '-' for stdout.")
    scan.add_argument("--max-field-bytes", type=int, default=2_000_000, help="Skip string fields larger than this; use 0 for unlimited.")
    scan.add_argument("--max-decode-depth", type=int, default=3, help="Maximum recursive decoding depth.")
    scan.add_argument("--max-decoded-values", type=int, default=20_000, help="Maximum decoded values to inspect per field; use 0 for unlimited.")

    args = parser.parse_args()
    if args.command == "generate-sentinels":
        return generate_sentinels(args)
    if args.command == "scan-har":
        return scan_har(args)
    parser.error("unknown command")
    return 2


def generate_sentinels(args: argparse.Namespace) -> int:
    rng: random.Random | None = random.Random(args.seed) if args.seed is not None else None
    run_id = args.run_id or f"zknet-{token(8, rng).lower()}"
    specs = [
        ("body-001", "plaintext_content", "Encrypted note, message, document, or vault body"),
        ("metadata-001", "sensitive_metadata", "Title, filename, tag, folder, label, or search query"),
        ("key-001", "encryption_key", "Test-only key-like field or wrapped-key flow"),
        ("recovery-001", "recovery_secret", "Test-only recovery phrase, backup code, or escrow flow"),
        ("credential-001", "credential", "Test-only password, passphrase, token, or OTP field"),
        ("control-001", "low_sensitivity_control", "Benign value expected to appear in traffic"),
    ]
    sentinels = [
        {
            "id": sid,
            "value": f"ZKNET::{run_id}::{category.upper()}::{token(18, rng)}",
            "category": category,
            "use": use,
        }
        for sid, category, use in specs
    ]
    manifest = {
        "metadata": {
            "tool": "zknet_scan.py",
            "audit_skill": AUDIT_SKILL,
            "run_id": run_id,
            "seeded": args.seed is not None,
        },
        "sentinels": sentinels,
        "constraints": [
            "Use only in authorized test accounts and approved environments.",
            "Do not commit this manifest if it contains live audit sentinels.",
            "Do not use seeded sentinels for real audits.",
        ],
    }
    write_json(args.output, manifest)
    return 0


def token(length: int, rng: random.Random | None) -> str:
    alphabet = string.ascii_letters + string.digits
    if rng is not None:
        return "".join(rng.choice(alphabet) for _ in range(length))
    return "".join(secrets.choice(alphabet) for _ in range(length))


def scan_har(args: argparse.Namespace) -> int:
    validate_scan_args(args)
    sentinels = load_sentinels(args.sentinels, args.sentinel)
    if not sentinels:
        raise SystemExit("Provide at least one --sentinels file or --sentinel value.")

    configuration_warnings = []
    if not args.first_party:
        configuration_warnings.append(
            "No --first-party domain supplied; third-party classification is disabled for this scan."
        )

    matches: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    scanned_entries = 0
    artifacts = []

    for har_path in args.har:
        artifact = str(Path(har_path))
        artifacts.append(artifact)
        with open(har_path, "r", encoding="utf-8-sig") as f:
            har = json.load(f)
        entries = har.get("log", {}).get("entries", [])
        scanned_entries += len(entries)
        for candidate in iter_candidates(har, artifact):
            if exceeds_byte_limit(candidate.value, args.max_field_bytes):
                skipped.append({"artifact": artifact, "location": candidate.location, "reason": "field exceeds max-field-bytes"})
                continue
            for decoded in decode_values(candidate.value, args.max_decode_depth, args.max_field_bytes, args.max_decoded_values):
                for sentinel in sentinels:
                    pos = decoded.value.find(sentinel.value)
                    if pos == -1:
                        continue
                    matches.append(build_match(candidate, decoded, sentinel, pos, args.first_party))

    matches = dedupe_matches(matches)
    control_matches = [match for match in matches if match["sentinel_category"] == "low_sensitivity_control"]
    findings = build_findings(
        [match for match in matches if match["sentinel_category"] != "low_sensitivity_control"]
    )
    positive_evidence = []
    if not findings:
        positive_evidence.append(
            "No protected finding candidates were emitted for the supplied HAR captures and configured sentinels."
        )
        if control_matches:
            positive_evidence.append(
                "Low-sensitivity control sentinel matches were observed and retained in matches[] for audit calibration."
            )

    result = {
        "summary": {
            "audit_skill": AUDIT_SKILL,
            "artifacts": artifacts,
            "har_files": len(args.har),
            "entries_scanned": scanned_entries,
            "sentinels_scanned": len(sentinels),
            "matches": len(matches),
            "control_matches": len(control_matches),
            "findings": len(findings),
            "skipped_fields": len(skipped),
            "max_field_bytes": args.max_field_bytes,
            "max_decode_depth": args.max_decode_depth,
            "max_decoded_values": args.max_decoded_values,
            "configuration_warnings": configuration_warnings,
            "limitations": DEFAULT_LIMITATIONS,
        },
        "findings": findings,
        "matches": matches,
        "skipped": skipped,
        "positive_evidence": positive_evidence,
    }
    write_json(args.output, result)
    # Exit 1 means "leak candidate detected", not a scanner failure. This makes
    # CI wrappers fail closed when protected sentinels appear in captured traffic.
    return 1 if findings else 0


def validate_scan_args(args: argparse.Namespace) -> None:
    for attr, flag in (
        ("max_field_bytes", "--max-field-bytes"),
        ("max_decode_depth", "--max-decode-depth"),
        ("max_decoded_values", "--max-decoded-values"),
    ):
        if getattr(args, attr) < 0:
            raise SystemExit(f"{flag} must be greater than or equal to 0.")


def load_sentinels(paths: list[str], literals: list[str]) -> list[Sentinel]:
    sentinels: list[Sentinel] = []
    for index, literal in enumerate(literals, start=1):
        sentinels.append(Sentinel(id=f"literal-{index:03d}", value=validated_sentinel_value(literal, f"--sentinel #{index}")))
    for path in paths:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        raw_items = data.get("sentinels", data) if isinstance(data, dict) else data
        if not isinstance(raw_items, list):
            raise SystemExit(f"Unsupported sentinel manifest shape: {path}")
        for index, item in enumerate(raw_items, start=1):
            if isinstance(item, str):
                sentinels.append(Sentinel(id=f"{Path(path).stem}-{index:03d}", value=validated_sentinel_value(item, f"{path} entry {index}")))
            elif isinstance(item, dict) and item.get("value"):
                sentinels.append(
                    Sentinel(
                        id=str(item.get("id") or f"{Path(path).stem}-{index:03d}"),
                        value=validated_sentinel_value(item["value"], f"{path} entry {index}"),
                        category=str(item.get("category") or "plaintext_content"),
                        use=str(item.get("use") or ""),
                    )
                )
            else:
                raise SystemExit(f"Invalid sentinel entry {index} in {path}")
    return sentinels


def validated_sentinel_value(value: Any, source: str) -> str:
    text = str(value)
    if not text.strip():
        raise SystemExit(f"Sentinel value from {source} must be non-empty.")
    if len(text) < MIN_SENTINEL_LENGTH:
        raise SystemExit(f"Sentinel value from {source} must be at least {MIN_SENTINEL_LENGTH} characters.")
    return text


def dedupe_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[tuple[Any, ...], dict[str, Any]] = {}
    for match in matches:
        key = (
            match["artifact"],
            match["entry_index"],
            match["direction"],
            match["surface"],
            match["location"],
            match["sentinel_id"],
            match["sentinel_category"],
        )
        existing = deduped.get(key)
        if existing is None:
            merged = dict(match)
            merged["decode_transforms"] = [match["decode_transform"]]
            deduped[key] = merged
            continue
        transforms = existing.setdefault("decode_transforms", [existing["decode_transform"]])
        if match["decode_transform"] not in transforms:
            transforms.append(match["decode_transform"])
        existing["decode_transform"] = ", ".join(transforms)
        if len(match.get("excerpt", "")) > len(existing.get("excerpt", "")):
            existing["excerpt"] = match["excerpt"]
    return list(deduped.values())


def iter_candidates(har: dict[str, Any], artifact: str) -> Iterable[Candidate]:
    for i, entry in enumerate(har.get("log", {}).get("entries", [])):
        req = entry.get("request", {}) or {}
        res = entry.get("response", {}) or {}
        method = str(req.get("method") or "")
        url = str(req.get("url") or "")
        status = res.get("status") if isinstance(res.get("status"), int) else None

        yield Candidate(artifact, i, "request", "request_url", f"entries[{i}].request.url", url, method, url, status)
        for j, item in enumerate(req.get("queryString") or []):
            yield from name_value_candidates(artifact, i, "request", "request_query", f"entries[{i}].request.queryString[{j}]", item, method, url, status)
        for j, item in enumerate(req.get("headers") or []):
            surface = "request_header_sensitive" if str(item.get("name", "")).lower() in REDACTED_HEADER_NAMES else "request_header"
            yield from name_value_candidates(artifact, i, "request", surface, f"entries[{i}].request.headers[{j}]", item, method, url, status)
        for j, item in enumerate(req.get("cookies") or []):
            yield from name_value_candidates(artifact, i, "request", "request_cookie", f"entries[{i}].request.cookies[{j}]", item, method, url, status)

        post = req.get("postData") or {}
        if isinstance(post.get("text"), str):
            yield Candidate(artifact, i, "request", "request_body", f"entries[{i}].request.postData.text", post["text"], method, url, status)
        for j, item in enumerate(post.get("params") or []):
            yield from name_value_candidates(artifact, i, "request", "request_body_param", f"entries[{i}].request.postData.params[{j}]", item, method, url, status)

        for j, item in enumerate(res.get("headers") or []):
            surface = "response_header_sensitive" if str(item.get("name", "")).lower() in REDACTED_HEADER_NAMES else "response_header"
            yield from name_value_candidates(artifact, i, "response", surface, f"entries[{i}].response.headers[{j}]", item, method, url, status)
        for j, item in enumerate(res.get("cookies") or []):
            yield from name_value_candidates(artifact, i, "response", "response_cookie", f"entries[{i}].response.cookies[{j}]", item, method, url, status)

        content = res.get("content") or {}
        text = content.get("text")
        if isinstance(text, str):
            yield Candidate(artifact, i, "response", "response_body", f"entries[{i}].response.content.text", text, method, url, status)


def name_value_candidates(
    artifact: str,
    entry_index: int,
    direction: str,
    surface: str,
    location: str,
    item: dict[str, Any],
    method: str,
    url: str,
    status: int | None,
) -> Iterable[Candidate]:
    # Names are scanned too because leaked sentinels can appear in dynamic keys,
    # multipart filenames, or malformed headers, not only in values.
    for key in ("name", "value", "fileName"):
        value = item.get(key)
        if isinstance(value, str):
            yield Candidate(artifact, entry_index, direction, surface, f"{location}.{key}", value, method, url, status)


def decode_values(value: str, max_depth: int, max_value_bytes: int, max_values: int) -> list[DecodedValue]:
    out: list[DecodedValue] = []
    queue: deque[tuple[DecodedValue, int]] = deque([(DecodedValue(value, "raw"), 0)])
    seen = {value}
    scheduled_values = 1
    while queue:
        if max_values and len(out) >= max_values:
            break
        item, depth = queue.popleft()
        out.append(item)
        if depth == max_depth:
            continue
        for transform, decoded in one_step_decodes(item.value, max_value_bytes):
            if not decoded or decoded in seen:
                continue
            if exceeds_byte_limit(decoded, max_value_bytes):
                continue
            if max_values and scheduled_values >= max_values:
                break
            seen.add(decoded)
            scheduled_values += 1
            queue.append((DecodedValue(decoded, f"{item.transform} -> {transform}"), depth + 1))
    return out


def exceeds_byte_limit(value: str, max_bytes: int) -> bool:
    return max_bytes > 0 and len(value.encode("utf-8", errors="ignore")) > max_bytes


def one_step_decodes(value: str, max_output_bytes: int = DEFAULT_DECOMPRESS_LIMIT_BYTES) -> Iterable[tuple[str, str]]:
    if "%" in value or "+" in value:
        unquoted = urllib.parse.unquote(value)
        if unquoted != value:
            yield "url-percent", unquoted
        form_unquoted = urllib.parse.unquote_plus(value)
        if form_unquoted != value and form_unquoted != unquoted:
            yield "form-url-encoded", form_unquoted

    unescaped = html.unescape(value)
    if unescaped != value:
        yield "html-entity", unescaped

    stripped = value.strip()
    # Sentinel-bearing JSON payloads should surface as strings, objects, or arrays;
    # scalar JSON values are intentionally ignored to avoid noisy primitive parsing.
    if stripped.startswith(("\"", "{", "[")):
        try:
            parsed = json.loads(stripped)
            yield from json_string_values(parsed, "$")
        except json.JSONDecodeError:
            pass

    if "=" in value and "&" in value:
        parsed_qs = urllib.parse.parse_qs(value, keep_blank_values=True)
        for key, vals in parsed_qs.items():
            for idx, val in enumerate(vals):
                yield f"form-field:{key}[{idx}]", val

    decoded = decode_base64_to_text(stripped, max_output_bytes=max_output_bytes)
    if decoded:
        yield "base64", decoded
    decoded_url = decode_base64_to_text(stripped, urlsafe=True, max_output_bytes=max_output_bytes)
    if decoded_url and decoded_url != decoded:
        yield "base64url", decoded_url

    if "." in stripped:
        parts = stripped.split(".")
        if len(parts) >= 2:
            # Header and payload are the JWT segments that can contain plaintext metadata.
            for idx, part in enumerate(parts[:2]):
                decoded_part = decode_base64_to_text(part, urlsafe=True, max_output_bytes=max_output_bytes)
                if decoded_part:
                    yield f"jwt-segment:{idx}", decoded_part

    if len(stripped) % 2 == 0 and HEX_RE.fullmatch(stripped):
        try:
            decoded_hex = bytes.fromhex(stripped).decode("utf-8", errors="replace")
            if is_plausible_text(decoded_hex):
                yield "hex", decoded_hex
        except ValueError:
            pass

    for token in TOKEN_RE.findall(value):
        decoded_token = decode_base64_to_text(token, max_output_bytes=max_output_bytes)
        if decoded_token:
            yield "token-base64", decoded_token
        decoded_url_token = decode_base64_to_text(token, urlsafe=True, max_output_bytes=max_output_bytes)
        if decoded_url_token and decoded_url_token != decoded_token:
            yield "token-base64url", decoded_url_token

    for token in HEX_RE.findall(value):
        if len(token) % 2 == 0:
            try:
                decoded_token = bytes.fromhex(token).decode("utf-8", errors="replace")
                if is_plausible_text(decoded_token):
                    yield "token-hex", decoded_token
            except ValueError:
                pass


def json_string_values(value: Any, path: str) -> Iterable[tuple[str, str]]:
    stack = [(value, path)]
    while stack:
        current, current_path = stack.pop()
        if isinstance(current, str):
            yield f"json:{current_path}", current
        elif isinstance(current, list):
            for index in range(len(current) - 1, -1, -1):
                stack.append((current[index], f"{current_path}[{index}]"))
        elif isinstance(current, dict):
            for key, item in reversed(list(current.items())):
                safe_key = str(key).replace("~", "~0").replace("/", "~1")
                stack.append((item, f"{current_path}/{safe_key}"))


def decode_base64_to_text(value: str, urlsafe: bool = False, max_output_bytes: int = DEFAULT_DECOMPRESS_LIMIT_BYTES) -> str | None:
    compact = "".join(value.split())
    if len(compact) < MIN_BASE64_DECODE_LENGTH:
        return None
    alphabet_re = r"^[A-Za-z0-9_\-]+={0,2}$" if urlsafe else r"^[A-Za-z0-9+/]+={0,2}$"
    if not re.fullmatch(alphabet_re, compact):
        return None
    padded = compact + ("=" * (-len(compact) % 4))
    try:
        raw = base64.urlsafe_b64decode(padded) if urlsafe else base64.b64decode(padded, validate=True)
    except (binascii.Error, ValueError):
        return None
    output_limit = max_output_bytes if max_output_bytes > 0 else DEFAULT_DECOMPRESS_LIMIT_BYTES
    for transform in ("gzip", "zlib", "raw"):
        try:
            data = decode_compressed_bytes(raw, transform, output_limit)
            if data is None:
                continue
            text = data.decode("utf-8", errors="replace")
        except Exception:
            continue
        if is_plausible_text(text):
            return text
    return None


def decode_compressed_bytes(raw: bytes, transform: str, output_limit: int) -> bytes | None:
    if transform == "raw":
        return raw if len(raw) <= output_limit else None
    if transform == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as handle:
            data = handle.read(output_limit + 1)
        return data if len(data) <= output_limit else None
    if transform == "zlib":
        decompressor = zlib.decompressobj()
        data = decompressor.decompress(raw, output_limit + 1)
        if len(data) > output_limit or decompressor.unconsumed_tail:
            return None
        data += decompressor.flush(output_limit + 1 - len(data))
        return data if len(data) <= output_limit else None
    raise ValueError(f"unknown transform: {transform}")


def is_plausible_text(value: str) -> bool:
    if not value:
        return False
    printable = sum(1 for ch in value if ch != "\ufffd" and (ch.isprintable() or ch in "\r\n\t"))
    return printable / max(len(value), 1) > 0.85


def build_match(candidate: Candidate, decoded: DecodedValue, sentinel: Sentinel, pos: int, first_party: list[str]) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(candidate.url)
    host = parsed.hostname or ""
    path = parsed.path or "/"
    classification, severity, classification_tags = classify(candidate, sentinel, first_party)
    confidence = "high" if decoded.transform == "raw" else "medium"
    return {
        "sentinel_id": sentinel.id,
        "sentinel_category": sentinel.category,
        "classification": classification,
        "classification_tags": classification_tags,
        "severity": severity,
        "confidence": confidence,
        "artifact": candidate.artifact,
        "entry_index": candidate.entry_index,
        "direction": candidate.direction,
        "surface": candidate.surface,
        "location": candidate.location,
        "method": candidate.method,
        "scheme": parsed.scheme,
        "host": host,
        "path": path,
        "status": candidate.status,
        "decode_transform": decoded.transform,
        "excerpt": redact_excerpt(candidate, decoded.value, sentinel.value, sentinel.id, pos),
        "fingerprint": hashlib.sha256(f"{candidate.artifact}:{candidate.entry_index}:{candidate.location}:{sentinel.id}:{decoded.transform}".encode()).hexdigest()[:16],
    }


def classify(candidate: Candidate, sentinel: Sentinel, first_party: list[str]) -> tuple[str, str, list[str]]:
    parsed = urllib.parse.urlparse(candidate.url)
    host = parsed.hostname or ""
    third_party = bool(first_party) and not any(host == d or host.endswith(f".{d}") for d in first_party)
    sensitive = sentinel.category in SENSITIVE_CATEGORIES

    if sentinel.category == "low_sensitivity_control":
        return "expected_control_value", "low", ["expected_control_value"]
    if parsed.scheme == "http" and third_party:
        severity = "high" if sensitive else "medium"
        return "third_party_unencrypted_transport", severity, ["third_party_network_payload", "unencrypted_transport"]
    if parsed.scheme == "http" and sensitive:
        return "unencrypted_transport", "high", ["unencrypted_transport"]
    if third_party:
        return "third_party_network_payload", "high" if sensitive else "medium", ["third_party_network_payload"]
    if candidate.surface in {"request_url", "request_query", "request_header", "request_header_sensitive", "request_cookie", "response_header", "response_header_sensitive", "response_cookie"}:
        return "url_or_header_exposure", "high" if sensitive else "medium", ["url_or_header_exposure"]
    if is_telemetry_endpoint(host, parsed.path):
        classification = "third_party_network_payload" if third_party else "telemetry_payload"
        tags = ["third_party_network_payload"] if third_party else ["telemetry_payload"]
        return classification, "high" if sensitive else "medium", tags
    if candidate.direction == "request":
        return "outbound_plaintext_to_service", "high" if sensitive else "medium", ["outbound_plaintext_to_service"]
    if candidate.direction == "response":
        return "inbound_plaintext_from_service", "high" if sensitive else "medium", ["inbound_plaintext_from_service"]
    return "encoded_plaintext", "high" if sensitive else "medium", ["encoded_plaintext"]


def redact_excerpt(candidate: Candidate, value: str, sentinel: str, sentinel_id: str, pos: int) -> str:
    if candidate.surface in {"request_header_sensitive", "response_header_sensitive"}:
        return f"<redacted-sensitive-header; sentinel={sentinel_id}; offset={pos}; length={len(sentinel)}>"
    start = max(0, pos - 80)
    end = min(len(value), pos + len(sentinel) + 80)
    excerpt = value[start:end].replace(sentinel, f"<SENTINEL:{sentinel_id}>")
    # Keep sentinel replacement before scrubbing so the test token remains identifiable.
    return scrub_excerpt(excerpt).replace("\r", "\\r").replace("\n", "\\n")


def is_telemetry_endpoint(host: str, path: str) -> bool:
    tokens = {token for token in re.split(r"[^a-z0-9]+", f"{host} {path}".lower()) if token}
    return bool(tokens & set(TELEMETRY_HINTS))


def scrub_excerpt(excerpt: str) -> str:
    scrubbed = SENSITIVE_KEY_VALUE_RE.sub(lambda match: f"{match.group(1)}=<redacted>", excerpt)
    return LONG_TOKEN_VALUE_RE.sub("<redacted-token>", scrubbed)


def build_findings(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings = []
    for idx, match in enumerate(matches, start=1):
        title = f"Sentinel leaked via {match['surface']} ({match['classification']})"
        findings.append(
            {
                "id": f"ZK-NET-{idx:03d}",
                "title": title,
                "severity": match["severity"],
                "confidence": match["confidence"],
                "audit_skill": AUDIT_SKILL,
                "surface": match["surface"],
                "affected_claims": [],
                "classification": match["classification"],
                "classification_tags": match.get("classification_tags", [match["classification"]]),
                "evidence": [
                    {
                        "type": "har-match",
                        "file": match["artifact"],
                        "location": match["location"],
                        "description": (
                            f"{match['method']} {match['scheme']}://{match['host']}{match['path']} "
                            f"entry {match['entry_index']} matched {match['sentinel_category']} sentinel "
                            f"after transform {match['decode_transform']}."
                        ),
                        "excerpt": match["excerpt"],
                        "sentinel_id": match["sentinel_id"],
                        "fingerprint": match["fingerprint"],
                    }
                ],
                "reproduction_steps": [
                    "Use the same sentinel manifest in an authorized test account.",
                    "Repeat the audited user flow while capturing a HAR with the required request/response bodies.",
                    "Run zknet_scan.py scan-har against the capture and confirm the same location and transform.",
                ],
                "impact": "A protected test value was observable in network traffic, which may conflict with zero-knowledge, E2EE, or metadata-privacy claims depending on the affected flow.",
                "root_cause_hypothesis": "The client or server appears to serialize the protected value into a network-visible field before applying an effective end-to-end protection boundary.",
                "recommended_fix": "Keep protected plaintext and key material client-side; encrypt before network serialization; remove sensitive metadata from telemetry and third-party payloads; enforce response schemas that return only required fields.",
                "retest_steps": [
                    "Generate fresh sentinels.",
                    "Repeat the same flow with equivalent HAR capture settings.",
                    "Verify no protected sentinel appears in raw or decoded request/response fields.",
                ],
                "limitations": DEFAULT_LIMITATIONS,
            }
        )
    return findings


def write_json(path: str, data: Any) -> None:
    text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    if path == "-":
        sys.stdout.write(text)
    else:
        Path(path).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
