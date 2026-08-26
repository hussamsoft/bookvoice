from __future__ import annotations

import asyncio
import hashlib
import io
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from fastapi import HTTPException  # noqa: E402

from services import book_library_service as library  # noqa: E402
from services import book_text_extraction as extraction  # noqa: E402
from routes import books as book_routes  # noqa: E402


def build_epub(path: Path, *, long_chapter_chars: int = 0) -> None:
    chapter_one = (
        "<html><head><title>Ignore</title></head><body>"
        "<h1>The Beginning</h1>"
        "<p>It was a dark &amp; stormy night.</p>"
        "<style>body { color: red; }</style>"
        "<p>Second&#160;paragraph with   collapsed    spaces.</p>"
        "</body></html>"
    )
    if long_chapter_chars:
        paragraphs = []
        used = 0
        index = 0
        while used < long_chapter_chars:
            paragraph = f"Chapter two sentence {index} about wandering rivers and quiet towns."
            paragraphs.append(f"<p>{paragraph}</p>")
            used += len(paragraph) + 2
            index += 1
        chapter_two = "<html><body><h1>Chapter Two</h1>" + "".join(paragraphs) + "</body></html>"
    else:
        chapter_two = "<html><body><h1>Chapter Two</h1><p>Short chapter body.</p></body></html>"
    chapter_three = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>"
        "<h1>Finale</h1><p>The end of <em>the story</em>.</p>"
        "</body></html>"
    )
    opf = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\">"
        "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">"
        "<dc:title>Fixture Book</dc:title>"
        "</metadata>"
        "<manifest>"
        "<item id=\"c1\" href=\"text/c1.xhtml\" media-type=\"application/xhtml+xml\"/>"
        "<item id=\"c2\" href=\"text/c2.xhtml\" media-type=\"application/xhtml+xml\"/>"
        "<item id=\"c3\" href=\"text/c3.xhtml\" media-type=\"application/xhtml+xml\"/>"
        "<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>"
        "</manifest>"
        "<spine><itemref idref=\"c1\"/><itemref idref=\"c2\"/><itemref idref=\"c3\"/></spine>"
        "</package>"
    )
    container = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<container version=\"1.0\" "
        "xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">"
        "<rootfiles><rootfile full-path=\"OEBPS/content.opf\" "
        "media-type=\"application/oebps-package+xml\"/></rootfiles>"
        "</container>"
    )
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.writestr("mimetype", "application/epub+zip")
        bundle.writestr("META-INF/container.xml", container)
        bundle.writestr("OEBPS/content.opf", opf)
        bundle.writestr("OEBPS/text/c1.xhtml", chapter_one)
        bundle.writestr("OEBPS/text/c2.xhtml", chapter_two)
        bundle.writestr("OEBPS/text/c3.xhtml", chapter_three)
        bundle.writestr("OEBPS/style.css", "body { margin: 0; }")


def make_upload(chunks, filename):
    class FakeUpload:
        def __init__(self):
            self.chunks = list(chunks)
            self.filename = filename

        async def read(self, size=-1):
            return self.chunks.pop(0) if self.chunks else b""

    return FakeUpload()


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_extract_epub_returns_spine_order_metadata_and_clean_text(self):
        path = self.dir / "book.epub"
        build_epub(path)
        result = extraction.extract_epub(path)
        self.assertEqual(result["title"], "Fixture Book")
        titles = [chapter["title"] for chapter in result["chapters"]]
        self.assertEqual(titles, ["The Beginning", "Chapter Two", "Finale"])
        first_text = result["chapters"][0]["text"]
        self.assertIn("It was a dark & stormy night.", first_text)
        self.assertNotIn("<", first_text)
        self.assertNotIn("color: red", first_text)
        self.assertNotIn("Ignore", first_text)

    def test_extract_epub_splits_block_elements_into_paragraph_breaks(self):
        path = self.dir / "book.epub"
        build_epub(path)
        text = extraction.extract_epub(path)["chapters"][2]["text"]
        self.assertEqual(text.split("\n\n"), ["Finale", "The end of the story."])

    def test_extract_epub_rejects_corrupt_archive(self):
        path = self.dir / "bad.epub"
        path.write_bytes(b"not a zip")
        with self.assertRaisesRegex(ValueError, "valid archive"):
            extraction.extract_epub(path)

    def test_extract_epub_rejects_missing_container(self):
        path = self.dir / "empty.epub"
        with zipfile.ZipFile(path, "w") as bundle:
            bundle.writestr("something.txt", "hi")
        with self.assertRaisesRegex(ValueError, "package metadata"):
            extraction.extract_epub(path)

    def test_extract_epub_rejects_empty_spine(self):
        path = self.dir / "nospine.epub"
        container = (
            "<container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">"
            "<rootfiles><rootfile full-path=\"content.opf\" "
            "media-type=\"application/oebps-package+xml\"/></rootfiles></container>"
        )
        opf = (
            "<package xmlns=\"http://www.idpf.org/2007/opf\">"
            "<metadata/><manifest/><spine/></package>"
        )
        with zipfile.ZipFile(path, "w") as bundle:
            bundle.writestr("META-INF/container.xml", container)
            bundle.writestr("content.opf", opf)
        with self.assertRaisesRegex(ValueError, "readable chapters"):
            extraction.extract_epub(path)

    def test_extract_plain_text_utf8(self):
        path = self.dir / "book.txt"
        path.write_bytes("caf\u00e9 na\u00efve".encode("utf-8"))
        result = extraction.extract_plain_text(path)
        self.assertIsNone(result["title"])
        self.assertEqual(result["chapters"], [{"title": None, "text": "caf\u00e9 na\u00efve"}])

    def test_extract_plain_text_handles_bom_and_crlf(self):
        path = self.dir / "book.txt"
        payload = b"\xef\xbb\xbfLine one\r\n\r\nLine two"
        path.write_bytes(payload)
        result = extraction.extract_plain_text(path)
        self.assertEqual(result["chapters"][0]["text"], "Line one\r\n\r\nLine two")

    def test_extract_plain_text_splits_on_form_feeds(self):
        path = self.dir / "book.txt"
        path.write_bytes(b"Alpha\x0cBeta\x0cGamma")
        chapters = extraction.extract_plain_text(path)["chapters"]
        self.assertEqual([chapter["text"] for chapter in chapters], ["Alpha", "Beta", "Gamma"])

    def test_extract_plain_text_falls_back_to_cp1252(self):
        path = self.dir / "book.txt"
        path.write_bytes(b"caf\xe9 r\xe9sum\xe9")
        result = extraction.extract_plain_text(path)
        self.assertEqual(result["chapters"][0]["text"], "caf\u00e9 r\u00e9sum\u00e9")

    def test_extract_plain_text_decodes_utf16_bom(self):
        path = self.dir / "book.txt"
        path.write_bytes("\u201cQuoted\u201d text".encode("utf-16"))
        result = extraction.extract_plain_text(path)
        self.assertEqual(result["chapters"][0]["text"], "\u201cQuoted\u201d text")

    def test_split_into_pages_keeps_short_chapters_whole(self):
        chapters = [
            {"title": "One", "text": "First chapter."},
            {"title": None, "text": "x"},  # near-empty chapters are dropped
        ]
        pages = extraction.split_into_pages(chapters)
        self.assertEqual(
            pages,
            [{"text": "First chapter.", "chapterTitle": "One"}],
        )

    def test_split_into_pages_splits_long_chapters_at_paragraph_boundaries(self):
        paragraphs = [f"Paragraph {index} " + " ".join(["word"] * 20) for index in range(200)]
        text = "\n\n".join(paragraphs)
        pages = extraction.split_into_pages([{"title": "Long", "text": text}], max_chars=6000)
        self.assertGreater(len(pages), 1)
        for page in pages:
            self.assertLessEqual(len(page["text"]), 6000)
            self.assertEqual(page["chapterTitle"], "Long")
        rejoined = "\n\n".join(page["text"] for page in pages)
        self.assertEqual(rejoined, text)

    def test_split_into_pages_hard_splits_unbreakable_paragraph_at_sentences(self):
        sentence = "A short sentence ends here. "
        paragraph = sentence * 400
        pages = extraction.split_into_pages([{"title": None, "text": paragraph}], max_chars=1000)
        self.assertGreater(len(pages), 1)
        for page in pages:
            self.assertLessEqual(len(page["text"]), 1000)
            stripped = page["text"].strip()
            self.assertTrue(stripped.endswith(".") or stripped.endswith("here."))

    def test_split_into_pages_raises_when_everything_is_empty(self):
        with self.assertRaisesRegex(ValueError, "No readable text"):
            extraction.split_into_pages([{"title": None, "text": ""}, {"title": None}])


class ImportServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        library._jobs.clear()
        library._archives.clear()

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def test_import_epub_path_populates_pages_manifest_and_summary(self):
        source = Path(self.temp.name) / "Fixture Book.epub"
        build_epub(source)
        summary = library.import_epub_path(source, "Fixture Book.epub")

        self.assertEqual(summary["sourceKind"], "epub")
        self.assertEqual(summary["title"], "Fixture Book")
        self.assertEqual(summary["chapterCount"], 3)
        self.assertEqual(summary["pageCount"], summary["chapterCount"])

        book_id = summary["id"]
        page_one = library.get_page(book_id, 1)
        self.assertIn("dark & stormy night", page_one["text"])
        self.assertEqual(page_one["chapterTitle"], "The Beginning")
        manifest = library.get_book(book_id)
        self.assertEqual(manifest["chapterCount"], 3)
        self.assertTrue((library.book_dir(book_id) / "source.epub").is_file())

    def test_import_epub_path_is_idempotent(self):
        source = Path(self.temp.name) / "fixture.epub"
        build_epub(source)
        first = library.import_epub_path(source, "fixture.epub")
        second = library.import_epub_path(source, "fixture.epub")
        self.assertEqual(first, second)
        manifest = library.get_book(first["id"])
        self.assertEqual(manifest["pageCount"], 3)

    def test_import_text_path_stores_txt_source_and_pages(self):
        source = Path(self.temp.name) / "notes.txt"
        source.write_bytes(b"Part one\x0cPart two")
        summary = library.import_text_path(source, "notes.txt")

        self.assertEqual(summary["sourceKind"], "txt")
        self.assertEqual(summary["title"], "notes")
        self.assertEqual(summary["chapterCount"], 2)
        self.assertTrue((library.book_dir(summary["id"]) / "source.txt").is_file())
        self.assertEqual(library.get_page(summary["id"], 2)["text"], "Part two")

    def test_save_page_without_chapter_title_omits_the_key(self):
        book = library.import_pdf(b"%PDF fixture", "Plain.pdf")
        payload = library.save_page(book["id"], 1, "Just text", 1)
        self.assertNotIn("chapterTitle", payload)


class ImportRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def _run_import(self, upload):
        try:
            return asyncio.run(book_routes.import_book(upload))
        except HTTPException as exc:
            return exc

    def test_route_dispatches_by_extension(self):
        cases = [
            ("a.pdf", library.import_pdf_path),
            ("b.EPUB", library.import_epub_path),
            ("c.txt", library.import_text_path),
            ("d.md", library.import_text_path),
            ("e.bookvoice", library.import_bookvoice_path),
        ]
        for filename, importer in cases:
            with self.subTest(filename=filename):
                with patch.object(book_routes.library, importer.__name__, return_value={"ok": True}) as mocked:
                    response = self._run_import(make_upload([b"data", b""], filename))
                self.assertEqual(response, {"ok": True})
                mocked.assert_called_once()

    def test_route_rejects_unsupported_extension(self):
        with patch.object(book_routes.library, "import_pdf_path") as pdf:
            exc = self._run_import(make_upload([b"MZ", b""], "evil.exe"))
        self.assertIsInstance(exc, HTTPException)
        self.assertEqual(exc.status_code, 400)
        self.assertEqual(exc.detail["code"], "INVALID_BOOK_FILE")
        for extension in (".pdf", ".epub", ".txt", ".md", ".bookvoice"):
            self.assertIn(extension, exc.detail["message"])
        pdf.assert_not_called()

    def test_get_stored_page_returns_payload(self):
        staged = Path(self.temp.name) / "book.epub"
        build_epub(staged)
        summary = library.import_epub_path(staged, "book.epub")

        payload = asyncio.run(book_routes.get_stored_page(summary["id"], 1))
        self.assertIn("text", payload)
        self.assertEqual(payload["chapterTitle"], "The Beginning")

    def test_get_stored_page_missing_book_is_404(self):
        exc = asyncio.run(self._guard(lambda: book_routes.get_stored_page("f" * 64, 1)))
        self.assertEqual(exc.status_code, 404)
        self.assertEqual(exc.detail["code"], "BOOK_NOT_FOUND")

    def test_get_stored_page_missing_page_file_is_404(self):
        staged = Path(self.temp.name) / "book.epub"
        build_epub(staged)
        summary = library.import_epub_path(staged, "book.epub")
        exc = asyncio.run(self._guard(lambda: book_routes.get_stored_page(summary["id"], 999)))
        self.assertEqual(exc.status_code, 404)
        self.assertEqual(exc.detail["code"], "PAGE_NOT_FOUND")

    def test_import_empty_txt_returns_400_and_leaves_no_manifest(self):
        source = Path(self.temp.name) / "empty.txt"
        source.write_bytes(b"   \n\t")
        exc = self._run_import(make_upload([b"   \n\t", b""], "empty.txt"))
        self.assertIsInstance(exc, HTTPException)
        self.assertEqual(exc.status_code, 400)
        self.assertEqual(exc.detail["code"], "INVALID_BOOK_FILE")
        book_id = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertFalse((library.book_dir(book_id) / "manifest.json").exists())

    def test_empty_txt_retry_stays_400_and_valid_import_lists_with_pages(self):
        source = Path(self.temp.name) / "empty.txt"
        source.write_bytes(b"   \n\t")
        first = self._run_import(make_upload([b"   \n\t", b""], "empty.txt"))
        second = self._run_import(make_upload([b"   \n\t", b""], "empty.txt"))
        for exc in (first, second):
            self.assertIsInstance(exc, HTTPException)
            self.assertEqual(exc.status_code, 400)
            self.assertEqual(exc.detail["code"], "INVALID_BOOK_FILE")

        valid = Path(self.temp.name) / "real.txt"
        valid.write_bytes(b"Chapter one\x0cChapter two")
        summary = self._run_import(make_upload([valid.read_bytes(), b""], "real.txt"))
        books = asyncio.run(book_routes.list_books())["books"]
        listed = next(book for book in books if book["id"] == summary["id"])
        self.assertGreaterEqual(listed["pageCount"], 1)

    def test_manifest_replace_retries_transient_permission_error(self):
        manifest_path = library._manifest_path(self._imported_book_id())
        payload = library.get_book(self._imported_book_id())
        real_replace = os.replace
        calls = {"n": 0}

        def flaky_replace(src, dst):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise PermissionError(5, "Access is denied")
            real_replace(src, dst)

        with patch.object(library.os, "replace", flaky_replace), patch.object(
            library.time, "sleep", lambda _s: None
        ):
            library._write_json(manifest_path, payload)
        self.assertEqual(calls["n"], 3)
        self.assertEqual(library.get_book(self._imported_book_id()), payload)

    def test_manifest_replace_raises_after_retry_budget(self):
        manifest_path = library._manifest_path(self._imported_book_id())
        with patch.object(library.os, "replace", side_effect=PermissionError(5, "denied")), \
                patch.object(library.time, "sleep", lambda _s: None):
            with self.assertRaises(PermissionError):
                library._write_json(manifest_path, library.get_book(self._imported_book_id()))

    def _imported_book_id(self):
        source = Path(self.temp.name) / "retry.txt"
        source.write_bytes(b"Chapter one\x0cChapter two")
        return self._run_import(make_upload([source.read_bytes(), b""], "retry.txt"))["id"]

    @staticmethod
    async def _guard(call):
        try:
            await call()
        except HTTPException as exc:
            return exc
        raise AssertionError("Expected HTTPException")


if __name__ == "__main__":
    unittest.main()
