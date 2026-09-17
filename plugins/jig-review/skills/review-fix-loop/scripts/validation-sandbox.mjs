import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { executableCommand } from "./job-runtime.mjs";

export function assertValidationSandbox(mode, cwd) {
  if (mode === "host") return;
  const executable = mode === "bubblewrap" && process.platform === "linux" ? "bwrap"
    : mode === "seatbelt" && process.platform === "darwin" ? "/usr/bin/sandbox-exec" : null;
  if (!executable || !executableCommand({ role: "validate", cwd, command: [executable] })) {
    throw new Error(`Validation sandbox ${mode} is unavailable on ${process.platform}; no automatic host fallback.`);
  }
}

export function defaultValidationSandbox() {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform === "linux") return "bubblewrap";
  throw new Error(`Unsupported controller platform: ${process.platform}`);
}

export function validationSandboxCommand(mode, overlay, scratch, argv, objectDirectories = [], sourceRoot = null) {
  if (mode === "host") return { argv, environment: {} };
  if (mode !== defaultValidationSandbox()) throw new Error(`Validation sandbox ${mode} is unavailable on ${process.platform}; no automatic host fallback.`);
  const source = sourceRoot && realpathSync(sourceRoot);
  const workspace = realpathSync(overlay);
  if (source && (workspace === source || workspace.startsWith(`${source}${path.sep}`))) throw new Error("Isolated validation workspace must be outside the original source tree.");
  const temporary = realpathSync(scratch);
  if (source && (temporary === source || temporary.startsWith(`${source}${path.sep}`))) throw new Error("Isolated validation scratch must be outside the original source tree.");
  for (const name of ["cache", "config"]) mkdirSync(path.join(temporary, name), { recursive: true, mode: 0o700 });
  const environment = { HOME: temporary, XDG_CACHE_HOME: `${temporary}/cache`, XDG_CONFIG_HOME: `${temporary}/config`, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  if (mode === "bubblewrap" && process.platform === "linux") return {
    // Conceal host /tmp, then expose only the owned workspace and scratch.
    // Both platforms use the same reserved resource for home/cache/temp.
    argv: ["bwrap", "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--tmpfs", "/tmp",
      ...(source ? ["--tmpfs", source] : []), "--bind", workspace, workspace, "--bind", temporary, temporary,
      ...objectDirectories.flatMap(directory => ["--ro-bind", directory, directory]),
      "--proc", "/proc", "--dev", "/dev", "--", ...argv],
    environment,
  };
  if (mode === "seatbelt" && process.platform === "darwin") {
    // Git canonicalizes alternate paths before reading objects. Permit only
    // metadata on their ancestors, never original checkout file contents.
    const objectAncestors = new Set();
    for (const directory of objectDirectories) {
      for (let parent = path.dirname(realpathSync(directory)); source && (parent === source || parent.startsWith(`${source}${path.sep}`)); parent = path.dirname(parent)) {
        objectAncestors.add(parent);
        if (parent === source) break;
      }
    }
    const profile = readFileSync(new URL("./macos-validation.sb", import.meta.url), "utf8")
      + (source ? `\n(deny file-read* (subpath ${JSON.stringify(source)}))\n` : "")
      + [...objectAncestors].map(directory => `(allow file-read-metadata (literal ${JSON.stringify(directory)}))\n`).join("")
      + `(allow file-read* (subpath ${JSON.stringify(temporary)}))\n`
      + objectDirectories.map(directory => `(allow file-read* (subpath ${JSON.stringify(realpathSync(directory))}))\n`).join("");
    return {
      argv: ["/usr/bin/sandbox-exec", "-D", `WORKSPACE=${workspace}`, "-D", `SCRATCH=${temporary}`, "-p", profile, ...argv],
      environment,
    };
  }
  throw new Error(`Validation sandbox ${mode} is unavailable on ${process.platform}; no automatic host fallback.`);
}
