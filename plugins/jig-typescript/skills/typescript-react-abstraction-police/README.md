# TypeScript/React Abstraction Police

A portable Agent Skill for finding **validated** leaky abstractions in TypeScript and React repositories.

The package is intentionally stricter than a smell detector. It requires evidence that a consumer depends on a hidden implementation detail and that a semantics-preserving internal change would force unrelated consumer edits.

## Installation

This skill is bundled with the `jig-typescript` plugin in `jig-skills`. Install the plugin using the [repository instructions](../../../../README.md#install-with-codex), then invoke `$jig-typescript:typescript-react-abstraction-police`.

Run the scanner and test commands below from this skill directory.

## Contents

```text
typescript-react-abstraction-police/
├── SKILL.md
├── README.md
├── assets/
│   └── report-template.md
├── references/
│   ├── examples.md
│   ├── leak-catalog.md
│   ├── search-playbook.md
│   └── validation-and-severity.md
├── scripts/
│   └── scan.mjs
└── tests/
    ├── fixtures/
    └── scan.test.mjs
```

## Candidate Scanner

The scanner uses only Node.js standard-library modules and does not install packages or access the network.

```bash
node scripts/scan.mjs /path/to/repo --format text
node scripts/scan.mjs /path/to/repo/src --format json
node scripts/scan.mjs /path/to/repo --include-tests --max-files 5000
```

It flags investigation leads such as exported Context objects, raw React state setters, boolean prop clusters, form/query library types crossing public boundaries, deep internal imports, child-shape assumptions, and pass-through wrappers.

Scanner output is not a final architecture finding. The skill validates every lead against real consumers and counterevidence.

## Tests

```bash
node --test tests/scan.test.mjs
```
