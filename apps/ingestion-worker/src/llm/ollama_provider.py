"""
Ollama provider — uses Ollama's OpenAI-compatible /v1 endpoint so the code
path is identical to OpenAIProvider.  No extra dependencies required.

Run locally:
  docker compose --profile ollama up          # starts erp-ollama
  docker exec erp-ollama ollama pull llama3.2 # one-time model download (~2 GB)

Then set in .env.local:
  LLM_PROVIDER=ollama
  LLM_MODEL=llama3.2

Switch back to OpenAI by setting LLM_PROVIDER=openai — nothing else changes.

Models to try:
  llama3.2          3B  — fast, good for dev iteration
  llama3.1:8b       8B  — better quality, needs ~6 GB RAM
  mistral           7B  — strong instruction following
  phi3:mini        3.8B — very fast on CPU
"""

from collections.abc import Iterator

from openai import OpenAI

from .base import BaseLLM, Message


class OllamaProvider(BaseLLM):
    def __init__(self, model: str, base_url: str) -> None:
        self._client = OpenAI(
            base_url=f"{base_url.rstrip('/')}/v1",
            api_key="ollama",  # required by the SDK; Ollama ignores it
        )
        self.model = model

    def _msgs(self, messages: list[Message]) -> list[dict]:
        return [{"role": m.role, "content": m.content} for m in messages]

    def generate(self, messages: list[Message], **kwargs) -> str:
        response = self._client.chat.completions.create(
            model=self.model,
            messages=self._msgs(messages),
            **kwargs,
        )
        return response.choices[0].message.content or ""

    def stream(self, messages: list[Message], **kwargs) -> Iterator[str]:
        with self._client.chat.completions.stream(
            model=self.model,
            messages=self._msgs(messages),
            **kwargs,
        ) as s:
            for chunk in s:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
