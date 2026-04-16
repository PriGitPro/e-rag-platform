"""
Query planner — rules-based (default) + optional LLM-backed intent classifier.

Intent classes:
  single_intent        — one clear information need, served by vector retrieval.
  cross_system         — answer requires evidence from 2+ sources (e.g. Jira + Confluence).
  complex_multi_step   — multi-hop reasoning chain required.

Plan types:
  RetrievalPlan — fully specified retrieval job. Executor: retriever.py.
  AgentPlan     — governed agentic loop. Executor: agent_executor.py.

Routing:
  plan_query(use_llm_classifier=False)  [default, used by POST /retrieve]
    → all intents → RetrievalPlan  (proto01 backward-compatible behaviour)

  plan_query(use_llm_classifier=True)   [used by POST /retrieve/stream]
    → single_intent             → RetrievalPlan
    → cross_system              → AgentPlan
    → complex_multi_step        → AgentPlan

LLMIntentClassifier falls back to _classify() on any error (network, timeout,
bad JSON, invalid enum value) so the streaming path never hard-fails on
classifier issues.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Union

logger = logging.getLogger(__name__)


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
    Multi-step agent plan executed by AgentExecutor (agent_executor.py).

    required_mcp_servers drives which MCP client connections are established
    in query_server._build_tool_registry().
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
    (triggering an expensive agent loop).
    """
    ql = query.lower()
    words = len(ql.split())

    if any(sig in ql for sig in _CROSS_SYSTEM_SIGNALS):
        return IntentClass.CROSS_SYSTEM

    if words >= _MULTI_STEP_MIN_WORDS and any(sig in ql for sig in _MULTI_STEP_SIGNALS):
        return IntentClass.COMPLEX_MULTI_STEP

    return IntentClass.SINGLE_INTENT


# ── LLM-backed classifier ───────────────────────────────────────────────────────

class LLMIntentClassifier:
    """
    Uses a small, fast LLM (gpt-4o-mini by default) to classify query intent.
    Falls back to _classify() on any exception — including network errors,
    timeouts, malformed JSON, or invalid enum values.

    Instantiated per-call in plan_query(); the OpenAI client itself is cheap
    to construct (thin wrapper over httpx).
    """

    _SYSTEM_PROMPT = (
        "Classify the user query into exactly one of these intent classes:\n"
        "  single_intent       - one clear information need answerable from a single source\n"
        "  cross_system        - requires evidence from 2+ systems (e.g. Jira + Confluence)\n"
        "  complex_multi_step  - requires a chain of reasoning steps or tool calls\n\n"
        'Respond with valid JSON only: {"intent": "<class>"}\n'
        "Do not include any other text or explanation."
    )

    def __init__(self) -> None:
        from openai import OpenAI
        from config import config
        self._client = OpenAI(api_key=config.openai_api_key)
        self._model = config.llm_classifier_model

    def classify(self, query: str) -> IntentClass:
        """Returns classified IntentClass. Falls back to _classify() on any error."""
        try:
            return self._llm_classify(query)
        except Exception:
            logger.warning(
                "LLMIntentClassifier failed for query %r; falling back to rules",
                query[:80],
                exc_info=True,
            )
            return _classify(query)

    def _llm_classify(self, query: str) -> IntentClass:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": self._SYSTEM_PROMPT},
                {"role": "user", "content": query},
            ],
            temperature=0.0,
            max_tokens=32,
            timeout=5.0,
        )
        raw = response.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        return IntentClass(parsed["intent"])


# ── Public API ──────────────────────────────────────────────────────────────────

def plan_query(
    query: str,
    tenant_id: str,
    top_k: int = 5,
    use_llm_classifier: bool = False,
) -> Plan:
    """
    Classify the query and return the appropriate plan.

    Args:
        query:               Natural language query.
        tenant_id:           Tenant UUID — scopes retrieval.
        top_k:               Number of chunks to retrieve (RetrievalPlan only).
        use_llm_classifier:  When True, uses LLMIntentClassifier and routes
                             cross_system / complex_multi_step to AgentPlan.
                             When False (default), all intents fall through to
                             RetrievalPlan (proto01 backward-compatible behaviour).

    Returns:
        RetrievalPlan or AgentPlan.
    """
    if use_llm_classifier:
        intent = LLMIntentClassifier().classify(query)
    else:
        intent = _classify(query)

    if use_llm_classifier and intent in (IntentClass.CROSS_SYSTEM, IntentClass.COMPLEX_MULTI_STEP):
        return AgentPlan(
            intent=intent,
            query=query,
            tenant_id=tenant_id,
            steps=[],
            required_mcp_servers=["jira-mcp", "confluence-mcp"],
        )

    return RetrievalPlan(intent=intent, query=query, tenant_id=tenant_id, top_k=top_k)
