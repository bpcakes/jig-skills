// The nested Codex sandbox must permit its canonical Unix socket. The outer
// runtime's verified namespace remains responsible for network confinement.
import { runCommand } from "./review-context.mjs";
import { remainingAdapterTime } from "./adapter-runtime.mjs";

export const CHANNEL_PERMISSION = 'default_permissions="herdr_review"';
export const CHANNEL_SETTINGS = Object.freeze([
  CHANNEL_PERMISSION,
  'permissions.herdr_review={extends=":read-only",network={enabled=true}}',
  "features.network_proxy=false",
  "features.use_legacy_landlock=false",
]);

export async function verifiedReadOnlyChannel(root, { deadlineAt, signal, environment = process.env } = {}) {
  const socket = environment.ORCHESTRATION_SOCKET, credential = environment.ORCHESTRATION_CREDENTIAL_FILE,
    task = environment.ORCHESTRATION_TASK;
  if (!socket && !credential && !task) return false;
  if (process.platform !== "linux" || socket !== "/run/orchestration/endpoint/gateway.sock"
      || credential !== "/run/orchestration/credential" || !task) throw new Error("Orchestration review requires its complete fixed channel binding.");
  const result = await runCommand("/usr/bin/python3", ["-B", "/opt/orchestration/communicate.py"], {
    input: JSON.stringify({ op: "context", task_id: task }), env: environment, signal,
    timeoutMs: deadlineAt == null ? 10000 : Math.min(10000, remainingAdapterTime(deadlineAt)), maxBuffer: 16384,
  });
  const context = JSON.parse(result.stdout.toString("utf8"));
  if (context.protocol !== 1 || context.context_schema !== 1 || context.boundary !== "linux-namespaces"
      || context.network !== "gateway-egress-only" || context.source_access !== "read"
      || !["reviewer", "executor"].includes(context.role) || context.task_id !== task
      || context.worktree !== root) throw new Error("Orchestration runtime did not verify this read-only review namespace.");
  return true;
}
