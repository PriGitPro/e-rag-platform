from collections.abc import Iterator

from openai import OpenAI

from .base import BaseLLM, Message


class OpenAIProvider(BaseLLM):
    def __init__(self, model: str, api_key: str) -> None:
        self._client = OpenAI(api_key=api_key)
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
