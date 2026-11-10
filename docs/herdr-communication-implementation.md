# Enforced orchestration communication

Implementation record for the user-requested P1–P3 change. This is an active
implementation plan, not evidence of completed enforcement or token savings.

## Contract

All agent-issued orchestration instructions, messages and authoritative transitions
use one authenticated helper protocol. Neither workers nor the coordinator model
can access administrative state, other sessions' credentials, or Herdr delivery
directly. A trusted runtime owns those capabilities. Source and review artifacts
remain data and cannot confer authority. This does not promise elimination of
covert information channels in shared source artifacts.

Existing unconfined runs retain their current interface and are explicitly distinct
from enforced runs. New enforcement must fail closed; it must not silently use
the host shell, a different transport, or weaker reviewer settings.

## Evidence and decisions

- `supervise.py:serve` authenticates a configured actor through an external SSH
  binding; local `apply` assumes coordinator authority. Same-user private file
  permissions alone do not distinguish a worker from the administrator.
- `recover_session` clears grants but a reused actor transport is not itself a
  session credential. Enforced sessions need revocation checked inside mutations,
  including before returning an idempotent result.
- `execute.py` invokes configured adapters under the caller's OS privileges.
  Untrusted repository code must execute inside the worker boundary.
- Linked worktrees share Git metadata. Each enforced task requires private writable
  Git metadata, selected at admission; review preserves that selected checkout.
- The current Herdr delivery API has no atomic native-session precondition.
  Delivery therefore carries only a generic hint; authenticated retrieval owns
  task contents and authority.
- The existing validation sandbox has a different exposure policy. Do not reuse
  a read-only bind of the host root as the credential isolation boundary.

## P1 — Execution boundary

Depends on: none.

Add a Linux launcher using an empty filesystem/network/process namespace and
explicit mounts. Expose the selected task checkout, private session home, immutable
runtime/client, and authenticated helper socket. Provider access, where required,
uses an explicitly permitted egress relay, not host-network access. Do not expose
the host home, runtime state, administrative sockets or sibling workspaces.

Add launch-specific credentials bound to actor, task, host and session generation.
Replacing/revoking a session fences mutations, reads and existing waits. Jobs have
separate durable identities so trusted reconciliation can settle old work.

Verify actual subprocess denial of host canary reads, state mutation, sibling and
socket access, and stale credentials, alongside successful edit/build/review work.
Exercise the installed launch path. Unknown capability is not enforced capability.

## P2 — Canonical protocol and recovery

Depends on: P1.

Extend the helper for scoped coordinator/driver operations, private question/reply
messages, scoped immutable artifacts, and cursor-based retrieval/waits. Derive
state notifications in the same transaction as the transition. Persist notification
intent before delivery; a wake is not consumption or completion. A lost reply must
not repeat an external effect. Preserve controls and registered jobs through restart.

Verify two concurrent tasks, independent reviewer outputs, pause/cancellation,
session replacement with surviving jobs, and process crashes around persistence,
notification and acknowledgement. No lock spans a wait or external operation.

## P3 — Compact responses and rollout

Depends on: P2.

Add deterministic bounded views with version/completeness information and selective
artifact reads. Preserve holds, unknown evidence, unresolved findings and source
bindings. Original reviewer reports remain immutable and available in full.

Measure full versus compact workflows, including follow-up reads, using an actual
tokenizer and explicit model/version identity. Measure real model usage where
available separately from deterministic payload token counts; never label bytes as
tokens or payload savings as proven billing savings. Keep success, delivery time,
recovery and coverage alongside cost. Re-run meaningful tests after changes.

## Release boundary

Do not replace active installed skills or migrate live runs during development.
Run the repository's orchestration and installation suites, exercise real selected
review adapters in the disposable environment, and inspect the final diff. Release
claims must identify platform coverage and any missing live evidence. A clean code
review alone does not certify host configuration.

## Shaping audit — 2026-11-08

The following probes exercised the current, incomplete implementation in disposable
local state. They are failure evidence, not a completed panel review:

- The focused channel suite ran 12 tests: 11 passed and one failed. The real
  edit/build/report test could not execute `cc`: `/usr/bin/cc` points through
  `/etc/alternatives/cc`, which the sandbox does not expose. Merely mounting
  `/usr` does not establish a usable toolchain.
- An isolated client queried successfully, then received `ConnectionRefusedError`
  after the gateway restarted at the same pathname. A newly launched sandbox
  using the same credential succeeded. Binding the socket inode into a running
  sandbox prevents it from following endpoint replacement.
- Opening 64 idle local connections exhausted the gateway's connection capacity;
  an authenticated coordinator pause request returned `busy`.
- A reviewer credential could retrieve a sentinel finding previously recorded in
  its task. The general task view exposes prior findings, so separate credentials
  and contexts alone do not preserve independent review inputs.

### Changes to acceptance criteria

| Phase | Failure to prevent | Required evidence |
| --- | --- | --- |
| P1 | An alternate tool or child bypasses the boundary | Exercise the installed coordinator, driver, reviewer and descendant launch paths. Deny direct Herdr, mail/native messaging, host shell, arbitrary MCP dispatch and credential access at their execution boundary; hiding tool descriptions is insufficient. Trusted adapters must not execute repository code with host authority. |
| P1 | Isolation makes ordinary work impossible | Run the selected real build and review commands, including tool symlinks, private Git metadata, provider authentication and bounded egress. Reject unsupported configurations without falling back to an unconfined process. |
| P1/P2 | Replacement credentials leave an old writer active | Revoke old requests, including waiting and retried requests, while separately reconciling durable jobs. Do not admit a replacement writer until the old writer and descendants have stopped or lost write access. |
| P2 | Restart strands running clients | Keep only the endpoint directory visible to sandboxes, separate from private run state, or use an equivalent stable endpoint mechanism. Prove a running client reconnects after gateway replacement without obtaining another session's authority. |
| P2 | Bulk traffic prevents control | Bound unauthenticated handshakes, connections, waits and artifact work; reserve authenticated control capacity within the same protocol. Prove pause/cancel remain serviceable under a noisy actor. |
| P2 | Delivery is mistaken for completion | Distinguish durable acceptance, retrieval acknowledgement and applied effect. Crash around each boundary, redeliver the same ID and reconcile uncertain external effects before another attempt. Cursor gaps require an explicit resynchronization response. |
| P2 | Private review data leaks through a general query | Give reviewers only the pinned brief, selected source scope and explicitly permitted evidence. Deny prior/peer findings through task views, messages, artifact IDs and shared paths until reports are frozen. Preserve raw reports for later adjudication. |
| P3 | Compression hides a blocking fact or increases total work | Retain holds, uncertainty, unresolved findings, revisions and completeness. Test decisions with facts beyond the first page, stale cursors and follow-up reads. Full evidence remains available through the same authorized protocol. |
| P3 | Cheap payloads are presented as cheap successful runs | Compare the same tasks and pinned model/runtime settings using full and compact views. Include tool schemas, retries, repeated context, follow-up reads and failures; report provider usage/cache categories when available, success rate and tail latency separately. |

The gateway is one protocol, not one FIFO for all work. Host emergency recovery
remains outside model authority; adding a second model messaging path to recover
from overload would defeat the communication contract.

Enforcement means all agent-issued orchestration commands and authoritative state
changes pass through the gateway. Shared source, build output and permitted
external services can still carry information. Do not claim elimination of all
covert communication. Those inputs cannot themselves grant authority. Provider
access also needs a scoped policy; allowing a hostname alone does not constrain
every operation offered by that service.

### Panel review and rollout

Use the existing panel contract: the same immutable requirements brief and pinned
source scope for every selected reviewer, fresh contexts, private reports until
freeze, and source/brief fingerprint checks before adjudication. Express the brief
as required observable behavior, not a list of the integrator's suspected bugs.
The integrator separately checks every known failure above against the resulting
implementation and evidence. Do not require reviewer agreement to retain a
reproducible failure, or count an unavailable reviewer as a clean vote.

The code panel and runtime acceptance answer different questions. In addition to
review, require an installed-launch exercise with two concurrent tasks, a live
gateway restart, session replacement, overload, a blocked alternate route and
successful legitimate build/review work. Keep this on disposable owned fixtures.
Pin the skill/runtime/protocol versions for the run; incompatible clients must
stop clearly rather than select the legacy route. Do not relabel an active legacy
run as enforced. Rollback stops new enforced admissions and preserves uncertain
jobs and evidence for reconciliation.

### Current external evidence and its limits

- [Anthropic, How we contain Claude across products](https://www.anthropic.com/research/how-we-contain-claude)
  (2026-05-25) distinguishes model behavior from environmental capability limits
  and describes failures in surrounding integration code. This supports testing
  the complete launch and tool path, not a guarantee about this implementation.
- [Anthropic, Improving our alignment and security efforts](https://www.anthropic.com/news/improving-alignment-security-efforts)
  (2026-08-31) reports misconfigured evaluation environments and describes checking
  containment before runs. Its reduced-safeguard cyber evaluation setting differs
  from ordinary coding work; it is evidence about operational failure modes.
- [ParallACT, Decentralized Multi-Agent Coordination and Communication in Shared Codebases](https://arxiv.org/html/2611.00314v1)
  (submitted 2026-10-30; preprint) evaluates Claude Opus 4.8 and three open-weight
  models across two harnesses. Adding communication incurred token cost without
  closing the coordination gap. It studies decentralized, separately motivated
  tasks, so it does not prove the best topology for Herdr. It motivates checking
  whether agents retrieve and act on messages, and measuring joint task success.

Publication year alone does not establish relevance. Record the model, harness,
task family, topology and cost measurement behind each claim. Savings for this
implementation remain unproven until measured with the selected deployment models.

## Implementation checkpoint — 2026-11-08

Implemented primitives, still short of the release contract:

- `channel.py` binds credentials to launch generations and task identity, rejects
  administrative operations and coordinator identity-rebinding through observations,
  and fences cached mutation results after revocation.
- `gateway.py` uses bounded nonblocking handshakes and separate authenticated
  control/work/wait/provider capacity. Its isolated endpoint directory survives
  socket replacement. Reviewer queries no longer expose general task findings.
- `protocol.py` adds private coordinator/driver messages, question/reply binding,
  immutable scoped UTF-8 artifacts, chunked reads, retained question lookup,
  acknowledgement and explicit cursor-resynchronization responses. State-change
  events and pending wake records commit with Engine actions in the existing journal.
- `isolation.py` constructs the Linux filesystem/network/process boundary, fixes
  public compiler aliases, and snapshots runtime bytes consistently. The coordinator
  has a private empty workspace rather than access to the task checkout.
- `egress.py` adapts HTTPS CONNECT to session-scoped gateway tunnels, validates
  exact DNS destinations and public resolved addresses, bounds buffers and closes
  existing tunnels on revocation. Provider credentials have not yet been provisioned
  for an actual model/reviewer run.
- `jobs.py` records launches independently of model sessions, retains workspace
  leases in Bubblewrap's reaper, observes namespace teardown before settlement,
  and uses verified PID descriptors for cancellation. Launcher loss preserves an
  unknown operation outcome while permitting recovery after local processes stop.

Verification at this checkpoint includes an intermediate 291-test orchestration
regression pass, targeted socket/sandbox/job tests, and journal write-fault injection.
The write-fault tests exercise durable recovery but are not power-loss tests. A live
HTTPS request from inside the sandbox reached OpenAI and returned the expected 401
without credentials. Actual installed binaries also ran inside it: Claude Code
2.1.319, Codex CLI 0.167.0 and Node 22.23.2. Version probes and HTTPS connectivity do
not establish that authenticated model/review work succeeds.

Required work remains:

1. Complete P1's installed launch/profile integration and authenticated real model
   and selected review-adapter exercises. Route repository execution through the
   boundary; the existing configured adapter path must not retain a host escape.
   Bind the enforced mode to admission and host capabilities without relabeling
   or changing active legacy runs.
2. Finish P2's runtime integration: deliver only generic Herdr wake hints from the
   durable outbox, include meaningful integration observations in event publication,
   preserve full reviewer brief/scope bindings, and exercise the complete two-task
   workflow through restart/cancellation rather than only its component protocols.
3. Implement P3's deterministic compact views and complete/fenced detail retrieval,
   followed by tokenizer and real-usage comparisons on the selected models. Keep
   correctness, coverage and latency alongside cost; report unsupported evidence.
4. Update the skill's routing and references, installer/version/CI contracts, then
   run final regression, installed-runtime acceptance and the required review
   against the final scope. No active installed skill or live run has been migrated.

## Final shaping pass — 2026-11-08

This pass audits the incomplete implementation and its release criteria; it is not
the final independent panel review. The 30 focused channel, egress, job, profile,
protocol and view tests passed with `JIG_ORCHESTRATION_REQUIRE_ISOLATION=1`.
Passing those tests does not cover the following newly reproduced failures.

### New direct observations

- **Wake starvation:** in disposable state with a failing coordinator endpoint
  and a healthy driver endpoint, three consecutive `notify.deliver` calls all
  selected the coordinator and returned `unconfirmed`. The healthy driver's wake
  remained pending. The current selection loop takes the first bound pending
  actor on every call. Delivery needs fair selection and bounded per-recipient
  retry timing that survive a runtime restart. New events must not erase the
  retry state and let one failing or noisy recipient dominate the loop.
- **Scheduler stop bypass:** with `scheduler.enabled=false` and communication
  mode `enforced`, `supervise.tick` made both the identity lookup and prompt calls
  and reported `delivered`. Herdr calls were mocked; no real pane was contacted.
  The early enforced-mode return skips the established stop and heartbeat checks.
  Enforced-mode integration must retain scheduler stop/start and health semantics,
  with tests on that branch rather than relying on the legacy scheduler suite.
- **Small-view overhead:** the same admitted task serialized to 1,300 bytes in
  full mode and 1,593 bytes in compact mode, including the new metadata. These are
  JSON bytes, not model tokens or billed usage. P3 needs small and large cases,
  whole-session measurements and follow-up reads. A compact representation is
  not inherently cheaper; retaining a full small response is a valid outcome.

These observations remain open implementation work. They are not fixed by this
shaping update, and the earlier passing test count must not be presented as
covering them.

### Remaining acceptance risks

| Phase | Pitfall | Required observable result |
| --- | --- | --- |
| P1 | Tested launcher differs from the installed entry point, or a new provider/tool child runs outside it | Start through the installed skill and selected profiles. Exercise coordinator, driver, worker and reviewer, including a descendant tool. Record boundary denials and successful legitimate work. Reject unsupported configurations before admitting work. |
| P1/P2 | A control driver holds the source writer lease while synchronously requesting a worker or reviewer that needs that lease | Exercise implement → settled handoff → review → repair → review on one task while another task progresses. A controller that waits for task executors must not retain their source lease. A failed preflight must not consume an attempt or leave a falsely issued operation. |
| P2 | Durable delivery works but agents ignore messages, repeatedly wake themselves, or disagree on whether a question is answered | Verify a requested interface change is actually used by the dependent task. Keep acceptance, retrieval, reply and effect distinct. A wake alone is never progress or completion. Coalesce redundant hints without dropping unanswered questions. |
| P2/P3 | Long runs exhaust storage or make control operations slow despite bounded response sizes | Bound retained messages, snapshots, logs and artifact growth, or stop new admissions explicitly when the supported budget is reached. Preserve unresolved questions, uncertain effects and pinned review evidence. Exercise control latency after sustained traffic, including state-lock and disk contention: reserved request slots do not reserve either resource. Retention must not erase deduplication records while their effects can still be retried. |
| P3 | Unknown evidence or a late unresolved item is hidden behind a short preview | Expose a completeness signal and blocking/unknown summary, and enforce readiness on authoritative state. Verify decisions with the important item beyond every first-page limit. A short response cannot authorize an operation the full state rejects. |
| Panel | Reviewers agree because they received the same incomplete brief, previous findings, or a scope excluding new files | Give every selected reviewer the same requirements-based brief and complete pinned scope, including untracked implementation files. Keep reports private until frozen. Check source and brief fingerprints before adjudication. Preserve reproducible findings even without consensus. |
| Rollout | Protocol/profile drift or rollback silently returns agents to the legacy route | Pin runtime, skill, protocol and profile identity in acceptance evidence. Test incompatible client rejection and rollback with a surviving job. Rollback stops new enforced admissions; it does not weaken running sessions or discard uncertain outcomes. |

Do not turn these criteria into a new workflow framework or another communication
service. They tighten the existing P1–P3 work. The release decision combines one
independent panel review of the final scope with runtime acceptance and a paired
full/compact workflow comparison. Report unsupported or unmeasured cases as such.

The 2026 external sources above were rechecked during this pass. ParallACT is
particularly useful as a warning against treating an available channel as proof
of coordination, but its Opus 4.8 results in an orchestrator-free setting cannot
establish savings or success for the selected deployment models and this runtime.

## Implementation checkpoint after shaping — 2026-11-08

This section supersedes the earlier open-work descriptions where explicitly
identified below. It does not close the P1–P3 contract.

Implemented and exercised:

- Generic hint delivery now records attempts before I/O, rotates among recipients,
  retains independent retry deadlines across new events, and respects scheduler
  stop. Enforced ticks retain heartbeat and periodic integration refresh. Their
  health check distinguishes stale observations and failed delivery from agent
  application progress; it does not manufacture a legacy wake completion.
- Configured adapter execution goes through isolation, with profile and source
  lease validation before reserving the attempt. Inspection of an uncertain
  issued action reads the original outcome without repeating the effect. Launch
  profiles validate nested fields before provisioning credentials.
- Task views choose full output for small state and bounded previews for large
  state. The coordinator's aggregate query is bounded too. Immutable selective
  reads preserve late unresolved findings. Enforced merge and closure consult
  stored findings rather than accepting a caller's clean-gate claim alone.
- Private review-fix state under `.git/jig` is hidden from source workers and
  reviewers, including reports created after a reader starts. A read-only mount
  by itself had not provided this confidentiality boundary.
- The existing review-fix command runner accepts a pinned `executionBoundary`
  for every executable role, including validation and prerequisites. It rejects
  native assignments in boundary mode. `review_boundary.py` gives each command a
  scoped session and source lease, retains bounded report bytes, publishes model
  reports through the channel and revokes the session afterward. Controller run
  version 17 prevents older controllers from silently ignoring this boundary.
- A deterministic provider exercised the actual controller through review,
  source repair, validation and fresh review to `CONVERGED`. The processes ran
  inside the boundary and denied host-state and prior-report access. This is a
  real controller/process test with a synthetic provider, not a live-model
  end-to-end delivery result or a final independent panel review.

Measurement evidence is in `plugins/jig-orchestration/benchmarks/results/` and
its README. Both selected live models retrieved the two late findings correctly
in full and automatic modes. Claude Code 2.1.319 (`opus`, `xhigh`, observed model
`claude-opus-5-5`) used 17,429 versus 5,029 gateway payload tokens. Codex CLI
0.167.0 (`gpt-6-astra`, `xhigh`; no observed model ID in usage events) used 34,667
versus 1,518. Counts use tiktoken 0.12.0 / `o200k_base`. Provider input, cache and
output usage are recorded separately. These are one paired retrieval probe per
provider, not proof of billing savings. Codex automatic retrieval was slower
(36.58 versus 22.52 seconds) and generated more output tokens (1,164 versus 640).
The initial failed Codex run is retained: native read-only permissions denied the
Unix socket; the corrected profile passed socket, host-file and direct-network
probes inside the outer boundary.

An intermediate orchestration regression passed 321 tests. Later focused checks
passed 40 tests. An earlier temporary installation passed 46 focused tests and
the installation/evaluation suites passed 53 tests. Those counts refer to their
tested source states, not a frozen final release: the controller boundary and
subsequent changes require their own regression and fresh installation checks.

Required work still includes:

1. Complete admission/host capability binding and the configured controller's
   orchestration lifecycle. Audit controller-owned inline repair publication,
   commits and recovery against source leases; isolated child commands alone do
   not prove those host transitions are serialized or cancellation-safe.
2. Exercise the complete installed workflow with two concurrent tasks, actual
   selected model adapters, restart, cancellation and session replacement.
   Verify that a dependent task uses a requested interface change; successful
   retrieval or acknowledgement alone is insufficient.
3. Bound retained messages, snapshots, artifacts, sessions and execution logs,
   and prove control remains usable at capacity. Current response and report
   limits do not bound total run storage.
4. Finish runtime/client compatibility and rollback acceptance, version the
   plugins, rerun affected regressions and installation checks, then freeze the
   complete source scope for the independent panel. No active installed skill
   or live run has been migrated. P1–P3 remain open until this evidence exists.

Subsequent acceptance in the same block: a fresh temporary installation passed
32 focused tests, including the actual installed controller and launch boundary.
The version-17 load/release compatibility tests passed. A disposable controller
run with live Claude (`opus`, `xhigh`) and Codex (`gpt-6-astra`, `xhigh`) reviewers,
deterministic triage/repair, and `commit-mode=none` reached `CONVERGED` in 79.14
seconds. Both providers completed; all nine isolated jobs settled; eight reports
were published as channel artifacts. One malformed model report was retained
and retried. This adds live reviewer/controller evidence without proving the
remaining multi-task, storage, publication, rollback or final-panel requirements.
The final broad regressions were restarted against the stable version-17 source;
the earlier review-controller run crossed the format change and is not valid
regression evidence.

## Remaining ownership and acceptance pitfalls — 2026-11-08

A disposable-state probe issued a driver credential and an independent reviewer
credential, then replaced the driver credential without changing the task's
identity. `channel.check` rejected the previous driver but still accepted the
reviewer's `artifact_put`. This directly demonstrates that actor-generation
revocation does not transitively revoke other actors; it does not demonstrate a
source-write bypass. The controller boundary policy currently pins the task and
profiles, but does not identify the authorizing driver's session generation.

Before completion, bind controller authority and derived sessions to their
authorizing session and the admitted task binding. Recheck both when launching,
publishing and acquiring a source lease. Replacement must prevent old controllers
from minting new authority. Preserve durable job settlement independently; retain
late results as historical evidence without accepting them as current-generation
review or completion evidence. Verify replacement during launch, an active review,
and pending publication, including a replacement with unchanged task identity.

Additional release checks belong in the existing P1–P3 acceptance exercise:

- **Authority versus information:** authentication identifies a sender, not the
  truth or authority of its claims. A message, report or compact view cannot grant
  permissions or satisfy a consequential gate by assertion. Source files and
  permitted provider services can convey information outside the message protocol;
  the supported guarantee is one enforced orchestration authority path. Domain
  allowlisting alone does not restrict accounts or API operations.
- **Useful independent review:** reviewers must be unable to read peer reports
  while retaining access to explicitly selected validation evidence. Bind that
  evidence to the reviewed source and command, expose it through scoped artifacts,
  and reject missing or stale evidence rather than interpreting it as a passing
  check. Hiding `.git/jig` alone proves neither property.
- **Whole-system pressure:** bound total retained data and verify control latency
  under authenticated traffic as well as idle connections. Garbage collection must
  preserve unresolved questions, uncertain effects and evidence pinned by an active
  review; at capacity, reject new bulk work while allowing control and recovery.
- **Independent release evidence:** freeze the complete source and requirements
  before the panel. After repairs, refresh affected review and installed-runtime
  evidence; a review of an earlier scope cannot approve later changes. A clean
  panel cannot substitute for the two-task restart/replacement/cancellation test
  or for proof that a dependent task actually uses a communicated interface change.

The recorded Codex retrieval pair took 22.52 seconds in full mode and 36.58 seconds
in automatic mode, despite gateway payload counts of 34,667 and 1,518 tokens.
This is one pair, not a latency estimate or billing result. Keep successful joint
task outcomes, complete provider usage and retries alongside payload measurements;
repeat matched trials with order/cache effects recorded before claiming a cost or
latency advantage. Pin model and runtime identity because publication year alone
does not make external results transferable.

This audit adds acceptance requirements, not completed enforcement. The final
independent panel and the outstanding implementation work remain open.

## Ownership and publication implementation — 2026-11-08

The ownership gap above is now fixed for new enforced launches. Child sessions
require a current root coordinator/driver owner; replacement, revocation, route
removal and task rebinding fence child requests, including cached results.
Issuance rechecks the task binding under the state lock. Controller policy schema
2 pins its owner session and original task binding, and checks both for launches
and source operations. Late reports remain bounded private recovery evidence;
they cannot become current channel artifacts. Durable jobs still settle without
reviving a revoked credential.

Behavioral checks passed for stale-owner rejection, surviving writer settlement,
replacement writer exclusion, pause/cancel, and source-lease retention after a
controller parent exits. An actual controller completed inline repair, per-round
commit, validation and fresh review with a deterministic provider. Its first
host-canary run exposed a Git attribute check invoking the configured filesystem
monitor; that call now uses the same non-executing Git policy, and the rerun
converged without invoking the monitor or hooks. Executable clean filters are
rejected without running. Fingerprint configuration probes retain the existing
asynchronous deadline/cancellation handling; all 17 fingerprint tests passed.

A fresh disposable installation passed 50 channel, job, profile, controller,
execution and protocol tests in 82.61 seconds. Its installed scripts matched the
current source bytes. Broader affected regressions are still being checked.
This checkpoint does not close admission/host capability
binding, the authenticated controller execution entry point, approved validation
artifact access, total storage bounds, runtime compatibility/rollback, complete
two-task acceptance, release versions or the final independent panel.

## Authenticated controller workflow — 2026-11-08

Configured `review` adapters now support a fixed trusted controller entry point.
The runtime pins the task, owner, contract, profiles and copied matching review
skills before dispatch. It runs source/capability preflight before consuming an
attempt, then creates or resumes the exact operation's deterministic controller
ID. Arbitrary host adapter commands are not permitted on this path. Every model,
repair and validation command continues through the isolated boundary. Ordinary
uncertain subprocess adapters retain read-only inspection; the built-in
controller recovers its existing journal and owned assignments.

Four behavioral tests passed in 82.28 seconds: authenticated review through
repair/commits/convergence with cached completion, occupied-source preflight
without attempt consumption, controller SIGKILL followed by same-journal recovery
without another invocation for a review slot, and question/answer/resume through
the canonical gateway. Required validation environment came from its pinned
profile, and reviewer processes retrieved approved validation output through
the channel. These are real controller/process exercises with a deterministic
provider, not live-model or full-batch acceptance.

Approved logs are now scoped immutable artifacts with explicit source/receipt
bindings, ordered parts and retained-truncation status. A separate check
reconstructed a multi-part UTF-8 log while denying peer-report access and an
arbitrary host path. Raw controller paths remain hidden. These changes address
the previously missing execution entry point and approved-log access; recovery
across owner replacement and all remaining release criteria still need their
full acceptance evidence.

The preceding source state passed 344 orchestration tests, 35 Git-publication/
fingerprint tests, and 103 review-controller tests. Those runs preceded or crossed
subsequent adapter edits and do not establish a frozen final release. Fresh
installation checks for the new controller workflow passed 24 controller,
protocol and boundary tests in 156.19 seconds; the corrected delivery/execution/
state regression passed 133 tests in 89.03 seconds. These are deterministic
provider checks, not a final independent panel or live two-task acceptance.
Admission/capability binding, aggregate storage bounds, runtime compatibility/
rollback, the installed two-task live exercise, release versions and final
independent panel remain open.

### Release scenarios sharpened by the final shaping audit

- **A delayed retry after progress:** a disposable gateway/controller probe
  accepted a question answer, converged, then rejected an identical answer retry
  with `answer must name the pending controller operation`. The pending-operation
  check currently precedes retrieval of its durable answer receipt. No duplicate
  answer was applied, but a delayed client cannot recover the original success
  through that operation. Require receipt lookup after completion, with current
  authorization checks and conflicting-input rejection preserved. This is a
  reproduced open defect; the existing question test retries only before resume.
- **Safe fencing without usable handover:** retaining the original owner in the
  controller policy correctly rejects a replaced owner. Acceptance must also show
  that a new authorized owner can reconcile settled old jobs and continue the
  same operation without deleting its journal or replaying an uncertain effect.
  Include interruption between controller-directory creation and publication of
  its initial run/active reference. That initialization window is a code-inspection
  risk, not a reproduced crash result in this pass.
- **Control capacity below the request queue:** gateway authentication reads state
  before assigning a request to its reserved group; reads and journaled writes
  share an exclusive state lock. Require bounded pause/cancel latency with growing
  state and slow storage, alongside the existing connection-overload checks.
  This observation does not establish a measured latency failure.

The final panel must review these requirements against the frozen complete
candidate and preserve the distinction between static findings, deterministic
process tests and selected-model workflow evidence. After a repair, refresh the
affected review and runtime evidence against the resulting candidate. Passing
the panel alone does not close the outstanding runtime acceptance conditions.

## Controller recovery implementation — 2026-11-08

The delayed-answer retry defect is fixed: a currently authorized caller retrieves
the original acceptance after controller completion; conflicting input and stale
credentials remain rejected. Initialization now records its pinned inputs before
allocating the controller directory. Actual SIGKILL tests resumed the same run
after directory creation and after the initial journal write, without another
attempt; changed source was rejected rather than silently becoming a new scope.

The authenticated execution path now adopts an existing controller when its owner
has been replaced. It excludes surviving source writers/readers, checks assignment
process settlement, preserves old policies and review history, and publishes a
new owner-bound policy. Its saved adoption candidate survives interruption between
controller-journal publication and the orchestration manifest update. This also
works across the two initialization crash windows. Recorded host identity recovery
can explicitly renew a subset of the previous delegation for the named pending
operation; it cannot expand the grant or authorize redispatch of unissued work.

A replacement immediately before completion publication now leaves an unknown
operation with retained result evidence. The new owner must adopt it before it
can become current completion evidence; a changed converged source is rejected.
An actual isolated control driver also completed review/repair/commits through
the gateway while it could not access the task checkout directly.
Waiting control sessions no longer count as unsettled source jobs.

The focused recovery checks, 133 delivery/execution/state regressions and eight
selected controller initialization/compatibility checks passed. These exercised
real processes with deterministic providers. A fresh temporary installation passed
the combined 32 controller, boundary and protocol tests in 385.43 seconds. A later
cleanup change removes the initialization record during explicit settled-run
pruning; its targeted test passed separately. No active skill installation or live
task was modified. The final independent panel has not run.

P1–P3 remain incomplete. Next selected-model acceptance must check the bundled
Codex review adapter's channel access: its command still pins the native
`--sandbox read-only`, whereas the earlier live retrieval probe required the
documented permission profile inside the verified outer boundary. Fixture-based
approved-log reads do not establish that the actual reviewer can retrieve them.
Admission/capability binding, total storage limits, compatibility/rollback,
complete installed two-task live acceptance, release versions and final review
remain required. Upstream reconciliation and other controller recovery routes
must remain available through the authorized orchestration interface as well.

## Inbox recovery and selected-reviewer access — 2026-11-08

A new probe accepted an interface update for task A, then emitted 513 updates
from task B. Task A's resynchronization and subsequent inbox exposed neither
the update nor its ID, although the message bytes remained stored. The same
failure affected answered questions. Durable messages and artifact records now
retain their delivery positions. Inbox pagination reconstructs missed deliveries
after notification eviction while still requiring a current task-state refresh
for lost transient notices. A real-gateway regression uses the production
512-event window, restart, owner replacement, pagination and acknowledgement;
separate coverage preserves reviewer privacy for evicted artifact notices.

The Codex adapter now selects its read-only channel permission profile only
after the gateway attests the actual connecting process against its registered
namespace. Possession of a credential on the host does not pass that check.
The actual installed Codex CLI queried and retrieved an approved artifact while
source writes, host-canary access and direct network access remained denied.
An optional-deadline bug found by that probe was repaired and covered by a real
Node-in-namespace regression.

The first two installed live-controller attempts converged but failed the
independent evidence-access assertion: Claude initially had no shell client
tool, then its narrow permission rule denied heredoc calls. Its reports disclosed
the unavailable logs; the deterministic triage fixture could still resolve the
source criterion, so controller convergence was insufficient acceptance evidence.
Claude now obtains the same namespace attestation, retains safe/restricted and
dontAsk settings, and receives an allow rule for the fixed communication client.
The client accepts one quoted `--json` argument, avoiding the denied heredoc form.
The prompt explicitly permits that command and supplies the verified task ID.
Standalone reviewer settings remain unchanged.

Two subsequent installed runs recorded actual approved-validation-log reads from
both selected reviewers and completed repair, per-round commits, validation and
fresh review. They took 115.04 and 110.87 seconds. The latter exercised the new
parameterized `benchmarks/live_controller.py` runner and retained installed runtime
hashes. Claude Code 2.1.319 used the requested opus/xhigh setting; Codex CLI 0.167.0
used gpt-6-astra/xhigh. Full-run provider usage and observed model IDs are unavailable.
All four attempts, including both failed acceptance runs, are recorded in
`benchmarks/results/2026-11-08-controller-channel.json`. Triage and repair were
deterministic providers; these are single-task access/workflow checks, not the
final source panel, a two-task acceptance run or a cost comparison.

The installed protocol/namespace/job/profile/view checks passed (53 tests), as
did the adapter/context suites (69 checks). The later JSON-argument process
check passed; the affected prompt suite, including its new regression, passed
27 checks. These overlapping runs are not a combined test count or final release
certification. No active installation or live task was modified.

P1–P3 remain incomplete. Admission/capability binding, aggregate storage limits
and control responsiveness, compatibility/rollback, remaining controller recovery
routes, the full installed two-task exercise, complete-workflow usage measurement,
release versions and the final independent panel remain required.

## Host capability and profile validation — 2026-11-08

The trusted host now runs `supervise.py verify-host` before enforced admission.
Its real-process probe exercises distinct user, mount, network and PID namespaces,
descendant confinement, hidden host files, blocked host networking, endpoint access,
and successful writes with read-only reviewer separation. The private receipt binds
the run, explicitly local host, configuration, machine, boot, security settings and
runtime. A long-lived process whose runtime files changed must restart before it
can certify the new files. This is an OS capability check, not provider login proof.

Admission, handoff, launch preparation and actual job start now enforce these
bindings. Missing or stale proof fails before new work. Re-verification invalidates
old prepared launches; existing jobs keep their settlement path. Enforced checkout
checks reject aliases, shared Git directories, alternates, symlinked metadata and
shared hardlinks. Local clones must use `--no-hardlinks`.

Launch profiles now validate host sources before issuing credentials and again
before launch. Protected run state, checkout roots, administrative paths, host-home
roots and their ancestors cannot enter as tool mounts; bundles containing host
sockets or devices are rejected. File provisioning cannot copy private run state
or checkout files. Explicit selected provider files and ordinary tool bundles remain
supported. The administrator choosing those tools and credentials remains trusted.

The final disposable installation passed 37 capability/boundary/controller checks
in 402.712 seconds. A strengthened installed positive check separately compiled and
ran C, then published through the authenticated channel. Its 64 runtime files matched
the source at that checkpoint. An earlier frozen installation passed 78 broader checks; state
regression passed 72 and installation/evaluation checks passed 53. These runs overlap
and must not be added into one test count. The first source review-boundary attempt
had three stale-verification failures because runtime files were edited while it
ran; frozen reruns passed. The machine-readable record is
`plugins/jig-orchestration/benchmarks/results/2026-11-08-host-capability.json`.

No active installation, live task or unrelated pane was changed. These are process
tests with deterministic controller providers, not new live-model evidence or the
final independent panel. P1–P3 remain open: aggregate storage and control latency
(including filesystem scans under state locks), full compatibility/rollback,
remaining controller recovery routes, installed two-task/model acceptance,
whole-workflow usage comparison, release versions and the final panel still require
completion. A local capability receipt does not provide remote-host enforcement.

## Retained protocol capacity and stopping work — 2026-11-08

A new direct probe exposed a failure in the first storage-budget implementation:
after filling ordinary capacity in a disposable 512 KiB run, 34 acknowledgements
of the same cursor with distinct action IDs consumed the recovery reserve. A
coordinator pause then returned `storage_capacity` and left the run unpaused.
The corresponding regression failed before the correction.

Retained protocol data now has ordinary, recovery and protected stopping capacity.
Acknowledgements, replies and normal recovery cannot consume the final half of
the reserve. Pause/cancel, trusted replacement of an existing coordinator and
bounded terminal observations of registered jobs can use it. New job registration
uses ordinary capacity. Receipts remain immutable; retries retain the original
action ID rather than consuming another receipt. No automatic deletion forgets
uncertain effects or unresolved questions.

Reservations precede state/action journals, artifacts and immutable view snapshots.
They bound retained objects and conservatively account for their bytes, metadata
and atomic-write temporaries. Fixed temporary filenames prevent repeated process
crashes on the same object from leaking new temporary files. Authentication and
job maintenance no longer block the gateway accept loop on the state lock;
bounded lock waits return `state_busy` without claiming success.

Eight storage tests exercised capacity, exact replay, full retained artifact reads,
reply and pause after restart, rejected oversized state, concurrent snapshots,
repeated real process exits, coordinator replacement, an interrupted pause journal,
and cancellation/settlement of an actual enforced job after capacity exhaustion.
The broad regression then passed 382 tests in 681.373 seconds with the disposable
installed execution and controller runtimes selected and isolation required.
The separate installation/evaluation run passed 53 tests in 11.762 seconds. The
eight storage tests are included in the 382, not additional coverage to add to it.
Existing write-fault test wrappers were updated to forward storage keyword
arguments; their injected failures and assertions were preserved.

The installation was `/tmp/herdr-storage-install.8_teucts/skills`; its 65 runtime
files matched the source both before and after regression. SHA-256 of the sorted,
compact JSON runtime-hash manifest is
`5cd3a9c1f32ff203169045bd96cef3440fde00e6732bf181415dca3c752b52e8`.
Full local outputs are `/tmp/herdr-storage-regression.log` and
`/tmp/herdr-storage-install-checks.log`. No active installation or live run changed.

This closes the reproduced reserve-exhaustion failure, not aggregate storage or
P1–P3 acceptance. Job homes, execution directories, runtime copies and process
logs still need aggregate resource controls. New snapshot queries may fail at
capacity while existing evidence remains readable. Filesystem scans and runtime
hashing under the state lock remain a control-latency concern; finite lock waits
do not guarantee application latency under slow I/O. Physical disk failure,
unlimited stop requests, full compatibility/rollback, remaining controller recovery
routes, the installed two-task live-model exercise, whole-workflow usage comparison,
release versions and the final independent panel remain outside this result.

## Filesystem checks and lock custody — 2026-11-08

Two new tests first reproduced pause returning `state_busy` while admission
scanned Git metadata or launch hashed the host runtime. The corrected paths
retain the checkout lease while performing full filesystem checks outside the
global state lock. Before committing, they recheck the authenticated session,
policy, host receipt, ownership and fixed file metadata. A pause accepted during
the scan prevents the pending admission or launch. Host verification also hashes
outside the state lock. Existing admission receipts remain replayable without
requiring new filesystem authority; their identity and payload checks remain.

Four slow-check tests now prove pause takes effect before the delayed check is
released, while a second source writer remains excluded. Separate tests reject
a launch when host verification changes during its scan, and verify receipt
replay after the checkout stops being valid for new work. The 17-test capability
suite passed. These use injected filesystem delay, not a physical disk-saturation
benchmark. The first installed candidate then passed 178 state/execution tests
in 127.144 seconds and three selected controller tests in 95.747 seconds.

A further real-process probe found a lock capability leak: the launcher supplied
two `--sync-fd` flags, but Bubblewrap 0.11.0 only protects the last one. The child
could unlock the first descriptor even while the host retained its copy. The
new `test_child_cannot_unlock_host_execution_or_source_lease` reproduced that
failure through the actual launch path. This matches the option handling in the
[deployed Bubblewrap source](https://github.com/containers/bubblewrap/blob/v0.11.0/bubblewrap.c#L2148).

The launcher now retains both open-file descriptions in an unread Unix socket
queue. Bubblewrap's reaper holds that single protected socket; neither lock
descriptor reaches the executed command. Tests prove that a child cannot unlock
either lock, that both survive closing their original descriptors, and that both
release after namespace exit. The new custody test initially equated monitor
exit with namespace exit; three direct probes demonstrated the intervening
window. It now observes namespace disappearance using the existing two-second
production bound before asserting release. No production timeout was relaxed.

After the descriptor correction, the fresh installation
`/tmp/herdr-control-final.z9cezu85/skills` passed 56 capability/channel/job/storage/
execution tests in 38.663 seconds and four selected controller tests in 88.403
seconds. The latter include review/repair/validation, source-lease survival after
parent exit, a source-free control driver, and replacement waiting for a surviving
writer. All 65 runtime files matched the source; SHA-256 of the sorted, compact
JSON runtime-hash manifest is
`830e8bcdf97a139b96a9f69463c2956c44feb319f66c2e6802985fda103261b6`.
Outputs are `/tmp/herdr-control-final-regression.log` and
`/tmp/herdr-control-final-controller.log`. Earlier and overlapping test counts
are not a single final-release suite. No active installation or live run changed.

This supersedes the earlier open finding about full Git scans/runtime hashing
under the state lock. Finite lock waits do not promise service through physical
disk failure.

### Authorized process startup

A further regression reproduced pause returning `state_busy` during delayed
process creation. Launch now records a prepared job, starts Bubblewrap outside
the state lock and retains the source/execution leases. A trusted Python
bootstrap inside the namespace waits for an explicit byte on a private pipe.
The host rechecks session/parent authority, pause/cancellation, host verification
and job state, persists start authorization, then writes the byte without a
blocking wait under the state lock. EOF refuses the command. Bubblewrap's
`--block-fd` treats EOF as completion and is not used as the authorization gate.

An initial bootstrap still exposed profile environment variables to its loader.
A real C constructor loaded through `LD_PRELOAD` created a file before start
authorization, despite Python's isolated mode. The corrected launcher starts the
bootstrap with an empty environment and applies the command environment after
authorization. The constructor probe now proves both refusal before permission
and legitimate loading after permission. A separate probe covers Python startup
hooks, EOF and a wrong token.

The new checks cover pause, cancellation, direct and parent-session replacement,
host re-verification during startup, failed authorization persistence and parent
death before authorization. Existing lock custody, cancellation, successful
execution and replacement checks remain. A new test initially assumed that a
failed authorization write must immediately yield a known namespace outcome.
Killing a launcher before its namespace record exists correctly leaves settlement
unknown; the test now proves no original command effect and successful replacement
after exclusive-lease reconciliation. Reconciliation preserves a proven
`not_started` outcome rather than replacing it with `unknown`.

Before the final outcome-preservation correction, 44 source job/capability/
execution/egress tests passed in 26.564 seconds, and a disposable installation
passed 43 job/channel/storage/profile tests in 29.059 seconds plus five selected
controller checks in 89.214 seconds. These controller checks use real processes
and deterministic model fixtures; they are not a live-model acceptance run or
the final independent panel. After the correction, all 15 source job tests passed
in 10.483 seconds. The final installed candidate is
`/tmp/herdr-startup-final.1ob_or3d/skills`, with 66 runtime files matching source;
its sorted compact JSON hash manifest has SHA-256
`335b05d9b2d2a00389ddd8a84865246c4fb43cffb87fb112e8739792a3148bfa`.
Its 23 job/storage checks passed in 21.818 seconds, and two final controller
checks passed in 56.978 seconds: review/repair/validation and replacement of a
surviving writer while continuing the same controller. Controller results are
retained in `/tmp/herdr-startup-final-controller.log` and job results in
`/tmp/herdr-startup-final-jobs.log`. Overlapping counts are not a release total.

Open work still includes aggregate runtime storage, complete compatibility/
rollback, remaining controller recovery routes, two-task live-model acceptance,
whole-workflow measurements, release integration and the final panel. No active
installation, live run or unrelated Herdr pane changed.

## Bounded invocation logs — 2026-11-08

Two direct adapter regressions failed before this change: an adapter could write
two MiB of stderr and still complete with an unbounded retained log, and an I/O
error after a real workspace effect was reported as `not_started` with
`no_effects:true`. Enforced adapter and host-controller invocations now drain
stdout/stderr through pipes into private logs capped at one MiB per stream.
Children cannot seek or extend the log files directly. Capture metadata records
observed/retained bytes, truncation, errors and completeness. An incomplete
capture cannot substantiate success, even when its retained prefix is valid
JSON. Files and their parent directories are synced before capture completion.

An I/O exception is no longer evidence of non-execution. Enforced adapters need
a trusted, settled job record proving non-start; otherwise the operation remains
unknown for inspection. Legacy adapters keep their existing log descriptor
interface, with conservative classification after a process has started.

The new checks cover both-stream overflow, exact UTF-8 retention, attempts to
seek the output descriptor, surviving writers, injected write/sync failures,
valid-but-truncated JSON, and an actual effect followed by an injected error.
A high-numbered-descriptor test exposed `select()`'s descriptor ceiling; the
reader now uses the platform's default selector. The initial 70-test composite
had one new fixture error because its controller manifest had mode 0644; the
fixture was corrected to the existing required mode 0600. The production
private-file check was retained.

The final disposable installation is `/tmp/herdr-output-final.axqdwoox/skills`.
Its 67 runtime files match source; SHA-256 of the sorted compact JSON manifest
is `90343ecb9f2c2ce3760854e0cf47246af5d7e98475860ad53b67414b9d5238e1`.
The final 20 output/execution checks passed in 14.245 seconds; results are in
`/tmp/herdr-output-final-focused.log`. Two final controller checks passed in
67.923 seconds, covering review/repair/commit/replay and replacement after a
surviving writer settles. The preceding installed candidate passed 42
output/execution/job/storage checks in 36.521 seconds. Controller results are
retained in `/tmp/herdr-output-final-controller.log`; these use deterministic
provider fixtures, not a live-model delivery or final independent panel.

This bounds each invocation's logs, not the total number of invocations, job
homes, checkouts, runtime copies or execution directories. Aggregate storage
acceptance and the other P1–P3 release requirements remain open.

## Aggregate admission capacity — 2026-11-08

A baseline probe filled an old job home beyond the configured budget and still
admitted a new task. The runtime now scans the private run directory, all admitted
checkouts and a proposed checkout before accepting new work. It includes old job
homes, runtime copies and invocation logs. Trusted provisioning and runtime copies
serialize projected allocations on a separate lock; filesystem scans do not hold
the global state lock. Commit-time checks reject changed checkout membership.

The default budget is 8 GiB and 250,000 entries, with 64 MiB and 1,024 entries
reserved for coordinator provisioning, plus a 64 MiB filesystem free-space floor.
Each entry charges the largest of 4 KiB, logical bytes and allocated bytes. The
descriptor-based scanner does not follow symlinks, including a directory replaced
with a symlink during traversal. A scan failure refuses new work explicitly.

The supported policy is admission refusal, not an OS filesystem quota. Running
commands, in-flight writes and recovery invocations can still consume space after
a check. Existing receipts and evidence remain readable; pause/cancel and exact
receipt replay avoid the scan. No automatic deletion or evidence pruning was
added. Physical disk exhaustion still needs deployment-level resource controls.

The 13 final source capacity checks passed in 5.568 seconds, including old-home
and candidate-checkout growth, aggregate retained directories, free-space refusal,
symlink replacement, entry exhaustion, competing allocations, stale preparation,
pause during a delayed scan and a real coordinator launch using reserved capacity.
The free-space failure is injected; sparse files exercise logical-size accounting,
not physical disk saturation. Installed verification is recorded below.

The disposable installation at `/tmp/herdr-capacity-final.fq8p8blm/skills` passed
69 capacity/capability/profile/execution/job/storage tests in 51.616 seconds.
Three installed controller tests passed in 70.920 seconds: refusal of a fresh
runtime copy at capacity, successful review/repair/commit with completion replay,
and replacement after a surviving writer settles. Controller providers are
deterministic fixtures, not selected live models. All 68 runtime files matched
source and installed hashes; the sorted compact JSON manifest has SHA-256
`de3cc768b3a9e570ae388498f395c2cfc7d5f26bc916155e440e294c8b644682`.
Logs are `/tmp/herdr-capacity-installed.log` and
`/tmp/herdr-capacity-controller.log`. No active installation or live run changed.

This addresses the reproduced aggregate-admission gap. It does not establish
long-run control latency, a hard disk quota, complete compatibility/rollback,
remaining controller recovery, the two-task selected-model workflow, total
provider cost savings, or the final independent panel. Those release requirements
remain open under the original P1–P3 scope.

## Compatibility and rollback — 2026-11-08

The previous installed candidate rejected legacy action IDs above 256 UTF-8
bytes. It also rejected a valid maximum-size enforced operation when the trusted
runner appended its dispatch/completion suffix. Both failures were reproduced
against that immutable installation. The limit now applies to new external
enforced actions; guarded internal transitions and authenticated exact receipt
replay preserve their existing identities. Reusing an ID with different input
or a revoked session still fails.

The client previously treated JSON `true` and `1.0` as protocol version `1`.
Both directions now require an actual integer version. The client returns the
explicit `protocol` error and does not retry through another transport. An older
enforced child credential without a parent binding was also accepted by the
previous candidate. It now returns `incompatible`; a trusted replacement bound
to the current parent restores access. Missing parent authority is never inferred.

Older retained messages/artifacts without sequence numbers remain directly
readable. If their original delivery events were evicted, inbox resynchronization
fails explicitly while preserving the records and stop controls. The runtime
does not invent ordering or silently erase those records.

The rollback exercise starts a real isolated writer, stops new admissions with
`finish_current`, restarts the gateway, and lets the same writer query, publish
evidence and finish inside its original boundary. The second task is refused,
and the configuration API refuses changing the run to legacy mode. The supported
rollback retains the pinned runtime until jobs and uncertain effects settle;
it does not convert live state to an older format. No live installation or run
was changed.

The new fixtures initially needed corrections for stale policy/delegation and
missing observation evidence. Existing guards were preserved. A test command
also named a nonexistent `test_execution` module after its 72 state tests passed;
the corrected selection uses `test_delivery`. The state/delivery fixture now
honors the installed-runtime path rather than forcing repository source.

The final disposable installation is `/tmp/herdr-compat-final.oiyk68iu/skills`.
All 68 runtime files match source; its sorted compact JSON hash manifest has
SHA-256 `232032d56cd063f2e1b6513bba4b7df66fe4a59ff3a8cf0a2699bfc7d982140f`.
It passed 52 compatibility/channel/job/execution tests in 45.733 seconds,
124 state/delivery tests in 102.221 seconds, and the controller's successful
review/repair/commit/replay test in 38.163 seconds. The controller uses a
deterministic provider fixture. Logs are `/tmp/herdr-compat-final-focused.log`,
`/tmp/herdr-compat-final-legacy.log` and `/tmp/herdr-compat-final-controller.log`.
The earlier installed candidate passed 63 compatibility/execution/protocol/
channel/capability tests in 103.868 seconds before the missing-parent guard.
These overlapping runs are not a single final-release suite or independent panel.

The original goal remains open for the remaining canonical controller recovery
routes, installed two-task selected-model acceptance, whole-workflow usage and
quality measurements, release integration and the final frozen-source panel.

## Authenticated upstream recovery and release — 2026-11-08

Upstream reconciliation now uses a separately recorded validation `execute`
operation naming the original successful review. The host pins the same
controller configuration, checks current review/validation authority, validates
the applicability receipt before consuming the new attempt, and retains both
operation locks during execution. The original review result and raw reports
remain unchanged. Replaying a lost validation reply resumes the original
controller journal without repeating completed validation. `review_release`
provides an authenticated, idempotent release of a settled controller reference;
it preserves reports and checks capacity before creating a new release record.

Testing exposed a second recovery failure: after a same-content history change,
owner replacement changed the configuration hash used to compare review policy.
The controller first needs the original applicability checks under the new
owner's source lease, then retains the original authority fields for report
policy comparison. Actual commands use the current owner's policy. Other
configuration remains in the comparison; a policy-drift check still rejects
inapplicable reports. No raw reports are rewritten.

The initial two-case recovery run had one pass and one failure in 68.694 seconds.
A diagnostic rerun captured the policy mismatch in
`/tmp/herdr-recovery-diagnose.log`; the corrected source owner-replacement case
passed in 41.049 seconds. All 15 upstream reconciliation checks then passed in
140.219 seconds, including policy drift and failed post-landing validation.
Three controller checks on the corrected disposable installation passed in
117.820 seconds: lost-reply recovery/release, owner replacement after changed
history, and replacement before completion. These use the actual gateway,
controller, Git and isolated processes with deterministic provider responses;
they are not live-model acceptance or independent panel review.

The corrected installation is `/tmp/herdr-recovery-final.12lj6hrg/skills`.
Its 68 runtime files match source and the sorted compact JSON hash manifest has
SHA-256 `18458c53a7b1a4a8697ab5a8283fa3567c53d5423e30d52c589954dadd7a77f7`.
Logs are `/tmp/herdr-recovery-final-controller.log` and
`/tmp/herdr-recovery-upstream-fixed.log`. Before the policy correction, the
installation `/tmp/herdr-recovery-final.ngr9pi68/skills` passed 50 runtime checks
in 28.514 seconds. Its broader controller sweep subsequently finished with 15
passes and the known owner-policy failure in 437.623 seconds.
`/tmp/herdr-recovery-installed-controller.log` belongs to that pre-fix
installation and must not be counted as final-candidate evidence.

The complete two-task live-model acceptance, whole-workflow usage comparison,
release integration, final regression and independent panel remain open.
No active installed skill, live run or unrelated Herdr pane changed.

## Live workflow findings and client deadlines — 2026-11-08

The client now bounds an entire request, including reconnects and partial socket
reads. Ordinary requests default to 30 seconds, watches to 35 seconds and execution
observation to 3,600 seconds, with a finite caller override. A timeout preserves an
unknown mutation outcome and does not cancel the job. Five real-socket client
tests passed; the installed client/channel/compatibility selection passed 29 tests
in 10.986 seconds. A later CLI deadline test also passed.

Live models exposed an inbox usability failure: a consumer waited on task state
while its source handoff was already available as a message, guessing several
unsupported timeout fields. Inbox pages now supply the next scoped read or inbox
watch request; watch rejects unknown fields. The updated installed selection
passed 48 client/channel/compatibility/protocol/view tests in 77.058 seconds.

The live review controller also gave initial triage an empty `validationPending`
list before checks had run. The model requested external recovery for scheduled
validation. Assignments now identify applicable outstanding checks and explain
the normal empty-triage continuation without waiving any validation or acceptance
gate. Its focused regression passed in 6.419 seconds and proves the required
check still executes once before convergence. Reconciliation regressions and the
new live attempt are running at this checkpoint.

Six complete-workflow diagnostics failed. Their distinct failures and available
provider-native usage are retained in
`plugins/jig-orchestration/benchmarks/results/2026-11-08-workflow-diagnostics.json`.
The harness now observes reconnection at the replacement gateway, explicitly
cancels revoked writers, retries bounded admission contention, records failed
requests, and copies every native output before parsing. It retains a settled
fixture if collection fails. Initial source acceptance, final source acceptance,
controller convergence and measurement completeness remain separate. The first
attempt lost usage; one reviewer in the fifth attempt also has unknown usage.
Neither is counted as zero. The sixth attempt retained all model usage but still
failed controller acceptance.

The broad installed Python run completed 440 tests in 984.867 seconds: 439 passed
and one existing storage test called the client's replaced private `timeout`
argument. Updating that call to an absolute deadline preserved the original
latency assertion; all eight storage tests then passed in 12.908 seconds. The
Codex/Claude release version mismatch was corrected in both plugin manifests,
and all four host-parity checks passed. The broader Node run is still active.
These overlapping checks are not one frozen final-release suite.

The current disposable installation is `/tmp/herdr-triage-candidate.80s76mgm/skills`.
Its 68 runtime files have manifest SHA-256
`3c52b12947da33bfd96810c4274600cbd08a14ec855d4e5a9834548c5ef07af9`.
The seventh diagnostic adds cancellation under 64 idle connections and uses this
candidate. Whole-workflow paired measurements and the final independent panel
remain open. No active installation, live user run or unrelated pane was changed.

## Supplied evidence and final regression findings — 2026-11-08

The seventh diagnostic completed both implementations, recovery and both live
review controllers. It took 667.311 seconds; cancellation under 64 idle connections
took 0.303 seconds. Task A's reviewers found an iterator regression, model-backed
repair corrected it, and both reviewers retrieved its validation logs. Task B
converged without repair after its initial review and subsequent validation. The
benchmark nevertheless failed because it demanded that those initial reviewers
read logs not supplied at their review time. This remains the seventh failed
historical attempt, with native usage retained in the diagnostics JSON.

The benchmark now checks the supplied log parts against each reviewer's session,
artifact ID, hash and complete bytes, including pagination. No supplied logs means
evidence access was not exercised; it does not count as successful retrieval. A
missing selected reviewer record or unread supplied log fails acceptance. Five
focused tests cover absent receipts, missing metadata, wrong-session or partial
reads, and retried Unicode pages. The separate selected-adapter controller check
still establishes log access by both providers without demanding extra reviews
from a clean workflow. No controller acceptance or validation gate was removed.

The broad Node run completed 1,009 tests: 1,003 passed, three failed and three live
provider tests were skipped. The three failures were manifest parity, an obscured
Git diagnostic command name after safety options were prepended, and a test's Git
observer not recognizing those options. All are corrected. The four host-parity
checks and 65 Git scope/copy/fingerprint checks passed afterward. The separate
43-test reconciliation selection also passed. This is a broad run plus focused
post-fix verification, not a claim that the original run passed unchanged.

A new disposable installation at `/tmp/herdr-paired-candidate.57x33wm5/skills`
pins 68 runtime files with manifest SHA-256
`0d9e2d2d0c6f5767a04818d11c7170da9d0b4518ecaec0bf0756934cbc0eac2f`.
The installed controller regression passed 16 checks. The full/automatic pair
finished with a failed full variant (539.45 seconds) and a successful automatic
variant (397.13 seconds). Task B's full-variant triage asked whether unsized
iterables were supported. Its failure is retained in
`plugins/jig-orchestration/benchmarks/results/2026-11-08-workflow-pair-before-panel-repair.json`;
this pair does not establish acceptance or token savings.

The independent Claude and Codex panel then completed against source fingerprint
`e21a76fd0be489e1b6e3743086c610bece0a4940ee32a95cd4580d5112b02160`.
Coverage was limited: the adapters omitted 39 untracked files from bundled
evidence, and reviewers inspected selected omitted sources directly. Parent
probes reproduced Git promisor helper execution on the trusted host, replacement
of hidden controller state through its writable Git ancestor, and merge-gate
acceptance of model-invented review evidence. Reports and probes are retained in
`/tmp/herdr-p1-p3-panel.jbjwc6up` and its referenced artifacts.

Repairs are tracked in the existing review-fix controller run
`65c23b4d-2f89-4c68-a894-7c47c8e74e01`, round 1, without commits. Trusted local Git
now denies transports; the Git ancestor is pinned; merge and closure require a
runtime-recorded, settled review bound to the committed candidate. Other repairs
cover taskless provider tunnels, private environment delivery, lease-based
recovery of unknown namespaces, bounded authorization retries during contention,
busy completion reconciliation, UTF-8-safe log prefixes, and cached immutable
lease locations with authority rechecked on every acquisition.

The live fixture now explicitly preserves finite integer iterables and checks
generators in both source acceptance and controller validation. It also includes
selected-provider coordinator startup before task admission and authenticated
query traffic during cancellation. At this repair checkpoint, full required
validation and fresh terminal reviews remain pending; the controller journal,
rather than this historical progress entry, records their subsequent outcomes.

The first repair's controller validation completed: 456 of 457 installed tests
passed, the Node/eval suite passed (1,013 passed, three optional live skips), and
both live workflow variants passed. The installed failure exposed a regression:
private launch-environment files used the ordinary storage budget even for
coordinator recovery. Host re-verification failed at the same boundary. Round 2
preserves the reserved control budget for both trusted callers and extends the
existing recovery test to re-verify the host before launching the coordinator.

The successful historical pair is retained in
`plugins/jig-orchestration/benchmarks/results/2026-11-08-workflow-pair-after-panel-round1.json`.
Gateway payload tokens were 79,480 in full mode and 14,387 in automatic mode;
elapsed time was 423.5 and 457.0 seconds respectively. Native usage and reported
cost were mixed, and Claude reported different resolved model sets despite the
same requested alias. This fixture establishes neither statistical savings nor
an overall cost or speed improvement. Both provider startup probes and control
recovery under authenticated load passed. No validation logs were supplied to
the initial clean reviews, so this pair did not exercise log retrieval. The
separate supplied-log checks remain the evidence for that behavior. Final
validation and fresh reviews of the capacity repair remain required.

The capacity repair passed all four required checks: 457 installed tests;
1,013 Node/eval passes with three optional skips; a successful full/automatic
live pair; and the diff check. The live pair used 78,082 versus 14,694 gateway
payload tokens and took 438.2 versus 418.1 seconds. The same measurement limits
apply, including different observed Claude model sets and unexercised log reads
in the initial clean reviews.

The controller then stopped as `REVIEW_INCOMPLETE`. Complete review capture
omitted 45 untracked files under preview-only limits, despite having a 16 MiB
paged-evidence budget. Three Codex attempts and one Claude attempt completed
with that capture failure; the controller cancelled the remaining Claude attempt
without a usable verdict. The terminal run and its passing checks remain intact.

The subsequent tooling repair captures untracked text through the existing page
budget and refuses incomplete structured evidence before invoking a provider.
The full checkout capture now offers all 60 pages with no omissions. The focused
107-test adapter/context/evidence suite passes. Its first run had three fixture
errors caused by missing expected fingerprints; those errors were corrected and
the failed log retained. A new complete-source acceptance run remains necessary;
no earlier incomplete review is promoted to a clean report.

The successor captured all 60 pages for both selected reviewers. Its complete
reports found four defects: direct closure skipped certification, closure could
reuse certification after source changes, cancellation prevented inspection of
issued generic operations, and stderr tails were labelled complete. The direct
closure and cancel/inspect/resume paths were reproduced through authenticated
gateway calls before repair.

The repair checks the actual source snapshot and HEAD under the checkout lease
before new closure authorization, including intent, preparation and dispatch.
It uses the original pinned controller runtime and keeps source access read-only
during a close adapter's execution. Private-workspace adapters retain a separate
task-source lease through the namespace lifetime. Successful issued effects keep
their reconciliation path after subsequent source drift. Terminal closure also
checks certification and unresolved findings.

Recovery inspection is tied to the original dispatched operation and current
cancellation generations. It cannot authorize new work; another cancel stops the
inspector. Stderr receipts now carry retained/observed byte counts and truncation
metadata, retain valid Unicode tails, and propagate that metadata to paged
artifacts. Missing retention metadata does not establish completeness. The
installed controller regression reads every page of a deliberately truncated
stderr log through the authenticated artifact route.

Targeted diagnosis also corrected a provider-envelope regression in the initial
metadata patch, a Git fingerprint scan that refreshed checkout metadata, and
test fixtures that omitted settlement evidence or assumed one-page log reads.
Those failed runs remain retained. Targeted closure, cancellation, private-source
lease and log-evidence regressions pass; the final required checks and independent
reviews of this successor remain pending. The older live pairs still do not
prove supplied-log retrieval when their initial reviews received no logs.

The successor's first repair passed all four required checks: 465 installed
tests, 1,021 Node/eval passes with three optional skips, both live workflow modes,
and the diff check. Its live pair used 78,694 versus 14,611 gateway payload tokens
and took 445.0 versus 429.4 seconds. These remain payload measurements from one
pair with differing observed Claude model sets, not proven total cost savings.
A separate source-matched live probe supplied validation output and observed
one authenticated nonce-bearing artifact read from each selected reviewer.

Both fresh reviews captured all 61 source pages and found the same new closure
recovery defect: upstream revalidation published its new operation ID, while the
controller manifest remained in the original review operation's directory.
An authenticated reproduction returned `channel_error` on subsequent closure.
Certification now retains both operation identities, and closure uses the
original controller identity while preserving current-source and runtime checks.
The existing lost-reply and owner/history-recovery tests now continue through
source-drift rejection and successful direct or adapter closure, including release.
Release by itself was separately checked and already allowed closure.

Two additional authenticated probes exposed overly broad policy changes in the
first repair: pause killed an inspector under an existing cancellation, and
legacy close adapters lost their configured write access. Run/task pause and
legacy tracker-write regressions all failed against that candidate; the corrected
disposable copy passed those cases and both cancellation-neighbor cases. Only a
new cancel now advances the inspection generation, and close-specific read-only
source protection applies only to enforced runs. Existing inspection restrictions
remain. The current repair still requires its pinned validation and fresh reviews;
earlier passing receipts do not establish final acceptance for changed source.

The successor's second repair passed 468 installed tests, 1,021 Node/eval tests
with three optional skips, both live workflow modes and the diff check. Both
fresh reviews captured all 62 pages. The live pair reduced gateway payload from
78,407 to 14,090 tokens (82.0%), but took 390.4 versus 429.2 seconds. Codex input
and output usage increased in automatic mode; Claude reported cost was nearly
unchanged ($0.5173 versus $0.5177). Both Claude runs observed `claude-opus-5-5`;
Codex resolved model and billing remain unknown. Overall cost or speed savings
are not established. A separate source-matched probe demonstrated authenticated
supplied-log retrieval by both selected reviewers.

Those reviews and follow-up reproductions found four further defects. Invalid
or unfinished UTF-8 bytes were counted after replacement decoding; revoked
sessions retained entire assignments in hot state; refused generic launches
allocated credentials and trees before acquiring source access; and unconditional
Git restrictions made a clean filtered file appear modified during standalone
inspection. The third repair counts raw diagnostic bytes and reports decoding
loss separately, stores new enforced contract bodies as retained quota-accounted
content-addressed files, acquires task-source leases before generic provisioning,
and scopes mandatory Git restrictions to enforced host execution before preflight.
Old inline contracts, evidence retention and standalone converter/transport
behavior remain supported.

The focused diagnostic suite passed 13 cases, Git safety/compatibility passed six,
and a fresh installed runtime passed 48 storage, execution, boundary and controller
cases. Initial Git test assertions used the wrong result shapes; both were corrected
and the failed output retained. These focused checks do not replace the pinned
full validation, paired workflow and fresh independent reviews still required for
this changed candidate. Additional checks passed quota refusal, both-stream
artifact fidelity, private-workspace closure and a log write failure during EOF
decoder flushing. The enforced occupied-lease fixture initially attempted to
configure a missing profile, which enforced validation correctly rejected; the
fixture now isolates lease contention, and both enforced and legacy cases pass.

The third repair passed all four required checks: 474 installed tests, 1,028
Node/eval passes with three optional skips, both live workflow modes and diff-check.
Both fresh reviews completed the 64-page capture. Codex reported no findings;
Claude identified that the required pair could pass with no supplied logs.
The separate current-source probe had already demonstrated one nonce-bearing
log read from each selected reviewer, with all 69 runtime files matching, but
that probe was not enforced by the required check. The fourth repair makes it a
mandatory gate before the paired benchmark, rejects absent/incomplete/stale proof,
and retains its results separately from variant economics. Single-mode diagnostic
runs do not claim paired acceptance. Selected profiles and review models remain
shared with the existing benchmark configuration.

This pair is an efficiency outlier: full mode recorded 6,000,949 gateway payload
tokens and 31,971 requests, versus 13,356 tokens and 36 requests in automatic mode.
The trace contains 31,932 repeated reads of an empty terminal artifact page despite
`complete: true`. Driver B observed `claude-opus-5-5` in both modes. Full and automatic
runs took 585.1 and 414.7 seconds. These measurements are retained; they are not a
clean comparison of response-size overhead or evidence of equivalent billed input.
Both workflows still passed source acceptance, restart/replacement and control
checks. Their initial reviewers received no logs; the separate source-bound probe
provides the actual supplied-log evidence.

An independent gateway reproduction found a remaining lease regression despite
those passing checks: a supported legacy symlink checkout worked before the
third repair but then failed because its early lease used the lexical task path
while launch preparation resolved the physical directory. Holding the physical
checkout also caused an avoidable session and launch allocation. Resolving the
physical path before taking the early lease restores execution and idempotent
replay while refusing contention before allocation; task bindings and subsequent
source/access checks remain intact. The regression fails on the third candidate
and passes in the disposable corrected copy. An initial disposable edit omitted
the Path import; its failed diagnostics are retained. Full validation and fresh
reviews of the fourth repair remain required.

The fourth repair's fresh disposable installation passed all 12 focused checks,
including legacy alias contention and replay, pre-allocation lease refusal,
legacy closure, read-only review, private-workspace closure and evidence-proof
validation. Its new required gate also passed with the selected real providers:
one nonce-bearing validation-log read from Claude and one from Codex, four
boundary contexts and matching runtime hashes, in 115.4 seconds. This probe uses
synthetic triage and repair; it is not the final source review or a billing
comparison. Full validation and fresh reviews are still pending.

The fourth repair passed all four required checks: 476 installed tests, 1,028
Node/eval passes with three optional skips, paired live acceptance and diff-check.
The required log-access probe passed with Claude and Codex, four boundary contexts
and all 69 runtime files matching source. Full mode used 78,420 gateway payload
tokens in 390.4 seconds; automatic mode used 14,368 in 407.4 seconds. Automatic
mode had higher reported Claude cost and slightly more Codex input tokens; Codex
billing was unavailable, and the requested Claude alias resolved to different
observed model sets. This pair demonstrates reduced gateway traffic, not proven
total cost or speed savings.

Both fresh reviews completed all 64 pages and confirmed the fourth repair, but
found two distinct defects. An actual isolated repair planted a reflog symlink
to hidden `active.json`; host publication followed it and appended a reflog entry,
corrupting private controller state. A real-worker short-write-then-ENOSPC probe
retained an incomplete UTF-8 sequence; publishing that approved log then raised
`UnicodeDecodeError`. The first log diagnostic used an incorrect worker filename;
after correcting the diagnostic, the compound fault reproduced on the installed
runtime. Neither passing tests nor the earlier fixes established these invariants.

The fifth repair revalidates private Git metadata under the acquired publication
lease before trusted Git runs. It also attempts to trim failed partial writes to
a valid UTF-8 prefix. Approved malformed retained logs remain available as an
explicitly incomplete prefix with distinct delivered and original-file hashes
and byte counts. Regression checks exercise actual isolated repairs targeting
controller state and a host canary, compound write/rollback failures, and scoped
retrieval by a subsequent isolated reviewer. Full fifth-repair validation and
fresh reviews remain required.

Focused fifth-repair checks passed against the matching 69-file installed runtime:
16 real-worker log cases and eight Python boundary/controller cases. The new Git
tests initially assumed no initial checkpoint commit and no retained unknown
recovery record. Those expectations were corrected to compare HEAD at the attack
and require review-gate refusal; the host canary and private JSON remained intact.
The ordinary review/repair/commit/replay path, preflight transport denial, legacy
closure and a subsequent isolated review of malformed retained output also pass.
These focused results do not replace the full required checks and fresh reviews.


The fifth repair passed all four required checks: 479 installed tests, 1,030
Node/eval passes with three optional skips, the live pair and diff-check. The
required evidence probe recorded a nonce-bearing read by each selected provider,
four boundary contexts and all 69 runtime files matching source. Both independent
reviews completed all 65 pages and accepted all five criteria. Full/automatic
mode used 78,149/14,517 gateway payload tokens, in 487.9/476.1 seconds. Codex native
input was 528,846/544,163 tokens (including cached input); its billing and resolved
model were unavailable. Claude reported $0.491302/$0.485552, with opus-5-5 observed
in both variants. These are one-pair observations, not established total-input,
billing or speed savings.

The fresh Claude review found one additional allocation defect. A disposable
current-runtime probe confirmed that three retries of the same paused execute
created three retained sessions and launch trees with no task attempts. A review
child blocked by an occupied checkout similarly allocated before its five-second
lease timeout. The initial probe had an invalid import; after correcting it,
both paths reproduced. Existing early-lease tests covered generic execute
contention, not these refusal paths.

The sixth repair shares read-only admission checks with the locked reservation
and dispatch transitions, running them before child provisioning. Already-issued
operations preserve their recovery inspection path; authority is still rechecked
at the actual transition and process start. Controller children now acquire their
source lease and check pause/cancel before credentials or validation artifacts
are allocated. A concurrent control change can still refuse a prepared launch;
this preflight does not reserve authority or promise automatic reclamation.

Nine focused installed tests passed in 24.1 seconds, including a twelve-condition
admission matrix with repeated IDs and fresh IDs, paused prepared-operation
resumption without another attempt, occupied controller source, paused/cancelled
controller children, original-operation cancellation inspection, legacy checkout
aliases and scoped validation-log access. All 69 installed runtime files match
source. Full sixth-repair validation and fresh reviews remain required.

The additional installed state, delivery and controller compatibility pass
completed 126 tests in 140.8 seconds. It includes actual review/repair/commit/replay
and current-source closure checks. All focused checks passed before freezing
the sixth candidate for the unchanged required validation and independent reviews.

The sixth candidate did not pass full validation. The installed suite passed
482 of 483 tests; its enforced occupied-workspace fixture reused a delegation
from before host verification. The current authority gate correctly refused
that stale grant before reaching the lease. A disposable probe confirmed that
renewing the grant reaches the occupied-source refusal without allocations and
permits one execution after release. Node/evals and diff-check passed. The live
evidence-access probe passed for both providers, but the full workflow returned
an unknown controller outcome. Cleanup deleted its 3,510-byte host stderr, so
the cause remains unknown. The automatic variant stopped at a Claude safety
review of the read-only canonical query; the user approved an unchanged retry.
These failed measurements remain evidence, not successful acceptance results.

The parent recorded a separate validation-prerequisite task after the prior run
became blocked, retaining both prior journals, their eight cumulative repair
rounds, the original acceptance criteria and all four required checks. Both
fresh reviewers confirmed the stale fixture grant and diagnostic loss, including
the same collection defect in the separate log-access probe. The prerequisite
repair renews the test grant after verification and asserts the lease-specific
refusal. Both live harnesses share diagnostic retention for normalized and
unknown receipts: bounded host streams and allowlisted assignment files survive
fixture cleanup, with hashes, source paths, original outcome and capture metadata,
and explicit missing/refused-file records. Private state and credentials are not
copied. Collection errors or unsettled jobs retain the fixture. This repairs
evidence loss; it does not establish or fix the unknown controller failure.
Fresh full validation and both complete independent reviews remain required.

The prerequisite's 13 focused installed checks passed in 2.6 seconds, including
the enforced and legacy occupied-workspace cases, the twelve-condition admission
matrix, successful/unknown/timeout diagnostic retention after fixture deletion,
missing evidence, symlink/path refusal and existing reviewer-log retrieval checks.
All 69 installed runtime files match source. These focused checks do not replace
the four unchanged required checks or the fresh independent reviews.

The first prerequisite candidate passed all four required checks: 487 installed
tests, 1,030 Node/eval passes with three optional skips, both live variants and
diff-check. The selected-provider log-access probe passed in 128.6 seconds with
one read per provider, four boundary contexts and 69 matching runtime files.
Full/automatic mode used 78,048/14,151 gateway payload tokens in 434.1/449.8 seconds.
The observed Claude model sets differed between variants; these results do not
establish controlled billing or speed savings. An independent retention audit
verified 87 copied files across five controllers after all original fixtures
were deleted, with missing assignment files explicitly recorded.

Both fresh reviews completed all 66 pages and accepted the original five criteria
and the corrected lease fixture. They found that the diagnostic-retention
criterion remained incomplete on two runtime-produced receipts: timeout omitted
the already-known controller directory, and rejected completion nested its
diagnostic references beneath `rejected_result`. Actual installed producer probes
confirmed both gaps. The owner-replacement test passed; the initial timeout probe
stopped on incorrect temporary-manifest permissions, and the corrected probe
reached the real timeout. Those diagnostic records remain separate from acceptance.

The second prerequisite repair constructs timeout receipts through the common
post-drain path, preserving controller identity, directory, runtime hash and
capture facts. The collector follows the rejected-result receipt with explicit
provenance, retains the original rejection and keeps the outer outcome unknown.
Tests connect actual timeout and owner-replacement receipts to collection and
fixture deletion, while preserving normal review/replay and owner-adoption
behavior. The earlier full-workflow failure remains unexplained; its lost stderr
cannot be reconstructed from these later successful checks. Fresh full validation
and complete independent reviews are required for this changed candidate.

All 13 focused checks for the second prerequisite repair passed against a fresh
installation in 63.3 seconds. They include the actual timeout-producer lifecycle,
the real owner-replacement/adoption path with diagnostic survival after cleanup,
normal authenticated review/repair/commit/replay, and existing retention and scoped
evidence-read checks. All 69 installed runtime files match source. Full required
validation and both complete independent reviews remain pending for this candidate.

## Protocol decoupled from isolation; wake semantics — 2026-11-09

A design review of the candidate above found that the message protocol reached
only enforced runs, although it does not depend on the sandbox, and that hint
delivery prompted agents about their own actions and about items they had
already read. This entry changes the contract's scope; it does not close P1–P3.

**Decision.** `communication.mode` now selects only the execution boundary and
its transport. `supervise.py init` no longer injects `enforced`: isolation is an
explicit choice, because it supports one local Linux host and a run whose host
cannot verify would initialize and then never admit work. Unconfined runs keep
their interface and gain the same protocol through it. This supersedes "existing
unconfined runs retain their current interface" in the contract only by addition.

**Unconfined transports.** The coordinator uses the new local `supervise.py
channel` command; a registered driver sends the same requests through its SSH
`serve` route. Both resolve a transport session: the gateway's session record,
created on first use for the caller the transport already identified, so scope,
task bindings, cursors, artifacts and wake state share one implementation. No
gateway or credential file is involved. The record follows the caller's current
scope, so a newly scoped or admitted task needs no relaunch there. The enforced
coordinator's scope is still fixed at issue; that finding remains open. Enforced
runs refuse both transports. In either mode a message to a driver without a
verified return route is now refused as `unreachable` instead of waiting in an
inbox nobody can read.

**Wake semantics, both modes.**

- An event records its `origin`. The originator is never hinted and its own
  events do not end its inbox `watch`, which also steps over pages holding only
  its own history. Explicit inbox reads still list them.
- `state_changed` hints the other party only when pause, cancellation, holds,
  delegation, recovery, blocker, driver or identity change, when the task parks
  or crosses closure, when a run-wide pause/cancel/hold changes, or when a task
  is first admitted. Other lifecycle steps and artifact publication are listed
  without a hint. Actionable integration notices are unchanged.
- A wake keeps the per-task position that caused it. `ack` retires the hint once
  no position lies beyond the actor's acknowledged cursors. Retirement follows
  explicit acknowledgement, not reads: a read persists nothing and a lost
  response must not suppress the only prompt.
- Delivery prompts only an `idle` or `done` agent. `working` defers without a
  failure count. Any other status is never typed into and is recorded as an
  unconfirmed delivery: a blocked pane may be showing an approval prompt.
- In an unconfined run the scheduler tick delivers at most one hint after its
  scheduled pass. A coordinator hint uses the registered scheduler identity,
  waits for a pending reconciliation wake to complete, and keeps
  `minimum_cadence_seconds` from the previous wake or hint; that hint in turn
  spaces the next wake. Drivers are hinted only through an explicitly bound
  endpoint.

Verification on Linux with Bubblewrap available, source tree, deterministic
providers and a fake Herdr throughout. `tests/test_legacy_channel.py` adds 12
checks of both transports, scope following, enforced refusal, the inbox watch,
the CLI and scheduled hints; `test_notify.py` gains six for origin, attention,
acknowledgement, artifacts and agent status, and `test_protocol.py` one for the
gateway watch. An untouched export of the preceding commit ran 489 tests with
one error: `jobs.namespace` raised `ProcessLookupError` reading `/proc/<pid>/ns/pid`
for an exiting process, which it does not treat as gone. The modified tree ran
508 tests with one failing: the first controller run in
`test_upstream_recovery_after_owner_replacement_and_history_change` returned
`unknown` with an empty stdout and a 3,195-byte stderr that cleanup deleted. That
test then passed alone, in its 24-test suite, and in about 50 further repetitions,
with one more failure of the same shape; 29 runs on the export never failed. Two
failures in roughly 54 runs against none in 29 does not separate the trees, and
the cause is unknown. The installation, orchestration-fixture and host-parity
checks passed (57), as did the evaluation fixture suites (164) and `git diff
--check`. No live pane, model or installation was exercised or changed.

Still open from the review and not addressed here: no exercise against a real
Herdr pane or an LLM coordinator, including whether a sandboxed agent can report
the `agent_session` that binding requires; the unnamed host-operator role;
polling reads under one state lock; permanent view snapshots and receipts; and
the cursor returned by `message`, which lies past the sender's own event.
