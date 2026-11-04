"""Typed prerequisite policy; evidence uses the helper's existing receipt trust boundary."""
from state import Engine, evidence, nonempty, require, task_complete
from integration import OID


def register_dependency(state, task, req):
    dependency = req.get("dependency", {})
    require(isinstance(dependency, dict) and set(dependency) <= {"task_id", "kind", "pr", "head"},
            "dependency", "dependency needs task_id, kind, and source/merge PR and exact head")
    child, kind = dependency.get("task_id"), dependency.get("kind")
    require(nonempty(child) and child in state["tasks"] and isinstance(kind, str) and kind in {"source", "merge", "acceptance"},
            "dependency", "name an admitted prerequisite and source, merge or acceptance kind")
    Engine._acyclic_dependencies(state, task["id"], [child])
    proof = req.get("evidence")
    evidence(proof, settled=True)
    require(nonempty(req.get("reason")), "evidence", "explain the dependency classification")
    key = f"{child}:{kind}"
    if kind in {"source", "merge"}:
        require(type(dependency.get("pr")) is int and dependency["pr"] > 0
                and isinstance(dependency.get("head"), str) and OID.fullmatch(dependency["head"]), "dependency", "pin the prerequisite PR and full commit OID")
    if kind == "source":
        require(proof.get("head") == dependency["head"] and proof.get("pr") == dependency["pr"]
                and proof.get("published") is True and proof.get("focused_checks") is True,
                "evidence", "source readiness needs published exact-head focused-check evidence")
    record = {**dependency, "evidence": proof, "reason": req["reason"]}
    task.setdefault("dependency_history", []).append(record)
    task.setdefault("dependencies", {})[key] = record
    return {"dependency": record}


def check_dependencies(state, task, kind):
    typed = task.get("dependencies", {})
    for child in set(task.get("recovery_dependencies", [])) - {d["task_id"] for d in typed.values()}:
        require(task_complete(state["tasks"].get(child, {})), "dependency",
                "unclassified recovery prerequisites must complete before continuation")
    for dependency in typed.values():
        child = dependency["task_id"]
        prerequisite = state["tasks"].get(child, {})
        if dependency["kind"] == "acceptance":
            if kind in {"deploy", "close"}:
                require(task_complete(prerequisite), "dependency", "acceptance prerequisite remains incomplete")
        elif kind in {"merge", "deploy", "close"}:
            landed = prerequisite.get("merged_prs", {}).get(str(dependency["pr"]), {})
            require(landed.get("head") == dependency["head"] and nonempty(landed.get("merge_commit")),
                    "dependency", "the pinned prerequisite PR must land before downstream merge or acceptance")


def check_incorporation(state, task, req):
    proofs = req.get("gates", {}).get("dependency_incorporation", {})
    require(isinstance(proofs, dict), "evidence", "dependency incorporation must map dependency IDs to evidence")
    for key, dependency in task.get("dependencies", {}).items():
        if dependency["kind"] == "acceptance":
            continue
        proof = proofs.get(key, {})
        require(isinstance(proof, dict), "evidence", "dependency incorporation requires an evidence object")
        evidence(proof)
        landed = state["tasks"][dependency["task_id"]]["merged_prs"][str(dependency["pr"])]
        require(proof.get("head") == dependency["head"] and proof.get("merge_commit") == landed["merge_commit"]
                and proof.get("candidate_head") == req["target"]["head"]
                and proof.get("target") == state["config"]["repository"]["target"]
                and proof.get("source_incorporated") is True and proof.get("target_incorporated") is True,
                "dependency", "verify pinned source in the downstream candidate and its landing in the live target")
