import { execFileSync } from "node:child_process";
import { enforcedGit } from "./git-lease.mjs";

// Repository-controlled hooks, monitors and converters must not execute with
// the enforced controller's host authority. Active conversion attributes are rejected
// by the source capability check; disable their executables even during that
// check and during status/diff inspection. Legacy standalone inspection retains
// its configured converters; hooks and filesystem monitors stay disabled.
export const filterConfigArgs = ["config", "--null", "--name-only", "--get-regexp", "^filter\\."];

export function nonExecutingGitArgs(args, options) {
  let names = "";
  try {
    names = execFileSync("git", gitSafetyArgs(filterConfigArgs),
      { ...options, input: undefined, encoding: "utf8", maxBuffer: 1024 * 1024,
        timeout: Math.min(options?.timeout ?? 30000, 30000) }).toString();
  } catch (error) { if (error.status !== 1) throw error; }
  return gitSafetyArgs(args, names);
}

export function gitSafetyArgs(args, names = "") {
  const fixed = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
  const drivers = new Set(names.split("\0").filter(name => /\.(clean|smudge|process|required)$/i.test(name))
    .map(name => name.slice(0, name.lastIndexOf("."))));
  for (const driver of enforcedGit() ? drivers : []) {
    for (const property of ["clean", "smudge", "process"]) fixed.push("-c", `${driver}.${property}=`);
    fixed.push("-c", `${driver}.required=false`);
  }
  let command = 0;
  while (args[command] === "-c") command += 2;
  const selected = args[command] === "diff"
    ? [...args.slice(0, command + 1), "--no-ext-diff", "--no-textconv", ...args.slice(command + 1)] : args;
  return [...fixed, ...selected];
}
