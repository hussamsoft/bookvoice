"""Per-device ownership of Voice Studio projects.

Each install has a stable 32-hex device id. Projects are scoped to the
device that created them; another device on the same network sees its
own project list and a different project's id looks identical to an
unknown id. ``device_scope`` carries the request's owner into background
jobs via ``ContextVar`` so later manifest writes stay inside the same
device boundary.
"""
from __future__ import annotations

import re
from contextlib import contextmanager
from contextvars import ContextVar, Token


DEVICE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
DEFAULT_DEVICE_ID = "0" * 32

_device_id: ContextVar[str] = ContextVar(
    "bookvoice_studio_device_id",
    default=DEFAULT_DEVICE_ID,
)


def validate_device_id(device_id: str) -> str:
    value = str(device_id or "").strip().lower()
    if not DEVICE_ID_RE.fullmatch(value):
        raise ValueError("Invalid BookVoice device id.")
    return value


def current_device_id() -> str:
    return validate_device_id(_device_id.get())


def activate_device(device_id: str) -> Token:
    return _device_id.set(validate_device_id(device_id))


def deactivate_device(token: Token) -> None:
    _device_id.reset(token)


@contextmanager
def device_scope(device_id: str):
    token = activate_device(device_id)
    try:
        yield current_device_id()
    finally:
        deactivate_device(token)
