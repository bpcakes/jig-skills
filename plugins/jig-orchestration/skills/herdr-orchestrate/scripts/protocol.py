"""Durable messages, scoped artifacts and event cursors for the canonical channel.

Mutations run only inside Engine.apply's existing journaled transaction. Artifact
bytes are written first; a crash can leave an unreachable blob, never a published
reference to an incomplete file. None of these records confer lifecycle authority.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import secrets

import channel
from state import Engine, StateError, canonical, private, require, timestamp, write_bytes_atomic

MUTATIONS = {"message", "artifact_put", "ack"}
READS = {"inbox", "message_read", "artifact_read", "result"}
EVENT_LIMIT = 512
ARTIFACT_LIMIT = 512 * 1024


def data(state):
    current = channel.data(state)
    if "epoch" not in current:
        current.update(epoch=secrets.token_hex(16), sequence=0, floor=0, events=[],
                       messages={}, artifacts={}, acknowledgements={}, wakes={})
    return current


def event(state, task_id, kind, readers, **fields):
    current = data(state)
    current["sequence"] += 1
    record = {"sequence": current["sequence"], "task_id": task_id, "kind": kind,
              "readers": sorted(set(readers)), **fields}
    current["events"].append(record)
    if len(current["events"]) > EVENT_LIMIT:
        current["floor"] = current["events"].pop(0)["sequence"]
    for reader in record["readers"]:
        previous = current["wakes"].get(reader, {})
        current["wakes"][reader] = {**previous, "sequence": record["sequence"], "delivered": False,
                                   "pending_since": (previous.get("pending_since")
                                                     if not previous.get("delivered", True) else None) or timestamp()}
    return record


def state_changed(state, request):
    """Called before the state/action journal is committed, not after delivery."""
    if "communication" not in state or request["op"] in MUTATIONS | {"scheduler"}:
        return
    task_id = request.get("task_id")
    tasks = [state["tasks"][task_id]] if task_id in state["tasks"] else list(state["tasks"].values())
    for task in tasks:
        event(state, task["id"], "state_changed", ["coordinator", task["driver"]],
              action_id=request["action_id"], task_version=task["version"], policy_version=state["policy_version"])


def integration_changed(state, before):
    if "communication" not in state:
        return
    from integration import view
    for task_id, task in state["tasks"].items():
        if canonical(view(before, task_id)[1]) != canonical(view(state, task_id)[1]):
            event(state, task_id, "integration_changed", ["coordinator", task["driver"]], task_version=task["version"])


def participants(state, task_id):
    task = state["tasks"].get(task_id)
    require(task is not None, "scope", "an admitted task is required")
    actors = {"coordinator", task["driver"]}
    communication = state.get("communication", {})
    for actor, identifier in communication.get("active", {}).items():
        record = communication["sessions"][identifier]
        if record["role"] == "executor" and task_id in record["task_ids"] and not record["revoked"]:
            try:
                channel.check(state, channel.Session(identifier, record["digest"]), task_id=task_id)
            except StateError:
                continue
            actors.add(actor)
    return actors


def artifact_visible(record, principal, session):
    contract = principal.get("review_contract") or {}
    if record["id"] in contract.get("artifact_ids", []):
        return True
    if principal["role"] == "reviewer":
        return record["owner_session"] == session.id
    return principal["actor"] in record["readers"]


def artifact(current, artifact_id, task_id, principal, session):
    require(isinstance(artifact_id, str), "invalid", "artifact id must be a string")
    record = current["artifacts"].get(artifact_id)
    require(record is not None and record["task_id"] == task_id and artifact_visible(record, principal, session),
            "artifact", "artifact is unavailable in this session and task")
    return record


def write_blob(run_dir, content):
    raw = content.encode("utf-8")
    require(len(raw) <= ARTIFACT_LIMIT, "size", "artifact exceeds 512 KiB; no content was published")
    digest = hashlib.sha256(raw).hexdigest()
    directory = Path(run_dir) / "artifacts"
    directory.mkdir(mode=0o700, exist_ok=True)
    private(directory, directory=True)
    destination = directory / digest
    from storage import reserve
    reserve(run_dir, {str(destination.relative_to(run_dir)): len(raw)})
    if destination.exists():
        private(destination)
        require(hashlib.sha256(destination.read_bytes()).hexdigest() == digest,
                "artifact", "stored artifact integrity check failed")
    else:
        write_bytes_atomic(destination, raw)
        destination.chmod(0o400)
    return digest, len(raw)


def position(current, cursor):
    require(isinstance(cursor, str), "cursor", "an event cursor is required")
    epoch, separator, number = cursor.partition(":")
    require(separator and epoch == current["epoch"] and number.isdecimal() and len(number) <= 20,
            "cursor", "cursor belongs to another run or is invalid")
    value = int(number)
    require(0 <= value <= current["sequence"], "cursor", "cursor is ahead of durable events")
    return value


def cursor(current, sequence):
    return current["epoch"] + ":" + str(sequence)


def transition(state, request, principal, session, run_dir):
    current = data(state)
    task_id, actor, operation = request.get("task_id"), principal["actor"], request["op"]
    require(len(request["action_id"]) <= 200, "invalid", "communication action ids are limited to 200 characters")
    require(task_id in principal["task_ids"], "scope", "communication mutations require an assigned task")
    allowed = participants(state, task_id)
    if operation == "artifact_put":
        content = request.get("content")
        require(isinstance(content, str), "invalid", "artifact content must be UTF-8 text, never a host path")
        readers = request.get("readers", [actor, "coordinator"])
        require(isinstance(readers, list) and all(isinstance(reader, str) for reader in readers)
                and set(readers) <= allowed | {actor}, "scope", "artifact readers must belong to this task")
        if principal["role"] == "reviewer":
            require(set(readers) <= {actor, "coordinator"}, "scope", "reviewer reports are private")
        digest, length = write_blob(run_dir, content)
        artifact_id = hashlib.sha256(canonical([task_id, actor, request["action_id"]]).encode()).hexdigest()
        record = {"id": artifact_id, "task_id": task_id, "owner": actor, "owner_session": session.id,
                  "readers": sorted(set(readers) | {actor}), "sha256": digest, "bytes": length,
                  "created_at": timestamp()}
        current["artifacts"][artifact_id] = record
        notice = event(state, task_id, "artifact_ready", record["readers"], artifact_id=artifact_id)
        record["sequence"] = notice["sequence"]
        return {"artifact": {key: record[key] for key in ("id", "sha256", "bytes", "task_id")}}
    if operation == "message":
        recipient, kind, body = request.get("recipient"), request.get("kind"), request.get("body")
        require(isinstance(recipient, str) and actor in allowed and recipient in allowed and actor != recipient,
                "scope", "messages require distinct coordinator/driver participants in the same task")
        require(isinstance(kind, str) and kind in {"question", "reply", "update", "assignment"}, "invalid", "unsupported message kind")
        require(kind != "assignment" or actor == "coordinator", "forbidden", "only coordinator can assign work")
        if kind == "question":
            require(len(open_questions(current, actor, task_id)) < 64,
                    "capacity", "answer existing questions before opening more than 64 per task")
        require(isinstance(body, str) and 0 < len(body.encode()) <= 4096,
                "size", "message body must contain 1 to 4096 UTF-8 bytes; attach larger evidence")
        attachments = request.get("artifacts", [])
        require(isinstance(attachments, list) and len(attachments) <= 16, "invalid", "too many artifact references")
        for identifier in attachments:
            record = artifact(current, identifier, task_id, principal, session)
            require(recipient in record["readers"], "scope", "recipient cannot read the attached artifact")
        reply_to = request.get("reply_to")
        if kind == "reply":
            require(isinstance(reply_to, str), "invalid", "reply must name a question")
            question = current["messages"].get(reply_to)
            require(question is not None and question["kind"] == "question" and question["task_id"] == task_id
                    and question["sender"] == recipient and question["recipient"] == actor,
                    "scope", "reply does not belong to this question and participants")
            require(question.get("answered_by") is None, "answered", "question already has a durable reply")
            question["answered_by"] = request["action_id"]
        else:
            require(reply_to is None, "invalid", "only a reply can reference a question")
        message = {"id": request["action_id"], "task_id": task_id, "sender": actor,
                   "recipient": recipient, "kind": kind, "body": body, "artifacts": attachments,
                   "reply_to": reply_to, "created_at": timestamp()}
        current["messages"][message["id"]] = message
        notice = event(state, task_id, "message", [actor, recipient], message_id=message["id"])
        message["sequence"] = notice["sequence"]
        return {"message_id": message["id"], "cursor": cursor(current, notice["sequence"]), "accepted": True}
    if operation == "ack":
        sequence = position(current, request.get("cursor"))
        key = canonical([actor, task_id])
        current["acknowledgements"][key] = max(sequence, current["acknowledgements"].get(key, 0))
        return {"acknowledged": cursor(current, current["acknowledgements"][key]), "effect_confirmed": False}
    raise AssertionError("unhandled communication mutation")


def open_questions(current, actor, task_id):
    return [message["id"] for message in current["messages"].values()
            if message["task_id"] == task_id and actor in {message["sender"], message["recipient"]}
            and message["kind"] == "question" and not message.get("answered_by")]


def retained_notices(current, actor, task_id, principal, session, after):
    """Durable deliveries outlive the bounded state-change notification window."""
    records = []
    if principal["role"] != "reviewer":
        records.extend((message, "message", "message_id") for message in current["messages"].values()
                       if message["task_id"] == task_id and actor in {message["sender"], message["recipient"]})
    records.extend((record, "artifact_ready", "artifact_id") for record in current["artifacts"].values()
                   if record["task_id"] == task_id and artifact_visible(record, principal, session))
    for record, kind, key in records:
        sequence = record.get("sequence")
        require(type(sequence) is int and 0 < sequence <= current["sequence"], "incompatible",
                "retained communication lacks its delivery position; use its compatible runtime")
        if after < sequence <= current["floor"]:
            yield {"sequence": sequence, "task_id": task_id, "kind": kind, key: record["id"]}


def read(run_dir, session, request):
    state = Engine.read(run_dir)
    operation, task_id = request["op"], request.get("task_id")
    principal = channel.check(state, session, operation=operation, task_id=task_id)
    require(task_id in principal["task_ids"], "scope", "communication reads require an assigned task")
    current = data(state)
    actor = principal["actor"]
    if operation == "inbox":
        limit = request.get("limit", 16)
        require(type(limit) is int and 1 <= limit <= 32, "invalid", "inbox limit must be 1 to 32")
        after = (position(current, request["after"]) if "after" in request
                 else current["acknowledgements"].get(canonical([actor, task_id]), 0))
        visible = [notice for notice in current["events"] if notice["sequence"] > after
                   and notice["task_id"] == task_id and actor in notice["readers"]]
        if principal["role"] == "reviewer":
            visible = [notice for notice in visible if notice["kind"] == "artifact_ready"
                       and artifact_visible(current["artifacts"][notice["artifact_id"]], principal, session)]
        resync = after < current["floor"]
        if resync:
            visible.extend(retained_notices(current, actor, task_id, principal, session, after))
            visible.sort(key=lambda notice: notice["sequence"])
        records = []
        for notice in visible[:limit]:
            item = {key: value for key, value in notice.items() if key != "readers"}
            if notice["kind"] == "message":
                item["message"] = current["messages"][notice["message_id"]]
            records.append(item)
        more = len(visible) > limit
        end = records[-1]["sequence"] if more else current["sequence"]
        next_cursor = cursor(current, end)
        next_request = ({"op": "inbox", "task_id": task_id, "after": next_cursor, "limit": limit} if more else
                        {"op": "watch", "task_id": task_id, "view": "inbox", "after": next_cursor,
                         "timeout_seconds": 30})
        return {"events": records, "cursor": next_cursor, "more": more, "next_request": next_request,
                "resync_required": resync, "open_questions": open_questions(current, actor, task_id)}
    if operation == "artifact_read":
        record = artifact(current, request.get("artifact_id"), task_id, principal, session)
        offset, length = request.get("offset", 0), request.get("limit", 16384)
        require(type(offset) is int and offset >= 0 and type(length) is int and 1 <= length <= 65536,
                "invalid", "artifact reads need a nonnegative character offset and limit 1 to 65536")
        path = Path(run_dir) / "artifacts" / record["sha256"]
        private(path)
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == record["sha256"], "artifact", "artifact integrity check failed")
        content = raw.decode("utf-8")
        require(offset <= len(content), "invalid", "offset is beyond the artifact")
        end = min(offset + length, len(content))
        return {"artifact_id": record["id"], "sha256": record["sha256"], "offset": offset,
                "next_offset": end, "total_characters": len(content), "complete": end == len(content),
                "content": content[offset:end]}
    if operation == "message_read":
        identifier = request.get("message_id")
        require(isinstance(identifier, str), "invalid", "message id must be a string")
        message = current["messages"].get(identifier)
        require(message is not None and message["task_id"] == task_id
                and actor in {message["sender"], message["recipient"]}, "scope", "message is unavailable for this actor and task")
        return {"message": message}
    if operation == "result":
        record = Engine.action(run_dir, request.get("action_id"))
        require(record is not None and record["request"].get("task_id") == task_id
                and (record["caller"] == actor or principal["role"] == "coordinator"),
                "scope", "action is unavailable for this actor and task")
        return {"result": record["result"]}
    raise AssertionError("unhandled communication read")
