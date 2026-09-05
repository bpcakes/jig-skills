# Search Playbook

Adapt commands to repository conventions and available tools. Prefer `rg`; fall back to `git grep` or `grep`.

## Public Surface

```bash
rg -n --glob '*.{ts,tsx}' \
  'export (default )?(function|class|const|interface|type)|export \{|createContext|forwardRef|useImperativeHandle' \
  <scope>
```

Inspect package entry points and barrel files:

```bash
rg -n '"exports"|"types"|"main"|"module"' --glob 'package.json' .
find <scope> -name 'index.ts' -o -name 'index.tsx'
```

## Third-Party Contracts Crossing Boundaries

```bash
rg -n --glob '*.{ts,tsx}' \
  'Use(Query|Mutation|Form)|QueryObserver|QueryKey|Control<|FieldValues|Axios(Response|Error)|ApolloError|NavigateFunction|Location|Dispatch<|SetStateAction' \
  <scope>
```

## React Ownership And Orchestration

```bash
rg -n --glob '*.{ts,tsx}' \
  'set[A-Z][A-Za-z0-9_]*\??:|dispatch\??:|useImperativeHandle|Children\.only|cloneElement|child\.type|querySelector|getElementsByClassName' \
  <scope>
```

## Escape Hatches And Configuration Growth

```bash
rg -n --glob '*.{ts,tsx}' \
  '(unsafe|unstable|internal|raw|bypass|force|skip|suppress|disableValidation)[A-Z_a-z0-9]*\??:' \
  <scope>
```

## Deep Imports

```bash
rg -n --glob '*.{ts,tsx}' \
  "from ['\"][^'\"]*/(src|internal|private|implementation)/" \
  <scope>
```

## Consumer Tracing

For a symbol `ExampleBoundary`:

```bash
rg -n --glob '*.{ts,tsx}' '\bExampleBoundary\b' .
```

For a package/subpath:

```bash
rg -n --glob '*.{ts,tsx}' "from ['\"]@scope/package(?:/[^'\"]*)?['\"]" .
```

Read the boundary and each consumer. Search for nearby casts, comments, duplicated mapping, status branching, key construction, provider setup, and selector use.

## Useful Consumer Evidence

Strong evidence includes:

- the same mapping or workaround in two independent consumers;
- a consumer importing both the abstraction and the hidden library;
- a consumer constructing an internal type solely to satisfy the boundary;
- comments that describe ordering or implementation constraints and are confirmed by code;
- tests that must mock internals to exercise public behavior;
- broad edits required when a hidden library, DOM shape, query key, or payload representation changes.

Weak evidence includes a keyword match, one large props type, one `className`, one Context, or a theoretical replacement with no affected consumer.
