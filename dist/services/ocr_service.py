import base64
import os
import warnings
from io import BytesIO

import numpy as np
from PIL import Image

from services.config_service import config_value
from services.path_utils import MAX_OCR_IMAGE_BYTES

_reader = None
_reader_langs = None
MAX_OCR_PIXELS = 25_000_000


def get_reader(languages=None):
    """Lazy-load EasyOCR. Default languages: English + Arabic."""
    global _reader, _reader_langs
    langs = languages or ["en", "ar"]
    langs = list(dict.fromkeys(langs))  # preserve order, unique

    if _reader is not None and _reader_langs == langs:
        return _reader

    import easyocr
    import torch

    env_gpu = os.getenv("OCR_USE_GPU", "").strip().lower()
    if env_gpu in ("true", "false"):
        want_gpu = env_gpu == "true"
    else:
        want_gpu = bool(config_value("ocr_use_gpu", False))
    use_gpu = want_gpu and torch.cuda.is_available()
    print(f"Loading EasyOCR model (gpu={use_gpu}, langs={langs})...")
    _reader = easyocr.Reader(langs, gpu=use_gpu)
    _reader_langs = langs
    print("EasyOCR model ready.")
    return _reader


def _decode_image(image_data: str) -> np.ndarray:
    try:
        _, encoded = image_data.split(",", 1)
    except ValueError:
        encoded = image_data

    try:
        image_bytes = base64.b64decode(encoded, validate=False)
    except Exception as e:
        raise ValueError(f"Invalid base64 image data: {e}") from e

    if len(image_bytes) > MAX_OCR_IMAGE_BYTES:
        raise ValueError(
            f"Image too large ({len(image_bytes)} bytes). "
            f"Maximum is {MAX_OCR_IMAGE_BYTES} bytes."
        )

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(BytesIO(image_bytes))
            w, h = image.size
            if w < 1 or h < 1 or w * h > MAX_OCR_PIXELS:
                raise ValueError(f"Image resolution is too large ({w}x{h}).")
            image.load()
        image = image.convert("RGB")
        # Cap extreme resolutions to protect memory.
        max_side = 4000
        w, h = image.size
        if max(w, h) > max_side:
            scale = max_side / float(max(w, h))
            image = image.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
        return np.array(image)
    except Exception as e:
        raise ValueError(f"Invalid image format: {e}") from e


def _assemble_text(results: list) -> str:
    """Reconstruct reading order from EasyOCR bounding boxes."""
    items = []
    for bbox, text, confidence in results:
        if confidence < 0.25 or not text.strip():
            continue
        y_center = sum(point[1] for point in bbox) / len(bbox)
        x_left = min(point[0] for point in bbox)
        height = max(point[1] for point in bbox) - min(point[1] for point in bbox)
        items.append((y_center, x_left, height, text.strip()))

    if not items:
        return ""

    avg_height = sum(item[2] for item in items) / len(items)
    line_threshold = max(avg_height * 0.6, 12)

    items.sort(key=lambda item: item[0])

    lines: list[list] = []
    current_line = [items[0]]
    current_y = items[0][0]

    for item in items[1:]:
        if abs(item[0] - current_y) <= line_threshold:
            current_line.append(item)
        else:
            lines.append(current_line)
            current_line = [item]
            current_y = item[0]
    lines.append(current_line)

    return "\n".join(
        " ".join(word for _, _, _, word in sorted(line, key=lambda item: item[1]))
        for line in lines
    )


def extract_text_from_image(image_data: str) -> str:
    image_array = _decode_image(image_data)
    reader = get_reader(["en", "ar"])
    results = reader.readtext(image_array, paragraph=False)
    return _assemble_text(results)
