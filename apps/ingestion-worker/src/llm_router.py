"""
LLM Router — selects the appropriate LLM instance based on context length
and governance flags.

Priority rules (evaluated in order):
  1. governance_flags non-empty  → llm_router_governance_model (default: gpt-4o)
                                   Ensures sensitive contexts use the most capable model.
  2. estimated context > threshold → llm_router_governance_model
                                   Long context degrades smaller/Ollama models.
  3. Otherwise                   → get_llm() (the configured provider, may be Ollama)

Token estimation: whitespace split × 1.3 (no tiktoken dependency required).
Accurate enough for the routing threshold; not used for billing.
"""

from __future__ import annotations

from config import config
from llm.base import BaseLLM
from llm.factory import get_llm
from llm.openai_provider import OpenAIProvider


class LLMRouter:
    """Stateless — call route() per-request."""

    @staticmethod
    def route(context: str, governance_flags: list[str]) -> BaseLLM:
        """
        Select and return the appropriate BaseLLM instance.

        Args:
            context:          Combined context string that will be sent to the LLM.
            governance_flags: List of flag strings (e.g. ["pii_detected", "tool_output:jira_search"]).
                              Any non-empty list forces the governance model.

        Returns:
            A BaseLLM instance ready to call .generate() or .stream().
        """
        if governance_flags:
            return LLMRouter._make_openai(config.llm_router_governance_model)

        estimated_tokens = int(len(context.split()) * 1.3)
        if estimated_tokens > config.llm_router_token_threshold:
            return LLMRouter._make_openai(config.llm_router_governance_model)

        return get_llm()

    @staticmethod
    def _make_openai(model: str) -> OpenAIProvider:
        return OpenAIProvider(model=model, api_key=config.openai_api_key)
