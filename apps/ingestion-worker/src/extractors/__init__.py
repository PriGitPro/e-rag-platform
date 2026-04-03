from .base import BaseExtractor, ExtractedDocument
from .docx import DOCXExtractor
from .html import HTMLExtractor
from .markdown import MarkdownExtractor
from .pdf import PDFExtractor

__all__ = ["BaseExtractor", "ExtractedDocument", "get_extractor"]

_MIME_MAP: dict[str, type[BaseExtractor]] = {
    "application/pdf": PDFExtractor,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": DOCXExtractor,
    "text/markdown": MarkdownExtractor,
    "text/html": HTMLExtractor,
    "text/htm": HTMLExtractor,
}

_EXT_MAP: dict[str, type[BaseExtractor]] = {
    "pdf": PDFExtractor,
    "docx": DOCXExtractor,
    "md": MarkdownExtractor,
    "markdown": MarkdownExtractor,
    "html": HTMLExtractor,
    "htm": HTMLExtractor,
}


def get_extractor(mime_type: str, filename: str) -> BaseExtractor:
    if mime_type in _MIME_MAP:
        return _MIME_MAP[mime_type]()
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in _EXT_MAP:
        return _EXT_MAP[ext]()
    raise ValueError(f"No extractor for mime_type={mime_type!r}, filename={filename!r}")
