"""
Rules-based query planner.

RFC Q1 open question: whether to replace _classify() with an LLM classifier.
Don't build the LLM classifier until we have labelled eval data from production
traffic — guessing intent distributions without data produces the wrong priors.

Intent classes:
  single_intent        — one clear information need, served by vector retrieval.
                         Default for everything today since MCP servers don't exist.
  cross_system         — answer requires evidence from 2+ sources (e.g. Jira + Confluence).
                         Routes to AgentPlan once MCP servers exist (M2).
  complex_multi_step   — multi-hop reasoning chain required.
                         Routes to AgentPlan once MCP servers exist (M2).

Plan types:
  RetrievalPlan — fully specified retrieval job. Executor exists: retriever.py.
  AgentPlan     — defined for RFC completeness. Executor does NOT exist yet.
                  Planner can produce it; nothing will fire it until M2.

Routing today (proto01):
  ALL intents → RetrievalPlan (fallback until MCP servers exist)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Union


class IntentClass(str, Enum):
    SINGLE_INTENT = "single_intent"
    CROSS_SYSTEM = "cross_system"
    COMPLEX_MULTI_STEP = "complex_multi_step"


@dataclass
class RetrievalPlan:
    intent: IntentClass
    query: str
    tenant_id: str
    top_k: int
    # Future extension points — don't implement until RAGAS reveals a need:
    # source_filter: list[str] = field(default_factory=list)   # restrict to specific doc sources
    # date_from: str | None = None                              # temporal filter
    # metadata_filters: dict = field(default_factory=dict)     # arbitrary metadata predicates


@dataclass
class AgentPlan:
    """
    Multi-step agent plan.

    Not executed in proto01 — MCP server tooling does not exist yet.
    Defined here so the planner output type is complete and callers can
    branch on isinstance(plan, AgentPlan) without a future import change.

    When M2 lands:
      - Wire AgentPlan to the agent orchestrator
      - required_mcp_servers drives which MCP connections are established
      - steps are translated to tool_calls by the orchestrator
    """
    intent: IntentClass
    query: str
    tenant_id: str
    steps: list[str] = field(default_factory=list)
    required_mcp_servers: list[str] = field(default_factory=list)


Plan = Union[RetrievalPlan, AgentPlan]

# ── Rules ──────────────────────────────────────────────────────────────────────
# Keep this list short and obvious. Do not add clever heuristics — they create
# silent misclassification that's hard to debug without an eval harness.

_CROSS_SYSTEM_SIGNALS = frozenset([
    "compare", " vs ", " versus ", "difference between", "both",
    "across", "all systems", "from jira", "from confluence", "from slack",
])

_MULTI_STEP_SIGNALS = frozenset([
    "step by step", "first.*then", "how do i", "walk me through",
    "explain how", "what are the steps",
])

_MULTI_STEP_MIN_WORDS = 12   # short queries rarely need multi-hop


def _classify(query: str) -> IntentClass:
    """
    Lightweight rules-based classifier.

    Precision over recall: it is safer to under-classify into single_intent
    (triggering retrieval) than to over-classify into complex_multi_step
    (triggering a non-existent executor).  Tune thresholds only after RAGAS
    shows misrouting hurts quality metrics.
    """
    ql = query.lower()
    words = len(ql.split())

    if any(sig in ql for sig in _CROSS_SYSTEM_SIGNALS):
        return IntentClass.CROSS_SYSTEM

    if words >= _MULTI_STEP_MIN_WORDS and any(sig in ql for sig in _MULTI_STEP_SIGNALS):
        return IntentClass.COMPLEX_MULTI_STEP

    return IntentClass.SINGLE_INTENT


def plan_query(query: str, tenant_id: str, top_k: int = 5) -> Plan:
    """
    Classify the query and return the appropriate plan.

    Proto01 behaviour: all intents fall through to RetrievalPlan because
    the AgentPlan executor (MCP orchestrator) does not exist yet.
    The intent is still classified and returned in the plan so callers
    can see what would have routed differently once M2 ships.
    """
    intent = _classify(query)

    # TODO M2: route CROSS_SYSTEM and COMPLEX_MULTI_STEP to AgentPlan
    # when MCP servers are available. Remove this comment and the fallback
    # once the agent executor is wired.
    return RetrievalPlan(intent=intent, query=query, tenant_id=tenant_id, top_k=top_k)
