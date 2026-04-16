"""
AgentExecutor — governed agentic loop for complex_multi_step and cross_system plans.

Loop behaviour:
  1. LLM generates a thought + optional tool call (in <tool_call>...</tool_call> tags)
  2. wrap_tool_call() intercepts every tool execution:
     a. Logs to JSONL audit trail (fire-and-forget, does not block the loop)
     b. Executes the tool coroutine
     c. Runs GovernanceIntercept on the output
     d. Records to governance_events if flagged
  3. SSE events yielded for each stage: thought, tool_call, tool_result, governance, chunk, done
  4. HardCap at HARD_CAP_ITERATIONS (5) — yields done(max_iterations) and returns

SSE wire format (each event is a complete Server-Sent Events data line):
  data: {"type": "thought",      "content": "...", "iteration": 1}\n\n
  data: {"type": "tool_call",    "tool": "jira_search", "args": {...}}\n\n
  data: {"type": "tool_result",  "tool": "jira_search", "result": {...}}\n\n
  data: {"type": "governance",   "flagged": true, "action": "redacted", "tool": "..."}\n\n
  data: {"type": "chunk",        "content": "..."}\n\n
  data: {"type": "done",         "reason": "complete"|"max_iterations", "iterations": N}\n\n

BaseLLM.stream() is synchronous (Iterator[str]). We call it via run_in_executor to
avoid blocking the asyncio event loop. If an async_stream() is added to BaseLLM later,
replace the run_in_executor calls with direct async iteration.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

from config import config
from db import get_conn
from governance import GovernanceIntercept
from llm.base import BaseLLM, Message
from llm_router import LLMRouter

logger = logging.getLogger(__name__)

HARD_CAP_ITERATIONS = 5
_CHUNK_SIZE = 512  # characters per SSE chunk for the final answer


# ── SSE helper ──────────────────────────────────────────────────────────────────

def _sse(event_type: str, payload: dict) -> str:
    """Format a single SSE data line. Always ends with double newline."""
    return f"data: {json.dumps({'type': event_type, **payload})}\n\n"


# ── JSONL audit trail ────────────────────────────────────────────────────────────

def _sync_write_audit(line: dict) -> None:
    try:
        with open(config.audit_jsonl_path, "a") as f:
            f.write(json.dumps(line) + "\n")
    except Exception:
        logger.warning("Sync audit JSONL write failed", exc_info=True)


async def _write_audit_line(line: dict) -> None:
    """
    Fire-and-forget async audit write using the thread pool executor.
    Failures are logged but never propagate — must not block the agent loop.
    """
    if not config.audit_enabled:
        return
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _sync_write_audit, line)
    except Exception:
        logger.warning("Audit JSONL write failed", exc_info=True)


# ── Tool registry ────────────────────────────────────────────────────────────────

@dataclass
class ToolSpec:
    name: str
    description: str
    fn: Callable[..., Awaitable[Any]]  # always async


# ── Tool call parsing ────────────────────────────────────────────────────────────

_TOOL_CALL_RE = re.compile(r"<tool_call>(.*?)</tool_call>", re.DOTALL)


def _parse_tool_call(text: str) -> dict | None:
    """
    Extract the first <tool_call>...</tool_call> JSON block from LLM output.
    Returns parsed dict or None if no tool call is present.
    Expected format: {"tool": "<name>", "args": {...}, "step_index": <int>}
    """
    match = _TOOL_CALL_RE.search(text)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        logger.warning("Failed to parse tool_call JSON: %s", match.group(1))
        return None


# ── System prompt ────────────────────────────────────────────────────────────────

def _build_system_prompt(tools: dict[str, ToolSpec]) -> str:
    tool_lines = "\n".join(
        f"  {name}: {spec.description}" for name, spec in tools.items()
    )
    return f"""You are an enterprise research assistant with access to tools.

Available tools:
{tool_lines}

To call a tool, include exactly one JSON block in your response using this format:
  <tool_call>{{"tool": "<name>", "args": {{...}}, "step_index": <int>}}</tool_call>

Rules:
- Only include ONE tool call per response.
- Use step_index to number your reasoning steps (starting from 0).
- If you have enough information to answer the question directly, respond without a tool call.
- Always cite your sources. Be concise and factual.
- Do not fabricate information — use only what appears in the context or tool results."""


# ── Agent executor ────────────────────────────────────────────────────────────────

class AgentExecutor:
    """
    Governed agentic loop. Instantiate per-request (not a singleton).

    Args:
        plan_run_id: UUID string correlating all governance_events rows for this run.
        user_id:     Authenticated user UUID (passed through to governance).
        tenant_id:   Tenant UUID (used for tool scoping and governance).
        tools:       Available tools for this execution.
    """

    def __init__(
        self,
        plan_run_id: str,
        user_id: str,
        tenant_id: str,
        tools: list[ToolSpec],
    ) -> None:
        self.plan_run_id = plan_run_id
        self.user_id = user_id
        self.tenant_id = tenant_id
        self._tools: dict[str, ToolSpec] = {t.name: t for t in tools}
        self._governance = GovernanceIntercept(
            user_id=user_id,
            tenant_id=tenant_id,
            plan_run_id=plan_run_id,
        )

    async def wrap_tool_call(
        self,
        tool_name: str,
        args: dict,
        tool_fn: Callable[..., Awaitable[Any]],
        *,
        agent_iteration: int,
        step_index: int,
    ) -> tuple[Any, bool, list[str]]:
        """
        Wraps a single tool execution with audit logging and governance interception.

        Steps (in order):
          1. Schedule JSONL audit line (fire-and-forget — does NOT block execution)
          2. Execute the tool coroutine
          3. Governance check on the raw output
          4. If flagged: record to governance_events, return redacted text

        Returns:
          (result, governance_flagged: bool, pattern_types: list[str])
          result is redacted_text (str) if flagged, else the original tool output.
          pattern_types lists the PII categories detected (empty when not flagged).
        """
        audit_entry = {
            "plan_run_id": self.plan_run_id,
            "tenant_id": self.tenant_id,
            "user_id": self.user_id,
            "tool_name": tool_name,
            "args": args,
            "agent_iteration": agent_iteration,
            "step_index": step_index,
        }
        # Schedule the write without awaiting — tool execution proceeds immediately.
        asyncio.ensure_future(_write_audit_line(audit_entry))

        result = await tool_fn(**args)

        result_text = json.dumps(result) if not isinstance(result, str) else result
        conn = get_conn()
        try:
            gov_result = self._governance.check_and_record(
                result_text,
                tool_name=tool_name,
                agent_iteration=agent_iteration,
                step_index=step_index,
                conn=conn,
            )
        finally:
            conn.close()

        if gov_result.is_flagged:
            ptypes = list({d.pattern_type for d in gov_result.detected})
            return gov_result.redacted_text, True, ptypes

        return result, False, []

    async def run(
        self,
        query: str,
        retrieval_context: str,
    ) -> AsyncGenerator[str, None]:
        """
        Main agentic loop. Yields SSE-formatted strings.

        Args:
            query:             Original user query.
            retrieval_context: Pre-retrieved vector search context (from retriever.py).
        """
        messages: list[Message] = [
            Message(role="system", content=_build_system_prompt(self._tools)),
            Message(
                role="user",
                content=(
                    f"# Retrieved Context\n{retrieval_context}\n\n"
                    f"# Question\n{query}"
                ),
            ),
        ]
        governance_flags: list[str] = []
        loop = asyncio.get_event_loop()

        for iteration in range(1, HARD_CAP_ITERATIONS + 1):
            llm: BaseLLM = LLMRouter.route(
                context="\n".join(m.content for m in messages),
                governance_flags=governance_flags,
            )

            # BaseLLM.stream() is a sync Iterator — run in executor to avoid blocking.
            thought_chunks: list[str] = await loop.run_in_executor(
                None, lambda: list(llm.stream(messages))
            )
            thought_text = "".join(thought_chunks)

            for delta in thought_chunks:
                yield _sse("thought", {"content": delta, "iteration": iteration})

            tool_call = _parse_tool_call(thought_text)

            if tool_call is None:
                # No tool call — LLM has a final answer; stream it as chunks.
                for i in range(0, len(thought_text), _CHUNK_SIZE):
                    yield _sse("chunk", {"content": thought_text[i: i + _CHUNK_SIZE]})
                yield _sse("done", {"reason": "complete", "iterations": iteration})
                return

            tool_name = tool_call.get("tool", "")
            tool_args = tool_call.get("args", {})
            step_index = tool_call.get("step_index", 0)

            yield _sse("tool_call", {"tool": tool_name, "args": tool_args})

            if tool_name not in self._tools:
                logger.warning("Agent requested unknown tool %r", tool_name)
                messages.append(Message(
                    role="assistant",
                    content=thought_text,
                ))
                messages.append(Message(
                    role="user",
                    content=(
                        f"Tool {tool_name!r} is not available. "
                        f"Available tools: {list(self._tools.keys())}. "
                        "Please try again using an available tool."
                    ),
                ))
                continue

            tool_fn = self._tools[tool_name].fn
            result, flagged, pattern_types = await self.wrap_tool_call(
                tool_name,
                tool_args,
                tool_fn,
                agent_iteration=iteration,
                step_index=step_index,
            )

            if flagged:
                governance_flags.append(f"tool_output:{tool_name}")
                yield _sse("governance", {
                    "flagged": True,
                    "action": "redacted",
                    "tool": tool_name,
                    "pattern_types": pattern_types,
                    "detected_count": len(pattern_types),
                })

            yield _sse("tool_result", {"tool": tool_name, "result": result})

            messages.append(Message(role="assistant", content=thought_text))
            messages.append(Message(
                role="user",
                content=f"Tool result for {tool_name}:\n{json.dumps(result)}",
            ))

        # Hard cap reached — terminate the loop.
        yield _sse("done", {"reason": "max_iterations", "iterations": HARD_CAP_ITERATIONS})
