#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required for this helper script." >&2
  exit 1
fi

cd "$ROOT"

common=(--no-messages --glob '*.rs' --glob '!target/**' --glob '!**/.git/**' --glob '!vendor/**' --glob '!third_party/**')
all_common=(--no-messages --hidden --glob '*.rs' --glob '*.toml' --glob '*.yaml' --glob '*.yml' --glob '*.env*' --glob '!target/**' --glob '!**/.git/**' --glob '!vendor/**' --glob '!third_party/**')

section() {
  printf '\n===== %s =====\n' "$1"
}

run_rg() {
  local label="$1"
  shift
  section "$label"
  rg -n "$@" || true
}

section "Rust security boundary scan"
echo "Root: $(pwd)"
echo "Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Note: matches are leads, not findings. Prove dataflow manually."

run_rg "Routes and external entry points" \
  "(Router::new|\.route\(|web::resource|#\[(get|post|put|patch|delete)|warp::|rocket::|tonic::|async_graphql|juniper)" "${common[@]}"

run_rg "Auth/authz/tenant vocabulary" \
  "(?i)(auth|authorize|permission|policy|role|scope|claim|principal|subject|tenant|workspace|organization|owner|admin|user_id|tenant_id|org_id|workspace_id|account_id|owner_id)" "${common[@]}"

run_rg "Secret-bearing identifiers" \
  "(?i)(password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|credential|bearer|authorization|session)" "${common[@]}"

run_rg "Derives that may expose or copy secrets" \
  "#\[derive\([^\]]*(Debug|Serialize|Deserialize|Clone)" "${common[@]}"

run_rg "Logging/formatting/serialization sinks" \
  "(println!|eprintln!|dbg!|format!|panic!|tracing::(debug|info|warn|error)!|log::(debug|info|warn|error)!|serde_json::to_(string|value|vec))" "${common[@]}"

run_rg "Secret wrappers/redaction" \
  "(expose_secret|into_secret|SecretString|SecretVec|SecretBox|Zeroizing|zeroize|redact|mask|ConstantTimeEq|ct_eq|constant_time|subtle)" "${common[@]}"

run_rg "SQL sinks and dynamic SQL leads" \
  "(sqlx::query|sqlx::query_as|query!|query_as!|diesel::sql_query|rusqlite::Connection::prepare|prepare_cached|sea_query|Statement::from_string|format!\(|push_str\(|write!\(|ORDER BY|GROUP BY|LIMIT|OFFSET|WHERE|JOIN)" "${common[@]}"

run_rg "Filesystem path sinks" \
  "(PathBuf::from|\.join\(|std::fs::|tokio::fs::|File::open|File::create|NamedFile|TempDir|tempfile|multipart|file_name|filename|upload|download)" "${common[@]}"

run_rg "Redirect and Location sinks" \
  "(Redirect::to|Redirect::temporary|Redirect::permanent|SeeOther|Found|TemporaryRedirect|PermanentRedirect|LOCATION|Location|append_header\(.*Location|insert_header\(.*Location|return_to|redirect_uri|callback|continue)" "${common[@]}"

run_rg "Header sinks" \
  "(HeaderMap|HeaderName|HeaderValue|insert_header|append_header|headers\.insert|headers\.append|CONTENT_DISPOSITION|SET_COOKIE|LOCATION|Set-Cookie|Origin|Host|X-Forwarded)" "${common[@]}"

run_rg "Shell command sinks" \
  "(std::process::Command|tokio::process::Command|Command::new|\.arg\(|\.args\(|sh -c|bash -c|cmd /C|powershell|duct::|xshell|shell_words)" "${common[@]}"

run_rg "CORS configuration" \
  "(CorsLayer|actix_cors|warp::cors|rocket_cors|allow_origin|allow_any_origin|AllowOrigin|Any|mirror_request|allow_credentials|Access-Control-Allow-Origin|Access-Control-Allow-Credentials|CORS|cors)" "${all_common[@]}"

run_rg "Cookie security attributes" \
  "(Cookie::build|CookieBuilder|set_cookie|Set-Cookie|SameSite|http_only|secure\(|max_age|expires|domain\(|path\()" "${common[@]}"

run_rg "Token/API key comparison and URL placement" \
  "(?i)(api[_-]?key|apikey|token|access_token|refresh_token|session|jwt|bearer|authorization|x-api-key|password).*(==|!=|eq\(|contains\(|starts_with\(|ends_with\(|Query<|Path<|uri|url|redirect|Location|format!|params|query)" "${common[@]}"

run_rg "Rate limiting and sensitive flows" \
  "(?i)(rate|limit|throttle|governor|tower_governor|actix_governor|leaky|bucket|quota|backoff|captcha|lockout|slow_down|login|signin|token|refresh|password|reset|forgot|verify|verification|otp|mfa|2fa|invite|webhook|admin|export|graphql|upload|email|sms)" "${common[@]}" --glob '*.toml'

run_rg "Error response leakage leads" \
  "(IntoResponse|ResponseError|ErrorBadRequest|ErrorInternalServerError|anyhow|thiserror|eyre|Display for|Debug for|format!\(.*err|format!\(.*error|to_string\(\)|backtrace|source\(\)|panic!|unwrap\(|expect\(\)|sqlx::Error|reqwest::Error)" "${common[@]}"
