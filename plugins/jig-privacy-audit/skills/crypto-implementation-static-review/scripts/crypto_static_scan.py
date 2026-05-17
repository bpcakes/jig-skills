#!/usr/bin/env python3
"""Triage scanner for crypto implementation static reviews.

This script is intentionally heuristic. It finds candidate locations for manual
review and avoids claiming vulnerabilities from pattern matches alone.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_EXCLUDES = {
    ".git",
    ".hg",
    ".svn",
    ".next",
    ".nuxt",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
}

TEXT_EXTENSIONS = {
    ".c",
    ".cc",
    ".cs",
    ".cpp",
    ".go",
    ".h",
    ".hpp",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".m",
    ".mm",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".scala",
    ".swift",
    ".ts",
    ".tsx",
    ".vue",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".xml",
    ".proto",
    ".sql",
}


@dataclass(frozen=True)
class Pattern:
    category: str
    severity_hint: str
    regex: re.Pattern[str]
    note: str


PATTERNS = [
    Pattern("crypto_api", "review", re.compile(r"\b(createCipheriv|createDecipheriv|Cipher\.getInstance|GCMParameterSpec|IvParameterSpec|SecretKeySpec|AESGCM|ChaCha20Poly1305|NewGCM|NewGCMWithNonceSize|Seal\(|Open\(|subtle\.(encrypt|decrypt)|CryptoJS|libsodium|tweetnacl)\b"), "crypto API or wrapper"),
    Pattern("weak_mode_or_algorithm", "high", re.compile(r"\b(DES|3DES|RC2|RC4|ECB|NoPadding|PKCS1Padding|MD5|SHA1|SHA-1)\b|aes-[0-9]+-ecb"), "weak/legacy primitive, mode, padding, or digest candidate"),
    Pattern("unauthenticated_mode", "medium", re.compile(r"\bAES[-_/ ]?(CBC|CTR|CFB|OFB)\b|aes-[0-9]+-(cbc|ctr|cfb|ofb)|Cipher\.getInstance\([^)]*\b(CBC|CTR|CFB|OFB)\b", re.IGNORECASE), "mode requiring separate authentication review"),
    Pattern("randomness", "review", re.compile(r"\b(SecureRandom|crypto\.randomBytes|crypto\.randomUUID|getRandomValues|crypto/rand|rand\.Reader|secrets\.|os\.urandom|SecRandomCopyBytes|RandomNumberGenerator|arc4random(?:_uniform)?)\b"), "CSPRNG or randomness candidate"),
    Pattern("weak_randomness", "high", re.compile(r"\b(Math\.random|random\.random|java\.util\.Random|ThreadLocalRandom|SplittableRandom|math/rand|srand|rand\()\b"), "weak or predictable randomness candidate"),
    Pattern("timestamp_as_random", "review", re.compile(r"\b(nonce|iv|salt|key|seed|random)\b.{0,80}\b(Date\.now|System\.currentTimeMillis)\b|\b(Date\.now|System\.currentTimeMillis)\b.{0,80}\b(nonce|iv|salt|key|seed|random)\b", re.IGNORECASE), "timestamp used near key, nonce, IV, salt, seed, or random context"),
    Pattern("kdf", "review", re.compile(r"\b(PBKDF2|pbkdf2|scrypt|Argon2|argon2|bcrypt|HKDF|hkdf|deriveKey|deriveBits|Rfc2898DeriveBytes)\b"), "KDF or password hashing candidate"),
    Pattern("hardcoded_secret_material", "high", re.compile(r"\b(api[_-]?key|private[_-]?key|secret|password|passphrase|token)\b\s*[:=]\s*['\"][A-Za-z0-9+/=_:.-]{12,}['\"]", re.IGNORECASE), "possible hardcoded secret, credential, token, or private key"),
    Pattern("hardcoded_key_material", "medium", re.compile(r"\b(key)\b\s*[:=]\s*['\"][A-Za-z0-9+/=_:.-]{24,}['\"]", re.IGNORECASE), "possible hardcoded cryptographic key material"),
    Pattern("static_iv_or_salt_literal", "high", re.compile(r"\b(iv|nonce|salt)\b\s*[:=]\s*(?:b|rb)?['\"](?:0+|000000000000|1234567890|changeme)['\"]", re.IGNORECASE), "possible static or zero IV/nonce/salt literal"),
    Pattern("iv_or_salt_allocation", "review", re.compile(r"\b(iv|nonce|salt)\b\s*[:=]\s*(Buffer\.alloc\(|new byte\[\]|bytes\()", re.IGNORECASE), "IV/nonce/salt allocation requiring fill/use review"),
    Pattern("custom_crypto", "medium", re.compile(r"\b(xor|rotate|rot13|feistel|sbox|substitution|stream cipher|block cipher)\b|(\^=|\^)\s*(key|secret|password)", re.IGNORECASE), "custom crypto or XOR-like construction candidate"),
    Pattern("serialization_codec", "review", re.compile(r"\b(JSON\.stringify|JSON\.parse|pickle|marshal|protobuf|serde|Codable)\b"), "serialization boundary candidate"),
    Pattern("crypto_envelope_field", "review", re.compile(r"\b(ciphertext|keyId|kid|nonce|iv|tag|mac|salt)\b"), "encrypted envelope field candidate"),
    Pattern("plaintext_sink", "high", re.compile(r"\b(console\.log|logger\.|Log\.[diewv]|NSLog|print\(|println!|writeFile|localStorage|sessionStorage|analytics|telemetry|crashlytics|Sentry|INSERT|UPDATE|fetch\(|axios\.|http\.post|requests\.post)\b"), "plaintext sink candidate"),
    Pattern("user_input", "review", re.compile(r"\b(req\.body|request\.(body|json|form|args|query|params)|params\[[^\]]+\]|query\[[^\]]+\]|stdin|readLine|MultipartFile|HttpServletRequest|@RequestBody)\b"), "user input or request boundary candidate"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Find candidate crypto review locations.")
    parser.add_argument("--root", default=".", help="repository root to scan")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    parser.add_argument("--max-line-length", type=int, default=500)
    parser.add_argument("--max-results", type=int, default=5000, help="maximum candidate lines to emit; use 0 for unlimited")
    parser.add_argument("--include-all-text", action="store_true", help="scan extensionless files that look like text")
    parser.add_argument("--exclude", action="append", default=[], help="directory name to exclude; can be repeated")
    return parser.parse_args()


def should_skip_dir(path: Path, excludes: set[str]) -> bool:
    return path.name in excludes or path.name.startswith(".cache")


def is_test_path(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    filename = path.name.lower()
    test_suffixes = (
        "_test.go",
        "_test.py",
        "_test.rs",
        ".spec.js",
        ".spec.jsx",
        ".spec.ts",
        ".spec.tsx",
        ".test.js",
        ".test.jsx",
        ".test.ts",
        ".test.tsx",
    )
    return bool(parts & {"test", "tests", "__tests__", "fixture", "fixtures", "__fixtures__"}) or filename.endswith(test_suffixes)


def looks_text(path: Path, include_all_text: bool) -> bool:
    if path.suffix in TEXT_EXTENSIONS:
        return True
    if not include_all_text:
        return False
    try:
        chunk = path.read_bytes()[:2048]
    except OSError:
        return False
    return b"\x00" not in chunk


def iter_files(root: Path, excludes: set[str], include_all_text: bool) -> Iterable[Path]:
    for current, dirnames, filenames in os.walk(root):
        current_path = Path(current)
        dirnames[:] = [name for name in dirnames if not should_skip_dir(current_path / name, excludes)]
        for filename in filenames:
            path = current_path / filename
            if looks_text(path, include_all_text):
                yield path


def redact(line: str, max_length: int) -> str:
    clean = line.rstrip("\n")
    clean = re.sub(r"(['\"])[A-Za-z0-9+/=_-]{12,}\1", r"\1<redacted-long-literal>\1", clean)
    clean = re.sub(r"(?i)(key|secret|password|token|passphrase)\s*[:=]\s*(['\"])[^'\"]+\2", r"\1=<redacted>", clean)
    if len(clean) > max_length:
        return clean[: max_length - 3] + "..."
    return clean


def scan_file(path: Path, root: Path, max_line_length: int, max_results: int = 0) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    relative_path = path.relative_to(root)
    test_path = is_test_path(relative_path)
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for lineno, line in enumerate(handle, 1):
                for pattern in PATTERNS:
                    if pattern.regex.search(line):
                        results.append(
                            {
                                "path": str(relative_path),
                                "line": lineno,
                                "category": pattern.category,
                                "severity_hint": pattern.severity_hint,
                                "test_path": test_path,
                                "note": pattern.note,
                                "excerpt": redact(line, max_line_length).strip(),
                            }
                        )
                        if max_results and len(results) >= max_results:
                            return results
    except OSError as exc:
        print(f"warning: cannot read {path}: {exc}", file=sys.stderr)
    return results


def emit_markdown(results: list[dict[str, object]]) -> None:
    print("# Crypto Static Scan")
    print()
    print("Heuristic triage output. Confirm reachability and context before writing findings.")
    print()
    if not results:
        print("No candidate lines matched.")
        return
    by_category: dict[str, list[dict[str, object]]] = {}
    for result in results:
        by_category.setdefault(str(result["category"]), []).append(result)
    for category in sorted(by_category):
        print(f"## {category}")
        print()
        for result in by_category[category]:
            path_scope = "test path" if result.get("test_path") else "source path"
            print(
                f"- `{result['path']}:{result['line']}` "
                f"({result['severity_hint']}; {path_scope}) {result['note']}: `{result['excerpt']}`"
            )
        print()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    excludes = DEFAULT_EXCLUDES | set(args.exclude)
    results: list[dict[str, object]] = []
    for path in iter_files(root, excludes, args.include_all_text):
        remaining = max(args.max_results - len(results), 0) if args.max_results else 0
        results.extend(scan_file(path, root, args.max_line_length, remaining))
        if args.max_results and len(results) >= args.max_results:
            results = results[: args.max_results]
            print(f"warning: stopped after --max-results={args.max_results}; narrow --root or raise the limit", file=sys.stderr)
            break
    results.sort(key=lambda item: (str(item["category"]), str(item["path"]), int(item["line"])))
    if args.format == "json":
        print(json.dumps(results, indent=2, sort_keys=True))
    else:
        emit_markdown(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
