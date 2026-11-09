# Communication measurements

These development probes use disposable state. They do not modify active runs.
The JSON reports pin their measurement time, runtime hash, tokenizer and requested
model settings. Keep historical reports unchanged when the runtime changes.

`communication.py` compares full and automatic views plus every follow-up request
and response. Run it with Python containing `tiktoken`, for example:

```sh
python3 -B plugins/jig-orchestration/benchmarks/communication.py --output /tmp/payload-result.json
```

`live_communication.py` uses an explicitly supplied private launch profile. Its
`--help` lists provider, profile, model, effort, CLI version and output arguments.
The profile selects actual credentials and executable arguments; model labels
in the report do not override that command. Never check private profiles into Git.

`live_controller.py` exercises the installed controller and both selected review
adapters, with deterministic triage/repair on disposable source. Supply the
installed skills directory, private profiles, exact model/effort choices and a new
output directory outside the checkout; `--help` lists the arguments. This runner
uses each profile's credentials/tool mounts and the explicitly supplied review
model options. It records actual gateway artifact reads and fails if either
reviewer does not retrieve the validation marker, even if the controller reports
convergence. Its reports retain that distinction, raw assignment results and
installed runtime hashes. Full provider usage is currently unavailable on this
controller path and remains null, never zero.

`live_workflow.py` exercises two dependent implementations using the selected
Codex and Claude profiles, followed by the installed review controller with both
providers and model-backed triage/repair. A deterministic coordinator relays the
interface request and scoped source artifact through the gateway. The fixture
restarts the gateway with live writers, rejects overlapping replacement and stale
credentials, cancels and settles the old writers, and launches a replacement
model. Independent source checks run before and after review. Reviewers must
accept the original finite-integer-iterable domain, including generators and
single-use iterators; both source checks and required validation exercise it.
Separate startup probes run both selected providers as taskless coordinators
before admission. Cancellation is measured under eight authenticated query
clients plus 64 idle connections. These probes do not measure model coordination
quality. Reviewers must
retrieve the complete approved logs actually supplied to their assignment.
Initial reviews can precede validation; an assignment without log receipts is
recorded as evidence access not exercised. Supplied log parts must match the same
reviewer session and artifact hash, rather than just contain a marker. The
separate controller exercise above guarantees supplied-log access by both
providers even when this workflow converges without a repair/review pass.

```sh
python3 -B plugins/jig-orchestration/benchmarks/live_workflow.py \
  --installed-skills /absolute/path/to/disposable/skills \
  --claude-profile /private/path/claude.json \
  --codex-profile /private/path/codex.json \
  --output /tmp/new-private-measurement-directory
```

The default runs a full/automatic pair; `--order auto-first` reverses it.
`--variant full|auto` runs one diagnostic variant and cannot establish a paired
comparison. The interpreter needs `tiktoken`. Worker model commands come from the
private profiles; review uses the explicitly recorded `opus`/`gpt-6-astra`, `xhigh`
settings. The Codex worker profile must contain the verified named `channel`
permissions; implementation workers extend `:workspace`, while reviewers retain
read-only source access. Native provider output is retained by `live_model.py`
inside each launch and copied before settled fixture cleanup, including failed
invocations. No provider credentials or raw prompts belong in committed results.

Reports separate source acceptance, controller convergence, evidence retrieval,
recovery outcomes, gateway payload tokens and provider usage. They pin the
installed runtime and benchmark code. A diagnostic harness failure remains a
failed attempt even when the underlying capability worked. A paired run still
does not establish statistical savings, cold-cache costs, model-coordinator
quality or hosted PR/tracker delivery.

## 2026-11-08 observations

The fixed retrieval task contains 128 findings with two unresolved entries late
in the list. Both selected models returned their exact complete text in both
variants, through scoped artifacts. Each provider has only one paired run.

| Provider / requested settings | Full payload tokens | Auto payload tokens | Full seconds | Auto seconds |
| --- | ---: | ---: | ---: | ---: |
| Claude Code 2.1.319, `opus`, `xhigh` | 17,429 | 5,029 | 34.33 | 24.16 |
| Codex CLI 0.167.0, `gpt-6-astra`, `xhigh` | 34,667 | 1,518 | 22.52 | 36.58 |

Payload counts use tiktoken 0.12.0 / `o200k_base`, not a claim about either model's
native tokenizer or billing. Claude reported `claude-opus-5-5`; the Codex usage
events did not report an observed model ID. The JSON files separately preserve
provider input, cache and output usage. Codex automatic retrieval generated more
output tokens (1,164 versus 640) and took longer despite the smaller payload.

An initial Codex run retrieved nothing because its native read-only sandbox
denied the Unix socket. The successful run used the documented named permission
profile inside the verified outer namespace. A separate probe confirmed that
host credentials and direct internet connections remained inaccessible.

The deterministic cases include small views (no useful reduction), sparse open
findings and dense open findings. Earlier dense retrieval increased payload cost;
the `unresolved_findings` selector avoids resending resolved history.

These results establish working retrieval and a reason to retain automatic views.
They do not establish end-to-end delivery savings, statistical reliability,
tail latency, cold-cache costs, or a completed review-fix workflow. Run paired
whole-task comparisons before making those claims.

A separate disposable controller exercise then ran the selected live Claude
and Codex reviewers around deterministic triage and source repair. It reached
`CONVERGED` in 79.14 seconds, with both reviewers completed and all nine isolated
jobs locally settled. One malformed model report was retained and retried by the
controller before convergence. Eight model/fixture reports were published as
channel artifacts. The controller result JSON preserves these limits: this was
one task, not the final code panel, a restart/cancellation test, or a billing
comparison. It used direct checkout repair with `commit-mode=none`.

Later authenticated installed-controller checks used per-round commits and
required actual validation-log retrieval by both reviewers. The first two
attempts converged but failed that independent assertion because Claude lacked
client access, then its native permission rule denied heredocs. After the adapter
and argument-form fixes, both reviewers retrieved the approved logs and the
workflow completed in 115.04 seconds. The parameterized `live_controller.py`
runner then passed in 110.87 seconds and retained installed runtime hashes.
`results/2026-11-08-controller-channel.json` retains all four attempts and their
limits. These runs still use deterministic triage/repair, one task, and no
complete provider usage accounting; they do not establish delivery savings.
