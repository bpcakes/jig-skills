# React test quality report contract

Lead with confirmed findings, ordered by impact. A review may have no findings;
state that plainly and distinguish unavailable evidence from demonstrated gaps.
Do not manufacture an issue, severity, or a fixed number of rewrites to fill a
template. This is the single reusable report template for this skill.

First establish a specific regression that survives the relevant suite, after
checking the claimed contract and other coverage. Then rate its consequence:
Critical for severe, reachable harm; High for major required behavior lost;
Medium for a meaningful but bounded failure; Low for a demonstrated minor
consequence. Query syntax, mocks, or missing assertions never set the rating.
Explain the impact and reachability supporting the selected severity.

Use this block only for an established defect:

```md
#### [Impact-supported severity]: [title]
Evidence: [file/line and the actual assertion or missing contract]
Surviving regression: [specific incorrect behavior these tests would accept]
Consequence and severity: [who is affected, reachability, and extent of harm]
Counterevidence checked: [other tests, intended smoke/unit boundaries, requirements]
Minimal repair: [test or assertion that rejects that regression]
Verification: [how to demonstrate fail-before/pass-after; distinguish reasoning from execution]
```

Include residual risks or optional improvements only when useful. Accessible
queries can be suggested as optional hardening when no uncovered accessibility
contract is established; do not prescribe replacing intentional test IDs.
Fix plans contain only the repairs warranted by findings, not a mandatory quota.
