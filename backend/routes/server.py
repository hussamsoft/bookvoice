"""Where this server can be reached from other devices.

The launcher (serve_bookvoice.py) records the resolved bind address, LAN
addresses, and Cloudflare tunnel URL in DATA_DIR once the server is ready.
The Settings panel reads this so whoever runs the desktop app can hand the
address to a phone without touching the console. Nothing here is secret: a
caller that can reach this endpoint is already connected to the server.
"""
from __future__ import annotations

import json
import os

from fastapi import APIRouter

router = APIRouter()

ACCESS_FILE = "server-access.json"


def access_file_path() -> str:
    return os.path.join(os.environ.get("DATA_DIR", "data"), ACCESS_FILE)


@router.get("/addresses")
async def server_addresses():
    try:
        with open(access_file_path(), encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"available": False}
    if not isinstance(payload, dict) or not payload.get("available"):
        return {"available": False}
    return payload
