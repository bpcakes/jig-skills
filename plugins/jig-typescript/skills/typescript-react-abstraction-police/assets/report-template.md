# Abstraction Police Report

## Summary

`<N>` confirmed leaky abstractions were found in `<scope>`. The highest-risk boundary is `<boundary>` because `<one-sentence reason>`.

## Findings

### AP-TSR-NNN: `<specific title>` — `<High|Medium|Low>`

**Boundary:** `<symbol>` in `<path:line>`

**Leak:** `<hidden implementation detail>`

**Evidence:**

- `<boundary definition or export>`
- `<consumer location and dependency>`
- `<second consumer or corroborating test/documentation>`

**Change test:** `<preserving internal change>` would require `<consumer edits>` solely because `<hidden detail>` escaped.

**Impact:** `<blast radius, correctness risk, replacement cost, or recurring change friction>`

**Counterevidence checked:** `<strongest benign interpretation and result>`

**Correction:** `<smallest ownership correction, split, translation, or deletion>`

**Confidence:** `<High|Medium>` — `<evidence basis>`

## Coverage

- Scope reviewed: `<paths/packages/diff>`
- Boundaries inspected: `<count or list>`
- Consumer paths traced: `<count or list>`
- Excluded or unresolved: `<material exclusions>`

## Empty Result

When no item survives validation, replace the report with:

> No confirmed leaky abstractions found in `<scope>`. Reviewed `<boundaries and consumers>`. `<material exclusions or residual uncertainty>`.
