import markdown
from bs4 import BeautifulSoup

from .base import BaseExtractor, ExtractedDocument


class MarkdownExtractor(BaseExtractor):
    def extract(self, data: bytes, filename: str) -> ExtractedDocument:
        md_text = data.decode("utf-8", errors="replace")
        html = markdown.markdown(md_text, extensions=["tables", "fenced_code"])
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text(separator="\n", strip=True)
        return ExtractedDocument(
            text=text,
            metadata={"filename": filename},
        )
