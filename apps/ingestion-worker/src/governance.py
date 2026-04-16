"""
Governance intercepts and event logging.

Two intercept points:
  GovernanceIntercept  — wraps individual tool calls inside AgentExecutor
  GovernanceIntercept2 — filters combined context before the final LLM prompt
                         (Pipeline Path)

Both write to governance_events via the existing psycopg2 pattern in db.py.
Neither raises — governance failures are logged but never interrupt the query path.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from config import config

logger = logging.getLogger(__name__)

# ── Sensitive patterns ──────────────────────────────────────────────────────────

_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
_CC_RE = re.compile(r"\b(?:\d[ -]?){13,16}\b")
_PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")

_CONFIDENTIAL_MARKERS: frozenset[str] = frozenset([
    "confidential", "top secret", "internal only", "do not distribute",
    "proprietary", "trade secret", "restricted",
])

_BUILTIN_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("ssn", _SSN_RE),
    ("email", _EMAIL_RE),
    ("credit_card", _CC_RE),
    ("phone", _PHONE_RE),
]


# ── Data classes ────────────────────────────────────────────────────────────────

@dataclass
class DetectedItem:
    pattern_type: str
    match: str
    position: int


@dataclass
class GovernanceCheckResult:
    is_flagged: bool
    detected: list[DetectedItem] = field(default_factory=list)
    redacted_text: str = ""


# ── Core scan ───────────────────────────────────────────────────────────────────

def check_text(
    text: str,
    extra_keywords: list[str] | None = None,
) -> GovernanceCheckResult:
    """
    Scan text for PII patterns and confidential markers.
    Returns GovernanceCheckResult with detected items and redacted version.
    Never raises.
    """
    if not config.governance_intercept_enabled:
        return GovernanceCheckResult(is_flagged=False, redacted_text=text)

    try:
        detected: list[DetectedItem] = []

        for pattern_type, regex in _BUILTIN_PATTERNS:
            for m in regex.finditer(text):
                detected.append(DetectedItem(
                    pattern_type=pattern_type,
                    match=m.group(),
                    position=m.start(),
                ))

        text_lower = text.lower()
        for marker in _CONFIDENTIAL_MARKERS:
            idx = text_lower.find(marker)
            if idx != -1:
                detected.append(DetectedItem(
                    pattern_type="confidential_marker",
                    match=text[idx:idx + len(marker)],
                    position=idx,
                ))

        all_keywords = list(extra_keywords or []) + config.sensitive_keywords_extra
        for kw in all_keywords:
            idx = text_lower.find(kw.lower())
            if idx != -1:
                detected.append(DetectedItem(
                    pattern_type="keyword",
                    match=text[idx:idx + len(kw)],
                    position=idx,
                ))

        if not detected:
            return GovernanceCheckResult(is_flagged=False, redacted_text=text)

        redacted = _redact(text, detected)
        return GovernanceCheckResult(is_flagged=True, detected=detected, redacted_text=redacted)

    except Exception:
        logger.warning("check_text failed; treating as not flagged", exc_info=True)
        return GovernanceCheckResult(is_flagged=False, redacted_text=text)


def _redact(text: str, detected: list[DetectedItem]) -> str:
    """Replace each detected match with [REDACTED:<type>]."""
    # Sort by position descending so replacements don't shift offsets
    items = sorted(detected, key=lambda d: d.position, reverse=True)
    for item in items:
        placeholder = f"[REDACTED:{item.pattern_type}]"
        text = text[: item.position] + placeholder + text[item.position + len(item.match):]
    return text


# ── DB write ────────────────────────────────────────────────────────────────────

def insert_governance_event(
    conn,
    *,
    event_type: str,
    intercept_point: str,
    user_id: str,
    tenant_id: str,
    plan_run_id: str,
    agent_iteration: int | None,
    step_index: int | None,
    tool_name: str | None,
    detected: list[DetectedItem],
    action_taken: str,
    pii_redacted: bool,
) -> None:
    """
    Append-only INSERT to governance_events. id and timestamp use DB defaults.
    Mirrors the cursor → execute → commit pattern in db.py.
    Never raises — logs on failure.
    """
    try:
        detected_json = json.dumps([
            {"type": d.pattern_type, "match": d.match, "pos": d.position}
            for d in detected
        ])
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO governance_events
                  (event_type, intercept_point, user_id, tenant_id, plan_run_id,
                   agent_iteration, step_index, tool_name, detected, action_taken, pii_redacted)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                """,
                (
                    event_type, intercept_point,
                    user_id, tenant_id, plan_run_id,
                    agent_iteration, step_index, tool_name,
                    detected_json, action_taken, pii_redacted,
                ),
            )
        conn.commit()
    except Exception:
        logger.error("insert_governance_event failed", exc_info=True)


# ── Intercept classes ────────────────────────────────────────────────────────────

class GovernanceIntercept:
    """
    Used inside AgentExecutor.wrap_tool_call().
    Checks individual tool outputs for sensitive content and records to DB.
    """

    def __init__(self, user_id: str, tenant_id: str, plan_run_id: str) -> None:
        self.user_id = user_id
        self.tenant_id = tenant_id
        self.plan_run_id = plan_run_id

    def check_and_record(
        self,
        text: str,
        *,
        tool_name: str,
        agent_iteration: int,
        step_index: int,
        conn: Any,
    ) -> GovernanceCheckResult:
        """
        Scans text. If flagged, inserts a governance_events row and returns
        a result with redacted_text. The conn is caller-managed (opened/closed outside).
        """
        result = check_text(text)

        if result.is_flagged:
            insert_governance_event(
                conn,
                event_type="tool_output_pii",
                intercept_point="agent_tool_call",
                user_id=self.user_id,
                tenant_id=self.tenant_id,
                plan_run_id=self.plan_run_id,
                agent_iteration=agent_iteration,
                step_index=step_index,
                tool_name=tool_name,
                detected=result.detected,
                action_taken="redacted",
                pii_redacted=True,
            )

        return result


class GovernanceIntercept2:
    """
    Used in the Pipeline Path (query_server._stream_generator).
    Filters the combined retrieval + MCP context before passing to the LLM.
    """

    def __init__(self, user_id: str, tenant_id: str, plan_run_id: str) -> None:
        self.user_id = user_id
        self.tenant_id = tenant_id
        self.plan_run_id = plan_run_id

    def filter_context(
        self,
        combined_context: str,
        *,
        conn: Any,
    ) -> tuple[str, GovernanceCheckResult]:
        """
        Scans combined_context. If flagged, records to governance_events and
        returns the redacted version. Otherwise returns the original text.

        Returns: (filtered_text, GovernanceCheckResult)
        """
        result = check_text(combined_context)

        if result.is_flagged:
            insert_governance_event(
                conn,
                event_type="context_pii",
                intercept_point="pipeline_pre_llm",
                user_id=self.user_id,
                tenant_id=self.tenant_id,
                plan_run_id=self.plan_run_id,
                agent_iteration=None,
                step_index=None,
                tool_name=None,
                detected=result.detected,
                action_taken="redacted",
                pii_redacted=True,
            )
            return result.redacted_text, result

        return combined_context, result
