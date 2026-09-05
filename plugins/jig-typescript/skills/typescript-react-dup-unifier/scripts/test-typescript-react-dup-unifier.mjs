#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'typescript-react-dup-unifier.mjs',
);

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.trimStart());
}

function scan(root, extra = []) {
  const report = path.join(root, 'dup-report.json');
  const result = spawnSync(process.execPath, [script, root, '--json', report, '--quiet', ...extra], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `scanner failed:\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(fs.readFileSync(report, 'utf8'));
}

function pairNames(candidate) {
  return [candidate.left.qualifiedName, candidate.right.qualifiedName].sort().join('|');
}

test('detects near-duplicate React hooks and components while ignoring unrelated code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-react-dup-unifier-'));
  try {
    write(root, 'package.json', JSON.stringify({ name: 'dup-fixture' }));
    write(root, 'src/useUserSearch.ts', `
      import { useEffect, useState } from 'react';
      export function useUserSearch(query: string) {
        const [data, setData] = useState<string[]>([]);
        const [loading, setLoading] = useState(false);
        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          fetch(\`/api/users?q=\${query}\`)
            .then((response) => response.json())
            .then((items) => { if (!cancelled) setData(items); })
            .finally(() => { if (!cancelled) setLoading(false); });
          return () => { cancelled = true; };
        }, [query]);
        return { data, loading };
      }
    `);
    write(root, 'src/useOrderSearch.ts', `
      import { useEffect, useState } from 'react';
      export function useOrderSearch(term: string) {
        const [orders, setOrders] = useState<string[]>([]);
        const [pending, setPending] = useState(false);
        useEffect(() => {
          let aborted = false;
          setPending(true);
          fetch(\`/api/orders?q=\${term}\`)
            .then((response) => response.json())
            .then((items) => { if (!aborted) setOrders(items); })
            .finally(() => { if (!aborted) setPending(false); });
          return () => { aborted = true; };
        }, [term]);
        return { data: orders, loading: pending };
      }
    `);
    write(root, 'src/UserCard.tsx', `
      type Props = { name: string; subtitle?: string };
      export function UserCard({ name, subtitle }: Props) {
        return (
          <article className="card">
            <h2>{name}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </article>
        );
      }
    `);
    write(root, 'src/AdminCard.tsx', `
      type Props = { name: string; subtitle?: string };
      export function AdminCard({ name, subtitle }: Props) {
        return (
          <section className="card" aria-label="Administrator">
            <h2>{name}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </section>
        );
      }
    `);
    write(root, 'src/calculateTax.ts', `
      export function calculateTax(subtotal: number, rate: number) {
        if (subtotal < 0 || rate < 0) throw new Error('invalid');
        const taxable = Math.max(0, subtotal);
        return Math.round(taxable * rate * 100) / 100;
      }
    `);
    write(root, 'src/ignored.test.ts', `
      export function ignoredTestHelper(input: string) {
        const normalized = input.trim().toLowerCase();
        return normalized.split('').reverse().join('');
      }
    `);

    const report = scan(root);
    const pairs = new Set(report.candidates.map(pairNames));

    assert.ok(pairs.has('useOrderSearch|useUserSearch'), 'expected hook pair');
    assert.ok(pairs.has('AdminCard|UserCard'), 'expected component pair');
    assert.ok(
      report.candidates
        .find((candidate) => pairNames(candidate) === 'useOrderSearch|useUserSearch')
        .divergence.literals.onlyLeft.some((value) => value.includes('/api/orders')),
      'expected endpoint divergence to be surfaced',
    );
    assert.equal(report.summary.filesScanned, 5, 'test file should be excluded by default');
    assert.ok(![...pairs].some((pair) => pair.includes('calculateTax')), 'unrelated function should not be paired');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('can include tests explicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-react-dup-unifier-'));
  try {
    write(root, 'src/a.ts', `
      export function normalizeAccount(value: string) {
        const clean = value.trim().toLowerCase();
        if (!clean) return null;
        return { value: clean, valid: clean.includes('@') };
      }
    `);
    write(root, 'src/a.test.ts', `
      export function normalizeFixture(value: string) {
        const clean = value.trim().toLowerCase();
        if (!clean) return null;
        return { value: clean, valid: clean.includes('@') };
      }
    `);

    const excluded = scan(root, ['--min-score', '0.5']);
    const included = scan(root, ['--min-score', '0.5', '--include-tests']);
    assert.equal(excluded.summary.filesScanned, 1);
    assert.equal(included.summary.filesScanned, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
