#!/usr/bin/env bash
set -euo pipefail

AUDIT_FILE="${1:-$HOME/.openclaw/plugins/dual-identity/audit-$(date +%F).jsonl}"
GRAPH_JSON="${2:-/tmp/dual-identity-graph.json}"
RESULT_JSON="${3:-/tmp/dual-identity-model-results.json}"

python3 - <<'PY' "$AUDIT_FILE" "$GRAPH_JSON"
import json
import sys
from pathlib import Path
from datetime import datetime, timezone

audit_file = Path(sys.argv[1]).expanduser().resolve()
graph_json = Path(sys.argv[2]).expanduser().resolve()

events = []
for line in audit_file.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line:
        events.append(json.loads(line))


def timestamp_of(event):
    try:
        return datetime.fromisoformat(event.get("timestamp", "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def tool_category(name):
    normalized = str(name or "").strip().lower()
    if normalized in {"memory_search", "memory_get"}:
        return "memory"
    if normalized in {"message", "sessions_send"}:
        return "outbound"
    if normalized in {"write", "edit", "apply_patch", "exec"}:
        return "mutation"
    if normalized in {"sessions_spawn", "subagents"}:
        return "cross_agent"
    return "other"


def summarize_event(event):
    parts = [
        f"event={event.get('eventKind', '')}",
        f"authority={event.get('authorityOwnerId', 'unknown')}",
        f"acting={event.get('actingPrincipalId', 'unknown')}",
        f"trigger={event.get('triggerKind', 'unknown')}",
    ]
    if event.get("toolName"):
        parts.append(f"tool={event['toolName']}")
    if event.get("taskSummary"):
        parts.append(f"task={event['taskSummary']}")
    if event.get("note"):
        parts.append(f"note={event['note']}")
    return " | ".join(parts)


seen = {}
ordered_events = []
for index, event in enumerate(sorted(events, key=timestamp_of), start=1):
    base_id = event.get("eventId") or f"legacy-event-{index}"
    count = seen.get(base_id, 0)
    seen[base_id] = count + 1
    unique_id = base_id if count == 0 else f"{base_id}@{count + 1}"

    copied = dict(event)
    copied["originalEventId"] = event.get("eventId")
    copied["eventId"] = unique_id
    copied.setdefault("lineageSourceEventIds", [])
    copied.setdefault("lineageSourceQueries", [])
    copied.setdefault("lineageSourcePaths", [])
    copied["lineageInferred"] = False
    ordered_events.append(copied)

last_memory_by_session = {}
events_with_lineage = []
for event in ordered_events:
    session_key = event.get("sessionKey") or "__global__"
    prior_memory = last_memory_by_session.get(session_key)
    current = dict(event)

    if event.get("eventKind") == "tool_result_observed" and tool_category(event.get("toolName")) == "memory":
        features = event.get("modelFeatures") or {}
        queries = features.get("recentMemoryQueries") or []
        paths = features.get("recentMemoryPaths") or []
        last_memory_by_session[session_key] = {
            "eventId": event["eventId"],
            "query": queries[-1] if queries else features.get("query"),
            "path": paths[-1] if paths else features.get("path"),
        }
    elif prior_memory and not current.get("lineageSourceEventIds") and current.get("eventKind") in {
        "tool_result_persisted",
        "message_persist_blocked",
        "message_persist_observed",
        "subagent_handoff_declared",
        "cross_agent_handoff_blocked",
        "stateful_flow_blocked",
        "agent_tool_call",
    }:
        category = current.get("sinkKind") or (
            "persistence"
            if current.get("eventKind") == "tool_result_persisted"
            else "cross_agent"
            if current.get("eventKind") in {"subagent_handoff_declared", "cross_agent_handoff_blocked"}
            else tool_category(current.get("toolName"))
        )
        if category in {"outbound", "mutation", "persistence", "cross_agent"}:
            current["lineageSourceEventIds"] = [prior_memory["eventId"]]
            current["lineageSourceQueries"] = [prior_memory["query"]] if prior_memory.get("query") else []
            current["lineageSourcePaths"] = [prior_memory["path"]] if prior_memory.get("path") else []
            current["sinkKind"] = category
            current["lineageInferred"] = True

    events_with_lineage.append(current)

nodes = []
edges = []
samples = []

for event in events_with_lineage:
    nodes.append(
        {
            "id": event["eventId"],
            "type": event.get("eventKind"),
            "sessionKey": event.get("sessionKey"),
            "authorityOwnerId": event.get("authorityOwnerId"),
            "actingPrincipalId": event.get("actingPrincipalId"),
            "triggerKind": event.get("triggerKind"),
            "toolName": event.get("toolName"),
            "taskContractId": event.get("taskContractId"),
            "taskSummary": event.get("taskSummary"),
            "expectedArtifactKinds": event.get("expectedArtifactKinds", []),
            "forbiddenInformationFlows": event.get("forbiddenInformationFlows", []),
            "lineageFlags": event.get("lineageFlags", []),
            "propertyTags": event.get("propertyTags", []),
            "modelFeatures": event.get("modelFeatures", {}),
            "lineageSourceEventIds": event.get("lineageSourceEventIds", []),
            "lineageSourceQueries": event.get("lineageSourceQueries", []),
            "lineageSourcePaths": event.get("lineageSourcePaths", []),
            "sinkKind": event.get("sinkKind"),
            "timestamp": event.get("timestamp"),
            "note": event.get("note", ""),
            "lineageInferred": bool(event.get("lineageInferred")),
            "originalEventId": event.get("originalEventId"),
        }
    )

    if event.get("parentEventId"):
        edges.append(
            {
                "source": event["parentEventId"],
                "target": event["eventId"],
                "type": "causal",
            }
        )

    for source_event_id in event.get("lineageSourceEventIds", []):
        edges.append(
            {
                "source": source_event_id,
                "target": event["eventId"],
                "type": "memory_lineage",
            }
        )

    if event.get("parentSessionKey") and event.get("childSessionKey"):
        edges.append(
            {
                "source": event["parentSessionKey"],
                "target": event["childSessionKey"],
                "type": "handoff_session",
            }
        )

    samples.append(
        {
            "eventId": event["eventId"],
            "label": event.get("triggerKind") or "unknown",
            "text": summarize_event(event),
            "sessionKey": event.get("sessionKey"),
            "propertyTags": event.get("propertyTags", []),
            "lineageSourceEventIds": event.get("lineageSourceEventIds", []),
        }
    )

graph_json.write_text(
    json.dumps(
        {
            "metadata": {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "sourceFile": str(audit_file),
                "nodeCount": len(nodes),
                "edgeCount": len(edges),
                "sampleCount": len(samples),
            },
            "nodes": nodes,
            "edges": edges,
            "attributionSamples": samples,
        },
        indent=2,
    ),
    encoding="utf-8",
)
PY

python3 extensions/dual-identity/train_attribution_models.py \
  --input "$GRAPH_JSON" \
  --output "$RESULT_JSON"

printf 'graph=%s\n' "$GRAPH_JSON"
printf 'results=%s\n' "$RESULT_JSON"
