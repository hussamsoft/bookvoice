"""Shared path and ID validation helpers."""
from __future__ import annotations

import os
import re

SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
VOICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
SUPPORTED_LANGUAGES = {"en", "ar"}
MAX_TEXT_CHARS = 12_000
MAX_NARRATION_TEXT_CHARS = 200_000
MAX_PAGE_INDEX = 9_999
MAX_VOICE_BYTES = 15 * 1024 * 1024  # 15 MB
MAX_OCR_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB decoded


def validate_session_id(session_id: str) -> str:
    if not session_id or not SESSION_ID_RE.match(session_id):
        raise ValueError(
            "Invalid session_id. Use 1-64 characters: letters, digits, underscore, hyphen."
        )
    return session_id


def validate_voice_id(voice_id: str) -> str:
    if not voice_id or not VOICE_ID_RE.match(voice_id):
        raise ValueError("Invalid voice_id.")
    return voice_id


def validate_page_index(page_index: int) -> int:
    if not isinstance(page_index, int) or page_index < 0 or page_index > MAX_PAGE_INDEX:
        raise ValueError(f"page_index must be an integer between 0 and {MAX_PAGE_INDEX}.")
    return page_index


def validate_language_id(language_id: str) -> str:
    lang = (language_id or "en").strip().lower()
    if lang not in SUPPORTED_LANGUAGES:
        raise ValueError("Unsupported language. Only 'en' (English) and 'ar' (Arabic) are supported.")
    return lang


def validate_text_length(text: str) -> str:
    if text is None:
        raise ValueError("Text is required.")
    stripped = text.strip()
    if not stripped:
        raise ValueError("Text cannot be empty.")
    if len(stripped) > MAX_TEXT_CHARS:
        raise ValueError(
            f"Text is too long ({len(stripped)} chars). Maximum is {MAX_TEXT_CHARS} characters."
        )
    return stripped


def validate_narration_text_length(text: str) -> str:
    stripped = str(text or "").strip()
    if not stripped:
        raise ValueError("Text cannot be empty.")
    if len(stripped) > MAX_NARRATION_TEXT_CHARS:
        raise ValueError(
            f"Text is too long ({len(stripped)} chars). Maximum is {MAX_NARRATION_TEXT_CHARS} characters."
        )
    return stripped


def safe_join(base_dir: str, *parts: str) -> str:
    """Join paths and ensure the result stays inside base_dir."""
    base = os.path.abspath(base_dir)
    target = os.path.abspath(os.path.join(base, *parts))
    try:
        common = os.path.commonpath([base, target])
    except ValueError as exc:
        raise ValueError("Invalid path.") from exc
    if common != base:
        raise ValueError("Path escapes allowed directory.")
    return target
