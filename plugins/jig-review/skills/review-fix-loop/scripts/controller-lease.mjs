import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { activeGitLease, withGitLease } from "../../panel-review/scripts/git-lease.mjs";

// Only the location is immutable. Every acquisition still invokes the boundary
// to validate identity, lock the current inode and check current controls.
let leaseLocation;

function acquire(run) {
  const command = run.config.executionBoundary;
  if (!command) return { controls: {}, borrowed: true };
  const inherited = activeGitLease();
  if (inherited) {
    if (inherited.root !== run.root) throw new Error("Controller lease belongs to another checkout.");
    return { ...inherited, borrowed: true };
  }
  const call = (args, fd) => execFileSync(command[0], [...command.slice(1), ...args], {
    encoding: "utf8", maxBuffer: 16384, timeout: 10000,
    stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", fd],
  });
  const key = JSON.stringify([run.root, command]);
  if (leaseLocation?.key !== key) leaseLocation = { key, file: JSON.parse(call(["--lease-path", run.root])).path };
  const file = leaseLocation.file;
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const controls = JSON.parse(call(["--lock-publication", run.root], fd));
    // Python acquired flock on this shared open-file description. Its exit
    // does not unlock it; this fd and every in-flight Git child retain it.
    return { fd, root: run.root, controls };
  } catch (error) { closeSync(fd); throw error; }
}

function enter(run, busy) {
  try { return { lease: acquire(run) }; }
  catch (error) {
    if (error.status === 75 && busy) return { result: busy() };
    throw error;
  }
}

export async function withControllerLease(run, callback, busy) {
  const held = enter(run, busy);
  if (!held.lease) return held.result;
  const lease = held.lease;
  try {
    return await (lease.borrowed ? callback(lease.controls) : withGitLease(lease, () => callback(lease.controls)));
  } finally { if (!lease.borrowed) closeSync(lease.fd); }
}

export function withControllerLeaseSync(run, callback, busy) {
  const held = enter(run, busy);
  if (!held.lease) return held.result;
  const lease = held.lease;
  try {
    return lease.borrowed ? callback(lease.controls) : withGitLease(lease, () => callback(lease.controls));
  } finally { if (!lease.borrowed) closeSync(lease.fd); }
}
