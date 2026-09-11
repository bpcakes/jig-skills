# Untrusted input sinks

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 3. User input controlling SQL structure

Search leads:

```bash
rg -n "(sqlx::query|sqlx::query_as|query!|query_as!|diesel::sql_query|rusqlite::Connection::prepare|prepare_cached|sea_query|Statement::from_string)" . --glob '*.rs'
rg -n "(format!\(|push_str\(|write!\(|\+).*?(SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER BY|GROUP BY|LIMIT|OFFSET|FROM|JOIN)" . --glob '*.rs' -i
rg -n "(?i)(sort|order|filter|field|column|table|direction|limit|offset).*Query|Query<|Path<|Json<" . --glob '*.rs'
```

Flag when:

- User input is concatenated/interpolated into SQL text, including `ORDER BY`, column names, table names, operators, `LIMIT`, `OFFSET`, `WHERE` fragments, or `IN (...)` lists.
- Dynamic SQL uses request-provided field/table/operator names without an allowlist mapping to known identifiers.
- Numeric pagination values are interpolated as strings rather than bound or range-checked.
- Query builders accept raw user strings as SQL fragments.

Do not flag when:

- User input is bound as values through placeholders/bind APIs.
- Dynamic identifiers are selected from a closed enum/allowlist controlled by server code.
- SQL text is built dynamically but every user-controlled value remains parameterized and every structural choice comes from a server-owned enum.

Preferred fixes:

- Use bind parameters for values.
- Map user-facing sort/filter names to server-owned enum variants and static SQL fragments.
- Reject unknown columns/operators/directions; constrain pagination bounds.

### 4. User input controlling file paths

Search leads:

```bash
rg -n "(PathBuf::from|\.join\(|std::fs::|tokio::fs::|File::open|File::create|NamedFile|TempDir|tempfile|multipart|file_name|filename)" . --glob '*.rs'
rg -n "(?i)(path|filename|file_name|upload|download|attachment).*?(Path<|Query<|Json<|Form<|header|multipart)" . --glob '*.rs'
```

Flag when:

- Request-controlled path or filename reaches `join`, `open`, `read`, `write`, `remove`, `rename`, `NamedFile`, archive extraction, or upload storage without strict validation.
- Validation only checks for `..` as a substring but misses absolute paths, encoded separators, Unicode separator lookalikes, Windows drive paths, symlinks, leading dots, or path normalization issues.
- A base directory is joined with user input but the resolved/canonical final path is not proven to remain inside the base directory.
- User-controlled filenames are reused for storage paths, shell args, public URLs, or response headers without sanitization and uniqueness.

Preferred fixes:

- Prefer opaque server-generated IDs/filenames over user-provided paths.
- Allowlist filename characters and length; reject separators, leading dots, absolute paths, and platform-specific path prefixes.
- Canonicalize base and target where appropriate, then verify target starts with canonical base; account for symlinks and race conditions for writes.
- Store uploads outside executable/static roots unless explicitly intended.

### 5. User input controlling redirects

Search leads:

```bash
rg -n "(Redirect::to|Redirect::temporary|Redirect::permanent|SeeOther|Found|TemporaryRedirect|PermanentRedirect|LOCATION|Location|append_header\(.*Location|insert_header\(.*Location)" . --glob '*.rs'
rg -n "(?i)(next|return_to|redirect|redirect_uri|callback|continue|url).*?(Query<|Path<|Json<|Form<)" . --glob '*.rs'
```

Flag when:

- `next`, `return_to`, `redirect_uri`, `callback`, or similar input can set an absolute URL or scheme-relative URL.
- Validation uses weak substring/suffix checks such as `contains("example.com")` or `ends_with("example.com")` without parsing host boundaries.
- OAuth/login/logout flows accept arbitrary redirect destinations.

Preferred fixes:

- Prefer relative-path-only redirects beginning with a single `/` and not `//`.
- For external redirects, parse and allowlist exact scheme/host/port combinations.
- Store redirect targets server-side and reference them by nonce.

### 6. User input controlling headers

Search leads:

```bash
rg -n "(HeaderMap|HeaderName|HeaderValue|insert_header|append_header|headers\.insert|headers\.append|CONTENT_DISPOSITION|SET_COOKIE|LOCATION|StatusCode)" . --glob '*.rs'
rg -n "(?i)(header|user_agent|referer|origin|filename|download|attachment|disposition).*?(Query<|Path<|Json<|Form<|headers?)" . --glob '*.rs'
```

Flag when:

- User input controls header names or sensitive header values without allowlisting.
- User input is embedded in `Location`, `Set-Cookie`, `Content-Disposition`, cache, CSP, CORS, or auth-related headers without parser/encoder validation.
- Filenames in `Content-Disposition` are not encoded/sanitized.
- Application forwards user-provided `Origin`, `Host`, `X-Forwarded-*`, or `Authorization` into security decisions or response headers without trusted proxy rules and validation.

Preferred fixes:

- Use typed header APIs where possible.
- Allowlist header names and use `HeaderValue::from_str` plus stricter semantic validation.
- Use framework cookie builders and content-disposition encoders rather than string formatting.

### 7. User input controlling shell commands

Search leads:

```bash
rg -n "(std::process::Command|tokio::process::Command|Command::new|\.arg\(|\.args\(|sh -c|bash -c|cmd /C|powershell|duct::|xshell|shell_words)" . --glob '*.rs'
rg -n "(?i)(command|cmd|program|executable|arg|script).*?(Query<|Path<|Json<|Form<|env::args)" . --glob '*.rs'
```

Flag when:

- User input controls the program name, shell string, or command template.
- Code uses `sh -c`, `bash -c`, `cmd /C`, or `powershell -Command` with any user-controlled content.
- User input controls flags/options where an attacker can add new flags, file operands, or command separators.
- Escaping is treated as the primary defense when a shell can be avoided.

Do not flag when:

- The executable is static, shell is not used, and user input is passed as a single `.arg()` value to a command whose option semantics are safe for that value.
- User input is mapped to a closed allowlist of server-owned subcommands/arguments.

Preferred fixes:

- Avoid shells; use static `Command::new` and separate `.arg()` calls.
- Map user choices to closed enums.
- Validate value syntax, length, and allowed characters; insert `--` before user operands where supported.
