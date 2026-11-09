"""Exercise installed selected reviewers and prove approved-log retrieval.

Uses disposable source/state with deterministic triage and repair. This is not
the final source panel, a two-task delivery test, or a provider billing benchmark.
Private provider profiles are explicit inputs and are never copied to the report.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import json
import os
import secrets
import sys
import time

from workflow_evidence import retain_controller

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--installed-skills', required=True, type=Path)
parser.add_argument('--claude-profile', required=True, type=Path)
parser.add_argument('--codex-profile', required=True, type=Path)
parser.add_argument('--claude-model', required=True)
parser.add_argument('--claude-effort', required=True)
parser.add_argument('--codex-model', required=True)
parser.add_argument('--codex-effort', required=True)
parser.add_argument('--output', required=True, type=Path, help='New directory outside the checkout')
args = parser.parse_args()
installation = str(args.installed_skills.resolve(strict=True))
os.environ['JIG_ORCHESTRATION_TEST_SCRIPTS'] = installation + '/herdr-orchestrate/scripts'
os.environ['JIG_REVIEW_TEST_SKILL_ROOT'] = installation + '/review-fix-loop'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
from test_review_controller import ReviewControllerTests
from test_channel import Engine, channel, communicate, gateway

output = args.output.resolve()
checkout = Path(__file__).resolve().parents[3]
if output == checkout or checkout in output.parents:
    parser.error('put private execution evidence outside the source checkout')
output.mkdir(mode=0o700, parents=True, exist_ok=False)
fixture = ReviewControllerTests('test_authenticated_review_repairs_commits_and_replay_reuses_completion')
fixture.setUpClass()
fixture.setUp()
started = time.monotonic()
observations = []
original = gateway.handle
def observed(run_dir, session, payload, *args, **kwargs):
    result = original(run_dir, session, payload, *args, **kwargs)
    if payload.get('op') in {'context', 'artifact_read'}:
        principal = channel.check(Engine.read(run_dir), session, task_id=payload.get('task_id'))
        observations.append({'op':payload['op'], 'role':principal['role'],
            'provider':(principal.get('review_contract') or {}).get('provider'),
            'artifact_id':payload.get('artifact_id'), 'complete':result.get('complete'),
            'source_access':result.get('source_access'), 'content':result.get('content')})
    return result
gateway.handle = observed
collected = False
try:
    controller = fixture.adapter['controller']
    for name in ('claude', 'codex'):
        profile = json.loads(getattr(args, name + '_profile').read_text())
        command = profile.pop('argv', None)
        profile['mounts'] += [{'source':fixture.node,'target':'/opt/tools/node'},
                              {'source':installation,'target':'/opt/tools/review-skills'}]
        variable = 'JIG_' + name.upper() + '_BIN'
        environment = profile.setdefault('environment', {})
        if variable not in environment:
            if not command:
                raise ValueError(f'{name} profile needs argv or {variable}')
            environment[variable] = command[0]
        controller['profiles'][name] = profile
    controller['config']['reviewers'] = [
        {'id':name, 'command':[fixture.node, installation + '/review-fix-loop/scripts/provider-bridge.mjs', name]}
        for name in ('claude','codex')]
    controller['config']['timeoutMs'] = 240000
    fixture.adapter['timeout_seconds'] = 900
    options = controller['options']
    options[options.index('--reviewers')+1] = 'claude,codex'
    options += ['--claude-model',args.claude_model,'--claude-effort',args.claude_effort,'--claude-launcher','none',
                '--codex-runtime','cli','--codex-model',args.codex_model,'--codex-effort',args.codex_effort,'--codex-launcher','none']
    controller['profiles']['validate'] = copy.deepcopy(controller['profiles']['validate'])
    nonce = secrets.token_hex(12)
    controller['profiles']['validate']['environment']['VALIDATION_NONCE'] = nonce
    validation = controller['contract']['requiredValidation'][0]
    validation['requiredEnvironment'] = ['VALIDATION_NONCE']
    validation['argv'][-1] += ";console.log('validation-marker:'+process.env.VALIDATION_NONCE)"
    controller['contract']['compatibilityConstraints'].append(
        'When validation evidence supplies logArtifact references, retrieve their ordered parts using the canonical communication client before the final acceptance report; record the observed validation marker as evidence.')
    fixture.configure()
    request = fixture.request('live-selected-reviewers')
    result = communicate.request(request, socket_path=str(fixture.run/'endpoint/gateway.sock'), credential=fixture.token, timeout=920)
    (output/'result.json').write_text(json.dumps(result,indent=2))
    (output/'channel-observations.json').write_text(json.dumps(observations,indent=2))
    retain_controller(result, run=fixture.run, workspace=fixture.workspace,
                      destination=output/'controller-output')
    collected = True
    controller_result = result.get('receipt',{}).get('controller',{})
    reads = {name:sum(row['op']=='artifact_read' and row['provider']==name and nonce in (row.get('content') or '') for row in observations)
             for name in ('claude','codex')}
    runtime = {str(file.relative_to(installation)): hashlib.sha256(file.read_bytes()).hexdigest()
               for skill in ('herdr-orchestrate','panel-review','review-fix-loop')
               for file in sorted((Path(installation)/skill/'scripts').rglob('*'))
               if file.is_file() and '__pycache__' not in file.parts}
    summary={'installed':installation,'seconds':time.monotonic()-started,'outcome':result.get('outcome'),
        'phase':controller_result.get('phase'),'selected_options':options,'validation_log_reads':reads,
        'boundary_contexts':sum(row['op']=='context' for row in observations),
        'synthetic_roles':['triage','repair'],'live_roles':['review'],
        'provider_usage':None,'final_panel':False,'output':str(output),'runtime_sha256':runtime}
    (output/'summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary),flush=True)
    fixture.assert_completed(result)
    assert all(reads.values()), reads
finally:
    gateway.handle = original
    settled = all(job.get('local_settled') for job in
                  Engine.read(fixture.run).get('communication',{}).get('jobs',{}).values())
    if collected and settled:
        fixture.doCleanups()
    else:
        fixture.temp._finalizer.detach()
        print(json.dumps({'fixture_retained':str(fixture.root), 'collection_complete':collected,
                          'all_jobs_settled':settled}), flush=True)
