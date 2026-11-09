"""Aggregate provider-native counters without turning missing usage into zero.

Counter names retain each provider's meaning. In particular, cached Codex input
is a subset of input_tokens; it is never added to that field. Claude cache fields
remain separate. Reported costs are provider estimates, not verified invoices.
"""
from collections import defaultdict


def summarize(invocations):
    providers = defaultdict(list)
    for invocation in invocations:
        if invocation.get("model_request", True):
            providers[invocation["provider"]].append(invocation)
    result = {}
    for provider, calls in providers.items():
        records, missing = [], 0
        for call in calls:
            usage = call.get("usage")
            selected = [usage] if isinstance(usage, dict) else usage if isinstance(usage, list) else []
            if not selected or any(not isinstance(row, dict) or not row for row in selected):
                missing += 1
            records.extend(row for row in selected if isinstance(row, dict) and row)
        keys = sorted({key for row in records for key, value in row.items() if type(value) in {int, float}})
        counters = {}
        for key in keys:
            known = [row[key] for row in records if type(row.get(key)) in {int, float}]
            absent = len(records) - len(known)
            counters[key] = {"total": sum(known) if not missing and not absent else None,
                             "known_subtotal": sum(known), "missing_records": absent}
        costs = [call.get("reported_cost_usd") for call in calls]
        result[provider] = {
            "model_invocations": len(calls), "successful_exits": sum(call.get("returncode") == 0 for call in calls),
            "missing_usage_invocations": missing, "native_counters": counters,
            "reported_cost_usd": sum(costs) if all(type(cost) in {int, float} for cost in costs) else None,
            "observed_models": sorted({name for call in calls for name in call.get("observed_models", [])}),
            "requested_models": sorted({call["requested_model"] for call in calls if call.get("requested_model")}),
            "cli_versions": sorted({call["cli_version"] for call in calls if call.get("cli_version")}),
        }
    return result
