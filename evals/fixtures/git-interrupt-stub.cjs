#!/usr/bin/env node
// Test-only Git boundary: hold the first fixture add until the test sends SIGINT.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('add') && !fs.existsSync(process.env.EVAL_GIT_READY)) {
  fs.writeFileSync(process.env.EVAL_GIT_READY, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync(process.env.EVAL_REAL_GIT, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
