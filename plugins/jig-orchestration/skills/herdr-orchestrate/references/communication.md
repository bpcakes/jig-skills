# Agent communication

Every run has one message protocol: durable questions, replies, assignments and
updates between the coordinator and a task's driver, scoped evidence artifacts,
an inbox with cursors, and generic wake hints. The protocol is separate from the
execution boundary. `communication.mode` selects only the boundary and the
transport that goes with it:

| Mode | How a request reaches the protocol | Boundary |
| --- | --- | --- |
| `legacy` (default) | The coordinator runs `supervise.py channel`. A driver sends the same request through its verified `serve` return route. | None. Identity comes from the transport, as for every other request in an unconfined run. |
| `enforced` | Every model runs `communicate.py` with its launch credential against the gateway. | Linux Bubblewrap on one verified local host. No other agent route exists. |

Message kinds, cursors, acknowledgement, artifacts and hints behave the same in
both modes; see [agent requests](#agent-requests) and [hints](#hints). A run's
mode is fixed when it is initialized. `supervise.py init` selects `legacy` unless
the configuration or `--communication-mode enforced` asks for isolation.

## Unconfined runs

No gateway, credential or launch profile is involved. The coordinator sends one
JSON request per command; `--request -` reads standard input:

```sh
python3 <skill-root>/scripts/supervise.py channel --run-dir <private-run> --request <request.json>
```

A driver sends that same object to its [restricted return route](runtime.md#restricted-worker-return-route).
The forced command names the driver; a request can never select its caller.
Both transports accept `message`, `ack`, `artifact_put`, `inbox`, `message_read`,
`artifact_read`, `result`, and `watch` with `view:"inbox"`. A driver without a
verified return route cannot use the protocol: a message addressed to it is
refused as `unreachable`, and the coordinator mediates for it as before.

For example, a driver asks and then waits without spending model turns:

```json
{"op":"message","task_id":"example-A","action_id":"a-question-1","recipient":"coordinator","kind":"question","body":"Which interface revision should the consumer use?"}
{"op":"watch","task_id":"example-A","view":"inbox","after":"<cursor from its last inbox page>","until_change":true}
```

The first request a caller makes creates its session record on the coordinator
host. It follows the caller's current task scope, so newly scoped or admitted
tasks need no relaunch. The record holds no secret and proves nothing by itself;
a revoked route or a changed task binding stops it. This gives an unconfined run
durable, ordered, retry-safe messages. It does not confine anyone: same-user
agents remain as trusted as the rest of that run.

## Hints

A hint is the fixed text "Orchestration updates are available. Read your
authenticated inbox." typed into a registered pane by the scheduler. It carries
no task content and grants no authority. Each one costs its recipient a model
turn, so the runtime sends one only when all of these hold:

- Something was addressed to that actor: a message, a change to its task's
  pause, cancellation, holds, delegation, recovery, blocker, ownership, parking
  or closure, a run-wide pause, cancel or hold, or an actionable integration
  notice. Routine lifecycle steps and artifact publication stay in the inbox
  without a hint; attach evidence to a message when someone must act on it.
- Another party caused it. An actor is never hinted about its own message or
  action, and its own events do not end its inbox `watch`.
- The actor has not acknowledged past it. `ack` retires the pending hint.
- The pane's agent is `idle` or `done`. A `working` agent is retried shortly
  without counting a failure. A blocked or unrecognized pane is never typed into
  and is recorded as an unconfirmed delivery.

An enforced run binds each launch with `notify.py --bind-session`, as described
under host setup. In an unconfined run the coordinator needs no binding: hints
use its registered [scheduler](runtime.md#scheduler) identity, wait while a
reconciliation wake is pending, and keep the scheduler's minimum cadence from
any earlier wake or hint. Set `minimum_cadence_seconds` below `cadence_seconds`
to let a driver's question arrive between reconciliation passes. Bind a driver's
verified pane with `notify.py --run-dir <private-run> --actor <driver> --endpoint
<verified-endpoint.json>`; an unbound driver learns of messages through its
inbox watch. Stopping the scheduler stops hints.

## Enforced runs

An enforced run has one agent-facing protocol and no alternate route. The trusted
host runtime owns the private run directory, launch profiles, session issuance,
execution supervision and Herdr endpoint bindings. Models receive a task-scoped
credential and the gateway endpoint inside a Linux Bubblewrap boundary. They
cannot administer the run. This boundary does not eliminate covert information
channels in source, build output or permitted external services. Host setup,
the review-fix execution boundary, compatibility, retained capacity and
acceptance below describe that mode.

## Host setup and launches

Select enforcement with `supervise.py init --run-dir <private-run> --config
<config.json> --communication-mode enforced`, or `"communication":{"mode":"enforced"}`
in the configuration. Do not migrate an active run by editing its mode.
Unsupported enforcement stops launch; it never selects an unconfined command or
a weaker reviewer model.

Start `python3 <skill-root>/scripts/gateway.py --run-dir <private-run>` on the
trusted host. Enforced launches require Linux, Bubblewrap and working user,
mount, network and PID namespaces. The endpoint directory is separate from
private state so existing clients can reconnect after gateway replacement.
An inventory/version check is not a successful launch capability receipt.

The current enforced backend executes on one local Linux host. Mark that host
with `"execution":{"kind":"local"}` in its registered host configuration; a
local probe cannot certify a remote machine or multiple host aliases. After
initialization, the trusted host runs:

```sh
python3 <skill-root>/scripts/supervise.py verify-host \
  --run-dir <private-run> --host <local-host-id>
```

This exercises real writer/reader namespaces, descendant confinement, hidden
host files, blocked host networking and the mounted Unix endpoint. Admission and
launch require its private receipt, bound to the run, host configuration, machine,
boot, security settings and Python/orchestration/Bubblewrap runtime. Changes
invalidate the receipt; changing only execution slots does not. Re-verification
invalidates prepared launches, which must be prepared again. Existing jobs retain
their observation and settlement path. Provider login and actual build/review
commands still require their own acceptance checks.
Handoffs apply the same capability and private-checkout checks as admission.
If runtime files change after a trusted process starts, restart that process
from the selected pinned runtime before verifying again; loaded old code cannot
certify newly edited files.

Each task needs its own writable Git metadata: use a separate clone at admission,
not a linked worktree sharing another checkout's `.git` directory. Preserve that
selected checkout for review. An existing linked-worktree task remains legacy
unless the user authorizes a separate migration with settled writers.
For local clones, use `git clone --no-hardlinks`; shared object inodes, Git
alternates, shared common directories and symlinked metadata are rejected.

Launch profiles are private, host-owned JSON with `schema:1` and these fields:

| Field | Contract |
| --- | --- |
| `argv` | Exact selected executable and arguments, including established model and effort settings. |
| `mounts` | Explicit `{source,target}` read-only tools mounted beneath `/opt/tools/`. Include a CLI's required companion binaries and resources. Never mount the host home, run state, administrative sockets or sibling checkouts. |
| `files` | Individual `{source,target}` or `{content,target}` files copied into the private session home. Targets are relative. Supply only the selected provider's required authentication/configuration. |
| `environment` | Explicit string variables; launcher-owned home, path and channel variables cannot be replaced. |
| `egress_hosts` | Exact HTTPS provider hostnames. The local CONNECT relay checks current session authority and resolved public destinations. These grants do not constrain every semantic operation at that provider. |
| `workspace_access` | `none` for a control driver waiting on task executors, `read` for readers, or `write` for a source worker. Reviewers are always read-only; coordinators have a private empty workspace. |

Tool source paths are checked before session issuance and again before launch.
They must not expose private runtime state, checkout roots, administrative paths,
the host home or an ancestor of those locations. Tool bundles must not contain
host sockets or devices. Explicit individual provider files remain supported;
provisioning cannot copy orchestration state or checkout files into the home.
These checks prevent configuration mistakes; the host administrator selecting
the tools and provider credentials remains trusted.

Provision on the host without starting the model:

```sh
python3 <skill-root>/scripts/isolation.py --run-dir <private-run> \
  --actor <registered-driver> --task <task-id> --profile <private-profile.json> --prepare-only
```

The response contains `launch_dir` and a non-secret `session_id`. Start exactly
that launch with `isolation.py --launch-dir <launch-dir>`. A coordinator uses
`--actor coordinator` and can start before any task is admitted. A reviewer uses
a distinct actor, `--role reviewer`, one task and `--review-contract <json>`.
Reviewers and executors also require `--owner-session <session-id>` naming the
current authorizing coordinator or driver. Their credentials inherit that
session's task scope and become unusable when it is replaced or revoked.
Its contract supplies the immutable requirements brief, source scope/fingerprint
and permitted `artifact_ids`; it must not contain previous or peer findings.

For Codex CLI 0.167.0, a plain `--sandbox read-only` also blocks the channel's Unix
socket. Inside the verified outer namespace, use a named permission profile
retaining read-only filesystem access and permitting networking within that
namespace. The tested configuration is:

```toml
default_permissions = "herdr_channel"
[permissions.herdr_channel]
extends = ":read-only"
[permissions.herdr_channel.network]
enabled = true
[features]
network_proxy = false
```

Select this profile instead of the legacy `--sandbox` switch. When using
`--ignore-user-config`, pass these values through individual `-c key=value`
arguments. Preserve the selected model, effort and approval policy. The outer
namespace and authenticated egress relay enforce destinations; this configuration
does not provide a network boundary for an unconfined Codex process. Re-probe
socket access and denied direct network access for each selected CLI version.
The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents named permissions and explains when its network proxy enforces domain
rules. Installed-version behavior, rather than the latest documentation alone,
must determine acceptance.

The bundled review adapters verify their actual connecting process through
`context` before enabling channel access. The gateway checks its registered job
and filesystem, process, user and network namespaces; environment variables or
possession of a credential alone are insufficient. Codex then selects its pinned
read-only permission profile and removes conflicting inherited permission config.
`context` attests the trusted adapter in the registered outer launch namespace.
It is not a prerequisite for ordinary agent queries, source inspection or artifact
reads: native CLI tools may run in an additional nested sandbox, whose namespace
does not match that adapter attestation. Those ordinary operations independently
check their credential, current owner and task scope.
Claude retains safe/restricted mode and permits the fixed
`/usr/bin/python3 -B /opt/orchestration/communicate.py` command alongside its file
inspection tools. Pass the JSON as one quoted `--json` argument: the selected
Claude CLI denied heredoc calls under its narrow permission rule even though
the equivalent argument form worked. Its review prompt explicitly permits that client. Standalone
reviews retain their existing settings. Verify actual artifact retrieval with
the selected adapters; a clean report does not prove that supplied logs were read.

Bind generic wake delivery only after verifying the exact Herdr endpoint:

```sh
python3 <skill-root>/scripts/notify.py --run-dir <private-run> --actor <actor> \
  --bind-session <session-id> --endpoint <verified-endpoint.json>
```

The endpoint contains `session`, `control_pane_id` and the exact returned `agent`
identity, including `agent_session`. The trusted scheduler runs from its genuine
managed control pane. Delivery sends only a generic instruction to read the
authenticated inbox. It never embeds task contents or grants authority. Failed
recipients back off independently; new events preserve that retry state.

## Agent requests

Request objects and their results are the same in both modes. `communicate.py`
and its timing rules below are the enforced client; an unconfined caller passes
the same object to its [transport](#unconfined-runs), which accepts the message,
inbox, artifact and inbox-watch operations.

The client bounds each request across connection, response reads and retries:
ordinary requests default to 30 seconds, a single `watch` to 35 seconds, and
`execute` to 3,600 seconds. Python callers can supply a finite positive `timeout`;
CLI callers can pass `--timeout <seconds>`. The five-second reconnection window
does not extend that total deadline. The CLI repeats bounded watches for a JSON
request with `op:"watch", until_change:true` until a change or error is observed.

`request_timeout` ends observation, not execution or ownership. A mutation may
have completed or still be running. Inspect its durable result and retry only
with the original `action_id`; do not infer cancellation, create a new operation,
or launch a replacement writer merely because the response timed out.

### Review-fix execution boundary

For agent-driven review, configure a `kind:"review"` adapter with a `controller`
object instead of `argv`, `inspect_argv` or a generic `profile`. Its fields are:

| Field | Contract |
| --- | --- |
| `task_id` | The admitted task this controller may review. |
| `node`, `skill_root` | Absolute trusted Node executable and matching installed `review-fix-loop` skill directory; the sibling `panel-review` must be present. |
| `options` | Exact controller option arguments. New final reviews use `--base <integrated-target-OID>` and `--commit-mode per-round`, with the selected reviewer/model/effort options. |
| `config` | Controller configuration with command-backed reviewers, triage and repair. The runtime supplies `executionBoundary` and the operation binding. |
| `contract` | The approved controller task contract, including required validation. |
| `profiles` | Provider, triage, repair and validation profiles described below. Required validation environment must exist in its selected profile. |

The driver requests this adapter through ordinary authenticated `execute`. Before
reserving an attempt, the runtime copies and pins the matching controller skills,
pins its owner/contract/profiles, and runs the controller's source and capability
preflight. Each operation has one deterministic controller run ID. The trusted
adapter can invoke only its fixed entry point; repository/model commands still
run through the isolated execution boundary.

Retrying an issued controller operation resumes that exact controller journal
and its existing assignments. It does not start a discovery review or repeat a
completed provider invocation. Generic uncertain adapters still use their
read-only inspector. A completed operation returns its saved receipt, including
the controller phase, source fingerprint and final commit range. Only settled
`CONVERGED` is success; threshold, incomplete and uncertain outcomes remain
distinct. The controller does not push commits.

An interrupted initialization resumes from its pinned input/source record, even
before the initial journal or active reference was published. It retains the
same controller ID and counted attempt. Changed initialization inputs or source
require recovery; they cannot silently replace the original review scope.

When the original owner has been revoked or replaced, retrying the operation with
the current authorized executor adopts the existing controller after its source
jobs and assignment processes settle. The runtime records the transfer, preserves
the old policy and journal, and gives subsequent assignments a new owner-bound
policy. It never revives old credentials. A waiting control driver uses a private
workspace and does not prevent source-job settlement. Adoption of a converged
result also checks that its reviewed source still matches. When an upstream
reconciliation supplies a changed-history applicability receipt, the original
controller's full preflight must pass under the new owner's source lease before
that ownership transfer; missing or invalid applicability does not relax the check.
The controller retains the original authority fields for review-policy comparison,
so session rotation alone does not invalidate immutable reports. Other policy
inputs remain bound; actual execution always uses the current owner's policy.

If trusted host recovery changed the task identity, it clears the old delegation.
The coordinator can explicitly renew a subset of the original grant with
`delegate`, naming `recover_operation:<pending-operation-id>`. This requires the
recorded identity recovery, the same executor and otherwise unchanged ownership;
it cannot expand authority or redispatch a prepared action. Then the replacement
driver retries the original `execute` request. Interrupted adoption resumes from
its saved candidate, without resetting review history or repeating completed jobs.

If the receipt contains a controller question, send `review_answer` with
`task_id`, the original `operation_id`, a new `action_id`, its `question_id`, and
the sourced `answer`. Replays return their saved acceptance even after the
controller advances or completes; current session/delegation checks still apply,
and conflicting answers are rejected.
Then resume the original `execute` action ID. Answers and continuation use the
same gateway. Replacing the owner does not silently rebind an existing controller.

For upstream applicability reconciliation, configure another fixed-controller
adapter with `kind:validate` and the **identical** `controller` object used by the
original review adapter. The caller needs both review and validation authority.
Send a new ordinary `execute` request selecting that validation adapter, adding:

```json
{"reconcile_upstream":{"operation_id":"<original-review-action-id>","receipt":{
  "from":"<reviewed-fingerprint>",
  "upstream":{"pr":415,"head":"<published-OID>","landing":"<landing-OID>","target":"<observed-target-OID>"},
  "evidence":"<verified-landing-evidence>",
  "assessment":{
    "history":{"applicable":true,"evidence":"<assessment>"},
    "environment":{"applicable":true,"evidence":"<assessment>"},
    "tools":{"applicable":true,"evidence":"<assessment>"},
    "generatedOutputs":{"applicable":true,"evidence":"<assessment>"}
  }
}}}
```

The added object is limited to 16 KiB. The original operation must be a completed
successful review for this task. A preflight verifies applicability before the
new validation attempt is counted; dispatch rechecks it. The existing controller,
reports and original completion receipt are preserved. The new operation owns
its validation budget, task reservation and completion receipt. Retry **its**
action ID after interruption; the original review ID still returns its historical
result. The controller's journal prevents repeated applicability changes or
validation after a lost reply. Both operation locks remain held by the trusted
controller process.

To release the settled controller reference without deleting its evidence, send
`{"op":"review_release","task_id":"<task>","operation_id":"<original-review-action-id>","action_id":"<release-id>"}`.
This requires the original executor or coordinator with current review authority,
no outstanding task operation/reservation, and the controller's existing release
checks. It returns `phase:RELEASED` and `recordsDeleted:false`. Reuse the release
ID after a lost reply. Executor and reviewer credentials cannot release controllers;
the request names an operation ID rather than a caller-selected filesystem path.
Fresh releases check retained-runtime capacity before creating records and logs;
saved release receipts remain replayable without allocating another invocation.

For trusted host setup or direct disposable acceptance exercises, the underlying
boundary can also be configured explicitly as follows.

The review-fix controller itself runs on the trusted host. Configure its
`executionBoundary` with this argv, replacing the placeholders:

```json
["/usr/bin/python3", "<skill-root>/scripts/review_boundary.py",
 "--policy", "<private-policy.json>", "--policy-sha256", "<sha256-of-policy-bytes>"]
```

The private policy contains `schema:2`, this orchestration `run_dir`, one admitted
`task_id`, `owner_session`, `task_binding`, and `profiles`. `owner_session` is the
authorizing coordinator or driver's non-secret session ID. `task_binding` pins
the admitted task's `driver`, `host`, `identity`, `worktree` and `branch`; the host
constructs it with `channel.task_binding(task)`. Both are rechecked before each
launch and controller source operation. Policies without these ownership fields
are rejected. Profile keys are reviewer provider IDs (`claude`,
`codex`) and `triage`, `repair`, `validate`. Use the launch-profile schema above,
without `argv`: the controller's pinned command and model arguments are retained.
The wrapper maps absolute tool paths through the selected read-only mounts.
Supply required command environment through these profiles; ambient host
credentials are not inherited. `CI=1` and `GIT_OPTIONAL_LOCKS=0` remain forced.

Select command-backed reviewers, triage and repair, and checkout validation.
The controller rejects native assignments and copied validation workspaces in
boundary mode. Review and triage have read-only source access; repair and
validation receive their own source writer lease. The waiting controller holds
no source lease; its source inspection, inline publication, commits and recovery
steps acquire the same exclusive lease. Trusted Git children inherit that lease.
Each acquisition rechecks private Git metadata while writers are excluded.
Worker-created metadata symlinks and shared hardlinks stop host inspection and
publication before Git can follow them; admission checks alone are insufficient.
Repository Git hooks, monitors and conversion programs cannot execute on the
host through these operations; unsupported conversion/signing capabilities stop
the workflow. Completed model reports are published as immutable channel
artifacts before being returned to the controller. A changed policy hash or
boundary failure stops the command, without a host-execution fallback.
If ownership is revoked while a model is running, its bounded report remains
private recovery evidence in the launch directory. It cannot publish through
the revoked credential or become a current controller result. Job settlement
does not require reviving that credential.

The boundary converts explicitly assigned validation logs into immutable scoped
channel artifacts. It verifies the controller, validation assignment and source
fingerprint binding; arbitrary host paths and another run's logs are rejected.
Reviewers receive ordered `logArtifact`/`stderrLogArtifact` parts and use
`artifact_read` to retrieve them. Original receipt/truncation information remains
visible. These grants expose approved validation evidence while keeping peer
reports and other controller files private.

Validation receipts count raw observed stdout/stderr bytes before UTF-8 decoding.
`stdoutDecodingLoss` and `stderrDecodingLoss` record malformed or unfinished
sequences separately from retention truncation. Ordinary retained writes contain decoded
UTF-8 text, so replacement characters can make retained display bytes exceed
the original byte count. A literal replacement character is valid UTF-8.
`retained_log_complete` requires explicit absence of both truncation and decoding
loss; missing metadata cannot establish completeness. Diagnostic loss does not
change the command's exit outcome.

A partial stdout-file write followed by an error is rolled back to a complete
UTF-8 prefix when storage permits; the command remains an infrastructure failure
with its original observed-byte counts. If an older log or failed rollback leaves
invalid UTF-8, artifact export supplies only the valid prefix and sets
`retained_decoding_loss=true` and `retained_log_complete=false`. Artifact `sha256`
and `bytes` describe that delivered prefix; `retained_source_sha256` and
`retained_source_bytes` preserve the original retained-file facts. The original
file is kept, and scoped review/triage can still retrieve the incomplete evidence.

This integration requires the version-17 review-fix controller; older controllers
reject its saved runs. It still needs the full installed, selected-model and
restart/cancellation acceptance described below before release.

### Requests inside an agent

All agent roles use the same entry point. It reads the credential from its
read-only file; never copy the credential into prompts, logs or messages.

```sh
python3 /opt/orchestration/communicate.py --request - <<'JSON'
{"op":"query","task_id":"example-A"}
JSON
```

The default task query selects a full small view or a bounded compact view.
`mode:"full"` and `mode:"compact"` select either explicitly. Read `complete`,
`change_token`, revisions and `blocking_summary`; truncated content is not clean
evidence. A compact response provides a `detail_request` for its immutable
snapshot. Add `path:["task","findings"]` and optionally
`select:"unresolved_findings"` to retrieve only unresolved entries with their
original indices. Detail and artifact reads return character offsets and
`complete`; fetch remaining pages when required. Snapshots are a cache of state
that is retained elsewhere: the run keeps its 64 most recently issued, fewer
when retained storage is short. A `snapshot` error on a detail read means that
one expired; query again and use the new `detail_request`.

The coordinator's query without a task is bounded too. Its aggregate blocker
counts cover all scoped tasks, including those omitted from the preview; use
its immutable `detail_request` with `path:["tasks", "<task-id>"]` for details.
Enforced merge and closure require a settled `CONVERGED` result recorded by the
fixed controller runtime, bound to the task identity and reviewed commit. The
runtime records the controller/run references and findings; sessions cannot
replace them through `observe` or manufacture a review with `reserve`/`settle`.
A caller's clean-gate claim cannot override missing certification or an unresolved
or unclassified finding hidden by a preview. A successful `none` review of dirty
files does not certify a commit for merge: the reviewed source must also have a
verified clean commit binding. Legacy runs retain their existing behavior.
New enforced closure authorization checks the current checkout under its source lease,
including direct coordinator closure, close intent, adapter preparation and
dispatch. Source changes after certification require a fresh applicable review.
Enforced close adapters receive read-only task source (or their configured private
workspace with no source access). Recording the exact receipt of an already
issued successful closure preserves that external effect and its history.
After upstream revalidation, certification retains the latest validation operation
and the original controller operation separately. Closure uses that original
controller's pinned runtime to verify the current source. Legacy close adapters
retain their configured workspace access.

After cancellation, retry the original operation ID to inspect its outcome.
The trusted runner may launch its inspector with read-only source while new
work remains paused. This permission applies only to the dispatched operation;
a subsequent cancellation stops the inspector too. Resume still requires
settled jobs, reservations and pending effects. A pause at run or task scope lets
an already-running inspector finish; only a new cancellation invalidates it.

Validation log receipts report retained stderr bytes and whether the bounded
tail was truncated. Missing retention metadata does not establish completeness.
Reading every artifact part proves access to the retained evidence, not to any
discarded prefix of the original output.

| Operation | Use |
| --- | --- |
| `message` | Stable `action_id`, task, recipient, kind (`question`, `reply`, `update`, `assignment`) and a body up to 4,096 UTF-8 bytes. Only the coordinator assigns work. Replies name `reply_to`; larger evidence uses scoped artifacts. The result reports the message's inbox `sequence`. That is not a cursor: wait from an inbox page's cursor, or unread items before the message are skipped. |
| `inbox` / `message_read` | Read bounded events or a retained message. Missed messages and visible artifact notices remain paginated and discoverable after notification eviction. A cursor gap also requires refreshing task state. |
| `ack` | Persist retrieval acknowledgement for the task/cursor. Once nothing addressed to the caller lies beyond its acknowledged cursors, its pending [hint](#hints) is retired. This never records the requested effect as complete. |
| `watch` | Wait on a task change token or `view:"inbox"` cursor. An inbox wait ends on another party's event, never the caller's own. `until_change:true` quietly reconnects between bounded waits. |
| `artifact_put` / `artifact_read` | Publish immutable scoped UTF-8 evidence, then retrieve it selectively. Readers see it in their inbox without a hint; attach it to a message when someone must act. Keep full reviewer reports immutable. Other reviewers cannot read them before adjudication. |
| `execute` / `result` | Request a configured action or inspect the original durable action result. Preserve the same action ID after transport failure. |

Process every returned inbox page, including when `resync_required` is true. That
flag means transient state-change notices were evicted: refresh the current task
view as well.
Each page supplies `next_request`: another `inbox` read while pages remain, then
a `watch` bound to `view:"inbox"` and that page's cursor. Use it to avoid mixing
task change tokens with message cursors. A task-state watch does not signal a
message arrival; messages intentionally do not change task versions. The watch
duration field is `timeout_seconds` (0–30); unsupported fields are rejected.
The page still contains retained messages and visible artifact
notices in delivery order. Each event names its `origin`; the caller's own
messages and actions stay listed as history. Continue from its `cursor` while
`more` is true; only acknowledge a cursor after processing its page. Unsolicited updates and answered
questions remain discoverable without knowing their message IDs in advance.
Acknowledgement records retrieval, not successful application of a request.

Coordinator, driver and executor permissions differ even though the transport is
the same. Requests cannot select a caller or expand task scope. A coordinator
session covers the run's configured scope as trusted host administration changes
it, so a task added or split after its launch needs no coordinator relaunch.
Driver, executor and reviewer sessions keep the tasks they were launched for. Session
replacement fences reads, writes, waits and provider tunnels; it does not prove
that the old job or its external effect settled. Source leases and registered
job reconciliation govern replacement writers. Inspection of an issued adapter
uses read-only source access and does not redispatch the original action.
The launcher retains execution and source locks together through one private
socket owned by Bubblewrap's reaper. Lock descriptors are never passed to model
commands: a child must not be able to unlock its host's execution guard. Repeated
`--sync-fd` flags do not retain multiple protected descriptors in Bubblewrap.

Process creation runs outside the state lock. A trusted bootstrap inside the
namespace waits for an explicit start byte; EOF refuses execution. The host
retains the source lease and rechecks the session, pause/cancel state and host
verification before persisting authorization and releasing that byte. The
command's environment is applied only after authorization, so loader variables
and interpreter hooks cannot execute workspace code before this check.
Environment values are mounted from a private file, keeping profile secrets out
of host process arguments. Enforced host Git operations deny transports as well
as hooks and filters, so missing promisor objects fail without launching a
repository-configured fetch helper. The fixed controller entry applies this
process-local policy before preflight and source-lease acquisition. Standalone
legacy inspection retains configured converters and transports; hooks, monitors,
external diff and text conversion remain disabled. The private controller directory's Git
ancestor is a mount point and cannot be replaced by a source writer.
The job's `running` record identifies its launcher and start authorization, not
proof of command execution or success. A crash before namespace information is
available can leave settlement unknown; preserve the record and reconcile it
through the source lease instead of assuming the command or namespace survived.
The reconciler can settle unknown namespace evidence after acquiring the
exclusive workspace lease; it preserves an unknown outcome and never signals a
guessed PID. Provider tunnels pause forwarding during transient state-lock
contention, retry authorization for up to five seconds, and close on definite
revocation or continued uncertainty. A busy completion write leaves its operation
pending for inspection rather than treating the observed effect as rejected.

## Compatibility and rollback

The wire protocol is version `1`, encoded as an integer in both request and
response. An unknown or malformed version returns a `protocol` error; the client
does not retry it through SSH, Herdr, another client or an unconfined command.
Keep the gateway, immutable launch runtime, matching controller skills and
selected profiles pinned together. A wire-version match does not certify that
a different host/runtime still satisfies its capability receipt.

New external actions in enforced runs allow at most 256 UTF-8 bytes per action
ID; communication mutations additionally allow at most 200 characters. Choose
short opaque IDs and reuse the original ID when retrying. The trusted execution
runner may append its own dispatch/completion suffixes. Legacy action IDs and
existing receipt identities remain intact. Receipt replay still verifies the
caller, current session and original request digest before returning a result.

Older reviewer/executor credentials without an authorizing parent-session binding
return `incompatible` in enforced runs. The trusted host must issue a replacement
bound to the current coordinator or driver; missing authority is not inferred
from the actor name. Existing job records remain available for settlement.

Earlier retained messages/artifacts may lack delivery sequence numbers. Direct
authorized reads preserve that evidence. If their original events have been
evicted, inbox recovery returns `incompatible` rather than inventing an ordering
or skipping unseen messages. Pause/cancel and direct evidence reads remain
available. Preserve the run and its matching runtime for recovery; do not erase
the history or reset its cursor to manufacture compatibility.

Rollback drains an enforced run using its existing pinned runtime:

1. Send `control:finish_current` through the coordinator's authenticated helper,
   with a stable action ID and current policy version. This stops new task
   admissions while admitted work can finish.
2. Keep that run's gateway, runtime, profiles and private state available while
   jobs or uncertain effects remain. A gateway restart uses the same endpoint
   directory; it does not replace running agents' credentials or boundaries.
3. If work must stop, send `control:cancel` and reconcile registered jobs and
   uncertain operations with their original IDs. Confirm settlement before
   removing the old installation. A missing reply does not prove non-execution.
4. Start subsequent runs using the selected matching installation. Never change
   an existing run to `legacy`, restore an older state file over live jobs, or
   silently substitute another controller/runtime for recovery.

The configuration API rejects changing an existing run's communication mode.
Unconfined runs keep their existing interface and reach the message protocol
through it. Upgrading one into enforced execution is not an automatic migration
provided by this release.

## Retained protocol capacity

Enforced initialization creates a private storage budget before accepting work.
`communication.storage` can override `max_bytes` (256 MiB), `reserved_bytes`
(16 MiB), `max_files` (8,192 retained objects), `reserved_files` (256) and
`max_state_bytes` (4 MiB). Reservations conservatively include atomic-write
temporaries and metadata; these are accounting limits, not a filesystem quota.
They cover state, action receipts, communication artifacts, view snapshots and
immutable review contracts. New enforced sessions retain contract bodies in
`review-contracts/<sha256>.json`; session state keeps the digest and the small
identity/artifact grant fields needed for authorization. Reads verify the digest
and recheck session authority. Revocation retains the contract, identical bodies
share storage, and old inline contracts remain readable. Session metadata and
contract bodies still consume finite capacity; this provides no automatic GC or
quota increase. Launch admission includes the proposed contract's write peak.

Generic execution acquires its required task-source lease before issuing a
child credential or allocating a launch tree. Repeated refusals while that lease
is occupied therefore consume no child sessions, launch trees or task attempts.
The lease uses the same resolved physical checkout as launch preparation,
preserving supported legacy checkout aliases without changing task bindings.
New execute work also checks the same read-only admission gates used by the
locked reservation: pause/cancel, holds, dependency completion, authority,
delegation, cutoff, attempt budget, references and slot capacity. Deterministic
refusals at those gates allocate no child session or launch tree. Prepared but
unissued operations recheck their dispatch authority before provisioning;
already-issued operations retain their original recovery inspection path.
These preflights do not reserve authority: the state transaction and process
start still recheck it, and a concurrent change can still refuse a prepared
launch. Controller children acquire their source lease and check pause/cancel
before provisioning or exporting validation artifacts, retaining that lease
through the child process. Their outer review attempt remains the counted unit.

The separate `communication.runtime_storage` admission check counts the entire
private run directory and admitted task checkouts, including retained job homes,
runtime copies, execution directories and logs. It also counts a proposed checkout
before admission. Defaults are `max_bytes`: 8 GiB, `reserved_bytes`: 64 MiB,
`max_files`: 250,000 entries, `reserved_files`: 1,024 and `min_free_bytes`: 64 MiB
on each involved filesystem. Each entry charges at least 4 KiB, with larger logical
or allocated sizes charged in full. Symlinks are counted but not followed.

New admissions, handoffs, operations, process starts and trusted runtime/home
copies refuse insufficient capacity with `runtime_capacity`. An inspection failure
returns `runtime_capacity_unknown`; neither result permits fallback. Trusted copies
serialize their capacity checks and allocation outside the global state lock.
Coordinator provisioning can use the reserved headroom. Reads, pause/cancel and
exact receipt replay remain available without a fresh capacity scan. Changed
checkout membership during a scan requires a retry (`runtime_capacity_changed`).

This is a stop-new-work policy, not a filesystem quota: running commands,
in-flight writes and unrelated host processes can still consume space after a
check. Recovery invocations of an existing operation can retain additional logs.
Use an OS-enforced quota if the deployment requires a hard total write limit.
Capacity refusal preserves existing evidence and does not automatically prune it.
Stop new admissions and preserve the run for reconciliation; deleting receipts
or the protocol ledger is not a supported way to recover capacity.

Each enforced adapter or host-controller invocation retains at most one MiB of
stdout and one MiB of stderr. The host drains both streams through pipes, so the
child cannot seek past the limit in a log file. Receipts identify retained and
observed byte counts, truncation, write errors and completeness. Incomplete
capture cannot substantiate success, even if its prefix parses as a successful
JSON result. A command may already have had an effect; an output or settlement
I/O error therefore remains unknown unless its durable job proves non-start and
settlement. Retry the original operation for inspection, not a new dispatch.
These per-invocation limits complement the aggregate admission check; they do
not impose a filesystem quota. Explicit legacy adapters retain their existing
output interface.

Ordinary work cannot consume the reserve. Recovery receipts and replies can use
its first half; the final half is reserved for pause/cancel, trusted coordinator
replacement and terminal observations of already registered jobs. State growth
has analogous recovery headroom, capped at one MiB. New job registration uses
ordinary capacity. These finite reserves do not promise availability through a
physically full or failed filesystem, or unlimited control requests.

`storage_capacity` stops the attempted new write; it does not discard old
receipts, unresolved questions or immutable evidence. Existing receipts and
artifacts remain readable and exact action replay requires no new reservation.
A query that needs a new snapshot first expires older snapshots, and reports
capacity exhaustion only when that still leaves too little room. Retrying a
mutation uses the same action ID; changing IDs creates new retained receipts.
Do not delete the ledger or old receipts to recover space: reservations survive
crashes conservatively and are not silently reclaimed. View snapshots are the
one exception: their storage is returned as they expire. An older enforced run
without its budget must resume on its compatible runtime, not acquire an
invented empty ledger.

Gateway handshakes do not wait on authoritative state. Authentication and job
reconciliation run outside the accept loop, with finite state-lock waits.
A `watch` and the gateway's own maintenance read state again only after it is
written, so idle waiters neither hold the state lock nor slow a control request.
`state_busy` reports contention without claiming success; retry the same action
ID or cursor. Runtime hashing and Git metadata scans for admission, handoff and
job start run outside the global state lock while retaining the checkout lease.
The commit checks the current authority, host receipt, ownership and fixed file
metadata again; a concurrent pause, replacement or re-verification cannot be
overridden by the earlier scan. Reserved request slots and bounded lock waits
still do not guarantee latency through slow or failed state storage.

## Acceptance and limitations

Exercise the installed path with successful model, build and review work, denied
alternate routes, two tasks, gateway restart, cancellation and session replacement.
Keep unsupported hosts outside enforced admission. A standalone read-only review
adapter does not prove that the full controller's repair, validation and later
independent review work through the configured boundary.

The paired `live_workflow.py` check first runs the existing `live_controller.py`
probe against the same installation, private profiles and selected review models.
Both providers must retrieve nonce-bearing validation output, with matching
runtime hashes, before the pair can proceed. Missing, incomplete or stale proof
fails the check. Probe artifacts are retained separately, and its time and usage
are excluded from the full/automatic variant comparison. A `--variant` run is
diagnostic and cannot establish `paired_acceptance`.

The launcher hides `.git/jig` from source workers and reviewers because it can
contain the controller's previous and peer reports. Pass required evidence through
the scoped channel. This makes the existing controller's host integration a
separate requirement; running the entire controller inside a reviewer launch
cannot work because it needs private state writes and separate repair authority.

The trusted enforced scheduler refreshes integration on cadence independently of
generic hint delivery. Its health checks report overdue observations and pending
delivery, not proof that an agent applied a request. Application remains a task
outcome with evidence.

The development benchmark `plugins/jig-orchestration/benchmarks/communication.py`
compares full and automatic retrieval using an explicitly named tokenizer. Its
counts include follow-up requests and responses, but exclude model context,
provider cache accounting and billing. End-to-end savings require paired runs
with exact selected models, settings, success criteria and latency measurements.
Repeated reads of an already-complete artifact can dominate wire measurements.
Stop pagination when `complete` is true; `next_offset` can remain at the end of
the artifact. Gateway payload tokens are not equivalent to model input tokens.
