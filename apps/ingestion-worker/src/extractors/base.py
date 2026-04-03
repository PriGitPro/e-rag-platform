from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ExtractedDocument:
    text: str
    metadata: dict = field(default_factory=dict)


class BaseExtractor(ABC):
    @abstractmethod
    def extract(self, data: bytes, filename: str) -> ExtractedDocument: ...
