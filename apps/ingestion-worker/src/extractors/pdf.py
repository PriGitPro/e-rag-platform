import io

from pypdf import PdfReader

from .base import BaseExtractor, ExtractedDocument


class PDFExtractor(BaseExtractor):
    def extract(self, data: bytes, filename: str) -> ExtractedDocument:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n\n".join(p for p in pages if p.strip())
        return ExtractedDocument(
            text=text,
            metadata={"page_count": len(reader.pages), "filename": filename},
        )
