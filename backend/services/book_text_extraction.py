"""Plain-text extraction for EPUB and plain-text books, stdlib only."""
from __future__ import annotations

import posixpath
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

CONTAINER_PATH = "META-INF/container.xml"
_XHTML_SUFFIXES = (".xhtml", ".html", ".htm", ".xml")
_SENTENCE_BOUNDARY = re.compile(r"[.!?…]+(?:[\"'”’)\]]*)?\s+")
DEFAULT_PAGE_MAX_CHARS = 6000


def extract_epub(path: Path) -> dict:
    """Extract chapter text from an EPUB container in spine order."""
    source = Path(path)
    try:
        bundle = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("The selected EPUB file is not a valid archive.") from exc
    with bundle:
        opf_path = _epub_opf_path(bundle)
        if opf_path is None:
            raise ValueError("The EPUB file is missing its package metadata.")
        opf_root = _parse_xml(bundle.read(opf_path))
        title = _epub_title(opf_root)
        documents = _spine_documents(opf_root, opf_path)
        chapters = [
            {"title": _document_title(bundle, href), "text": _document_text(bundle, href)}
            for href in documents
        ]
    return {"title": title, "chapters": chapters}


def extract_plain_text(path: Path) -> dict:
    """Decode a plain-text book and split it into chapters on form feeds."""
    payload = Path(path).read_bytes()
    chapters = [{"title": None, "text": part.strip()} for part in _decode_text(payload).split("\x0c")]
    if len(chapters) == 1:
        chapters = [{"title": None, "text": chapters[0]["text"]}]
    return {"title": None, "chapters": chapters}


def split_into_pages(chapters: list[dict], max_chars: int = DEFAULT_PAGE_MAX_CHARS) -> list[dict]:
    """Pack chapter text into pages no longer than max_chars at paragraph boundaries."""
    pages: list[dict] = []
    for chapter in chapters or []:
        title = (chapter or {}).get("title")
        text = str((chapter or {}).get("text") or "").strip()
        if len(text) < 2:
            continue
        for chunk in _split_text(text, max_chars):
            pages.append({"text": chunk, "chapterTitle": title})
    if not pages:
        raise ValueError("No readable text was found in the book.")
    return pages


class _EpubTextParser(HTMLParser):
    """Collect block-level text with entities decoded and non-prose tags skipped."""

    BLOCK_TAGS = frozenset(
        {
            "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
            "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
            "header", "li", "main", "nav", "ol", "p", "pre", "section", "table",
            "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
        }
    )
    SKIP_TAGS = frozenset({"style", "script", "head", "title"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._paragraphs: list[str] = []
        self._buffer: list[str] = []
        self._skip_stack: list[str] = []

    @property
    def text(self) -> str:
        return "\n\n".join(self._paragraphs)

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self._skip_stack.append(tag)
        elif not self._skip_stack and tag in self.BLOCK_TAGS:
            self._flush_block()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            if self._skip_stack and self._skip_stack[-1] == tag:
                self._skip_stack.pop()
        elif not self._skip_stack and tag in self.BLOCK_TAGS:
            self._flush_block()

    def handle_data(self, data: str) -> None:
        if not self._skip_stack:
            self._buffer.append(data)

    def close(self) -> None:
        super().close()
        self._flush_block()

    def _flush_block(self) -> None:
        paragraph = " ".join("".join(self._buffer).split())
        self._buffer.clear()
        if paragraph:
            self._paragraphs.append(paragraph)


class _ChapterTitleParser(HTMLParser):
    """Capture the first h1-h6 heading as the chapter title."""

    HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self._depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if self.title is None and tag.lower() in self.HEADING_TAGS:
            self._depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self._depth and tag.lower() in self.HEADING_TAGS:
            self._depth -= 1

    def handle_data(self, data: str) -> None:
        if self._depth and not self.title:
            candidate = " ".join(data.split())
            if candidate:
                self.title = candidate


def _decode_text(payload: bytes) -> str:
    if payload.startswith(b"\xef\xbb\xbf"):
        return payload.decode("utf-8-sig")
    if payload.startswith(b"\xff\xfe") or payload.startswith(b"\xfe\xff"):
        return payload.decode("utf-16")
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        return payload.decode("cp1252")
    except UnicodeDecodeError as exc:
        raise ValueError(
            "The text file uses an encoding this app cannot read."
        ) from exc


def _parse_xml(payload: bytes) -> ElementTree.Element:
    try:
        return ElementTree.fromstring(payload)
    except ElementTree.ParseError as exc:
        raise ValueError("The book's metadata is malformed.") from exc


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _epub_opf_path(bundle: zipfile.ZipFile) -> str | None:
    names = set(bundle.namelist())
    if CONTAINER_PATH not in names:
        return None
    container = _parse_xml(bundle.read(CONTAINER_PATH))
    for element in container.iter():
        if _local_name(element.tag) != "rootfile":
            continue
        full_path = element.get("full-path")
        if full_path and full_path in names:
            return full_path
    return None


def _epub_title(opf_root: ElementTree.Element) -> str | None:
    for element in opf_root.iter():
        if _local_name(element.tag) == "title" and (element.text or "").strip():
            return element.text.strip()
    return None


def _spine_documents(opf_root: ElementTree.Element, opf_path: str) -> list[str]:
    manifest: dict[str, str] = {}
    spine_refs: list[str] = []
    for element in opf_root.iter():
        name = _local_name(element.tag)
        if name == "item":
            item_id = element.get("id")
            href = element.get("href")
            media_type = element.get("media-type") or ""
            if item_id and href:
                is_document = (
                    "html" in media_type
                    or posixpath.splitext(href)[1].lower() in _XHTML_SUFFIXES
                )
                if is_document:
                    manifest[item_id] = _resolve_href(opf_path, href)
        elif name == "itemref":
            idref = element.get("idref")
            if idref:
                spine_refs.append(idref)
    documents = [manifest[idref] for idref in spine_refs if idref in manifest]
    if not documents:
        raise ValueError("The EPUB file does not declare any readable chapters.")
    return documents


def _resolve_href(opf_path: str, href: str) -> str:
    base = posixpath.dirname(opf_path)
    resolved = posixpath.normpath(posixpath.join(base, href)) if base else posixpath.normpath(href)
    return resolved.lstrip("/")


def _read_member(bundle: zipfile.ZipFile, name: str) -> bytes:
    try:
        return bundle.read(name)
    except KeyError as exc:
        raise ValueError(f"The EPUB file is missing the chapter file {name}.") from exc


def _document_title(bundle: zipfile.ZipFile, href: str) -> str | None:
    parser = _ChapterTitleParser()
    parser.feed(_read_member(bundle, href).decode("utf-8", errors="replace"))
    parser.close()
    return parser.title


def _document_text(bundle: zipfile.ZipFile, href: str) -> str:
    parser = _EpubTextParser()
    parser.feed(_read_member(bundle, href).decode("utf-8", errors="replace"))
    parser.close()
    return parser.text


def _split_text(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    current = ""
    for paragraph in text.split("\n\n"):
        if current and len(current) + 2 + len(paragraph) > max_chars:
            chunks.append(current)
            current = paragraph
        elif not current:
            current = paragraph
        else:
            current = f"{current}\n\n{paragraph}"
    if current:
        chunks.append(current)
    result: list[str] = []
    for chunk in chunks:
        result.extend(_split_oversized(chunk, max_chars))
    return result


def _split_oversized(chunk: str, max_chars: int) -> list[str]:
    if len(chunk) <= max_chars:
        return [chunk]
    pieces: list[str] = []
    remaining = chunk
    while len(remaining) > max_chars:
        window = remaining[:max_chars]
        cut = _last_sentence_boundary(window)
        if cut == 0:
            cut = max_chars
        pieces.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        pieces.append(remaining)
    return pieces


def _last_sentence_boundary(window: str) -> int:
    boundary = 0
    for match in _SENTENCE_BOUNDARY.finditer(window):
        end = match.end()
        if end >= len(window) * 0.25:
            boundary = end
    return boundary
