"""
MCP Tool Clients — async httpx wrappers for Jira and Confluence MCP servers.

Design:
  - Each client is a thin async httpx wrapper.
  - Base URLs come from config so swapping a URL points at a real MCP server.
  - All methods return plain dicts / lists — no MCP SDK types leaked to callers.
  - gather_pipeline_context() calls both tools in parallel via asyncio.gather.

Mock behaviour:
  - If the MCP server is unreachable, methods return [] / {} and log a warning.
  - For local dev without real MCP servers, set JIRA_MCP_BASE_URL / CONFLUENCE_MCP_BASE_URL
    to a mock server or leave at defaults (requests will fail gracefully).
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from config import config

logger = logging.getLogger(__name__)

MCP_TIMEOUT = 10.0  # seconds per request


# ── Jira MCP Client ─────────────────────────────────────────────────────────────

class JiraMCPClient:
    """Async client for the Jira MCP server."""

    def __init__(self, base_url: str | None = None) -> None:
        self._base_url = (base_url or config.jira_mcp_base_url).rstrip("/")

    async def search_issues(
        self,
        query: str,
        tenant_id: str,
        max_results: int = 10,
    ) -> list[dict]:
        """
        POST {base_url}/tools/search_issues
        Returns list of issue dicts: [{"key": "...", "summary": "...", "description": "..."}]
        Returns [] on any error.
        """
        try:
            async with httpx.AsyncClient(timeout=MCP_TIMEOUT) as client:
                resp = await client.post(
                    f"{self._base_url}/tools/search_issues",
                    json={"query": query, "tenant_id": tenant_id, "max_results": max_results},
                )
                resp.raise_for_status()
                data = resp.json()
                return data if isinstance(data, list) else data.get("issues", [])
        except httpx.HTTPError as exc:
            logger.warning("JiraMCPClient.search_issues failed: %s", exc)
            return []
        except Exception:
            logger.warning("JiraMCPClient.search_issues unexpected error", exc_info=True)
            return []

    async def get_issue(self, issue_key: str, tenant_id: str) -> dict:
        """
        POST {base_url}/tools/get_issue
        Returns issue dict or {} on error.
        """
        try:
            async with httpx.AsyncClient(timeout=MCP_TIMEOUT) as client:
                resp = await client.post(
                    f"{self._base_url}/tools/get_issue",
                    json={"issue_key": issue_key, "tenant_id": tenant_id},
                )
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPError as exc:
            logger.warning("JiraMCPClient.get_issue failed: %s", exc)
            return {}
        except Exception:
            logger.warning("JiraMCPClient.get_issue unexpected error", exc_info=True)
            return {}


# ── Confluence MCP Client ────────────────────────────────────────────────────────

class ConfluenceMCPClient:
    """Async client for the Confluence MCP server."""

    def __init__(self, base_url: str | None = None) -> None:
        self._base_url = (base_url or config.confluence_mcp_base_url).rstrip("/")

    async def search_pages(
        self,
        query: str,
        tenant_id: str,
        max_results: int = 10,
    ) -> list[dict]:
        """
        POST {base_url}/tools/search_pages
        Returns list of page dicts: [{"id": "...", "title": "...", "body": "..."}]
        Returns [] on any error.
        """
        try:
            async with httpx.AsyncClient(timeout=MCP_TIMEOUT) as client:
                resp = await client.post(
                    f"{self._base_url}/tools/search_pages",
                    json={"query": query, "tenant_id": tenant_id, "max_results": max_results},
                )
                resp.raise_for_status()
                data = resp.json()
                return data if isinstance(data, list) else data.get("pages", [])
        except httpx.HTTPError as exc:
            logger.warning("ConfluenceMCPClient.search_pages failed: %s", exc)
            return []
        except Exception:
            logger.warning("ConfluenceMCPClient.search_pages unexpected error", exc_info=True)
            return []

    async def get_page(self, page_id: str, tenant_id: str) -> dict:
        """
        POST {base_url}/tools/get_page
        Returns page dict or {} on error.
        """
        try:
            async with httpx.AsyncClient(timeout=MCP_TIMEOUT) as client:
                resp = await client.post(
                    f"{self._base_url}/tools/get_page",
                    json={"page_id": page_id, "tenant_id": tenant_id},
                )
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPError as exc:
            logger.warning("ConfluenceMCPClient.get_page failed: %s", exc)
            return {}
        except Exception:
            logger.warning("ConfluenceMCPClient.get_page unexpected error", exc_info=True)
            return {}


# ── Parallel pipeline context fetch ─────────────────────────────────────────────

async def gather_pipeline_context(
    query: str,
    tenant_id: str,
    jira_client: JiraMCPClient | None = None,
    confluence_client: ConfluenceMCPClient | None = None,
) -> dict[str, list[dict]]:
    """
    Fetch Jira issues and Confluence pages in parallel.
    Returns {"jira": [...], "confluence": [...]}.
    One tool failing does not abort the other — partial results are preserved.
    """
    jira = jira_client or JiraMCPClient()
    conf = confluence_client or ConfluenceMCPClient()

    jira_result, conf_result = await asyncio.gather(
        jira.search_issues(query, tenant_id),
        conf.search_pages(query, tenant_id),
        return_exceptions=True,
    )

    return {
        "jira": jira_result if isinstance(jira_result, list) else [],
        "confluence": conf_result if isinstance(conf_result, list) else [],
    }
