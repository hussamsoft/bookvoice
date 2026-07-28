"""Small helpers for durable files on Windows and other local filesystems."""
from __future__ import annotations

import os
import time
from pathlib import Path


ATOMIC_REPLACE_ATTEMPTS = 20
ATOMIC_REPLACE_MAX_DELAY_SEC = 0.1


def replace_file_with_retry(source: Path, destination: Path) -> None:
    """Atomically replace a file, tolerating brief Windows sharing violations."""
    source = Path(source)
    destination = Path(destination)
    for attempt in range(ATOMIC_REPLACE_ATTEMPTS):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == ATOMIC_REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(min(0.01 * (attempt + 1), ATOMIC_REPLACE_MAX_DELAY_SEC))
