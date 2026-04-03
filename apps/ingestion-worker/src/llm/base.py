"""
LLM provider interface.

All providers expose two methods:
  generate(messages)  — blocking, returns the full response string
  stream(messages)    — returns an Iterator that yields text deltas

Message is intentionally a plain dataclass, not tied to any SDK type,
so callers don't need to import openai or ollama directly.
"""

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass


@dataclass
class Message:
    role: str    # "system" | "user" | "assistant"
    content: str


class BaseLLM(ABC):
    @abstractmethod
    def generate(self, messages: list[Message], **kwargs) -> str: ...

    @abstractmethod
    def stream(self, messages: list[Message], **kwargs) -> Iterator[str]: ...
