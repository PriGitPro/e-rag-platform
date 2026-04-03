from bs4 import BeautifulSoup

from .base import BaseExtractor, ExtractedDocument

_NOISE_TAGS = ["script", "style", "nav", "footer", "header", "aside", "noscript"]


class HTMLExtractor(BaseExtractor):
    def extract(self, data: bytes, filename: str) -> ExtractedDocument:
        soup = BeautifulSoup(data, "lxml")
        for tag in soup(_NOISE_TAGS):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        title_tag = soup.find("title")
        return ExtractedDocument(
            text=text,
            metadata={
                "title": title_tag.string if title_tag else "",
                "filename": filename,
            },
        )
