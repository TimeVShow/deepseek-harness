#!/usr/bin/env python3
"""Re-score one frozen T10 F-A result against the acceptance rules.

The input is the runner's original stdout (the line carrying ``T10_RESULT``).
The script never calls a model and never rewrites the source record; it prints
one JSON object with every rule's outcome and the resulting verdict.

Frozen rules (from agent-flow-e2e-test-plan-2026-11-05.md):
- every node keeps the run's CASE marker in its final message;
- the writer's brief has the three required headings, at most 120 words, and
  ends with T10-DONE;
- the checker reports CHECK-PASS and T10-CHECKED;
- no tool calls, one request per node, and the deepseek-flash route.
"""

from __future__ import annotations

import json
import re
import sys

CASE = "T10-FA-01"
CASE_MARKER = f"[CASE:{CASE}]"
ROUTE = "deepseek-official/deepseek-flash"
REQUIRED_HEADINGS = ("## Location", "## Opening hours", "## Borrow and return rules")


def load_result(path: str) -> dict:
    text = open(path, encoding="utf-8").read()
    for line in text.splitlines():
        if line.startswith("T10_RESULT "):
            return json.loads(line[len("T10_RESULT "):])
    raise SystemExit(f"no T10_RESULT line in {path}")


def word_count(handoff: str) -> int:
    body = handoff
    for heading in REQUIRED_HEADINGS:
        body = body.replace(heading, " ")
    body = body.replace("T10-DONE", " ").replace(CASE_MARKER, " ")
    return len(re.findall(r"[A-Za-z0-9’'-]+", body))


def rescore(result: dict) -> dict:
    nodes = {node["nodeId"]: node for node in result.get("nodes", [])}
    writer = nodes.get("writer", {})
    checker = nodes.get("checker", {})
    writer_handoff = writer.get("handoff", "")
    checker_handoff = checker.get("handoff", "")

    checks = {
        "completed": result.get("status") == "completed",
        "nodes_succeeded": all(node.get("status") == "succeeded" for node in nodes.values()) and len(nodes) == 2,
        "iterations_zero": all(node.get("iteration") == 0 for node in nodes.values()),
        "case_retained": all(CASE_MARKER in node.get("handoff", "") for node in nodes.values()),
        "headings": all(heading in writer_handoff for heading in REQUIRED_HEADINGS),
        "word_limit": word_count(writer_handoff) <= 120,
        "ends_done": writer_handoff.rstrip().endswith("T10-DONE"),
        "checker_pass": "CHECK-PASS" in checker_handoff and "T10-CHECKED" in checker_handoff,
        "no_tools": all(node.get("toolCalls", 0) == 0 for node in nodes.values()),
        "one_request_per_node": all(node.get("requests") == 1 for node in nodes.values()),
        "route": all(node.get("routes") == [ROUTE] for node in nodes.values()),
    }
    return {
        "case": result.get("case"),
        "runId": result.get("runId"),
        "status": result.get("status"),
        "original": {
            "checks": result.get("checks"),
            "accepted": result.get("accepted"),
        },
        "rescored": {
            "checks": checks,
            "writerWords": word_count(writer_handoff),
            "accepted": all(checks.values()),
        },
        "note": (
            "The CASE marker is an explicit task requirement (the test plan asks every "
            "node to retain it), so the missing marker in the writer's handoff keeps the "
            "frozen verdict failed even though the content checks pass."
        ),
    }


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "t10-fa-original-2026-11-08.out"
    print(json.dumps(rescore(load_result(path)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
