# BookVoice server image — CPU profile.
#
#   docker build -f deploy/linux/Dockerfile -t bookvoice:cpu .   # from the repo root
#   docker run -p 8000:8000 -v bookvoice-data:/app/data bookvoice:cpu
#   (or: docker compose up -d --build — see docker-compose.yml)
#
# Caveats:
#   - CPU only. A GPU variant is out of scope here: it needs an NVIDIA CUDA
#     base image, the cu121 torch wheels (see backend/requirements.txt) and the
#     NVIDIA container toolkit. Generation on CPU is functional but very slow
#     (minutes per short passage) — treat it as smoke testing.
#   - The image contains NO model weights. English TTS weights are never
#     downloaded (no download path exists off Windows releases) — mount them at
#     /app/data/models/en (copy data/models/en/ from a Windows install).
#     The multilingual model (~3 GB) and EasyOCR models download into
#     /app/data/{hf,easyocr} on first use, so keep /app/data on a volume.
#   - runtime-manifest.json must NOT be baked in: its presence makes
#     backend/services/media_tools.py insist on packaged Windows executables.
#     The COPY list below therefore excludes it along with dev/runtime data.
FROM python:3.11-slim

# ffmpeg/ffprobe: media_tools falls back to PATH off Windows. libgl1 +
# libglib2.0-0: OpenCV runtime libs. curl: HEALTHCHECK. git: parity with
# deploy/modal_app.py (some pip sdists still build from VCS checkouts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 curl git \
    && rm -rf /var/lib/apt/lists/*

# Deps first so code changes do not re-download torch.
WORKDIR /app
COPY backend/requirements.txt backend/requirements-ci.txt /app/
RUN pip install --no-cache-dir -r requirements-ci.txt

# Application: same tree layout the FastAPI app expects (cwd-relative static/).
COPY backend/main.py /app/main.py
COPY backend/routes /app/routes
COPY backend/services /app/services
COPY backend/static /app/static
# Seed voices live outside the /app/data volume so a mounted volume cannot
# shadow them (seeding skips harmlessly if the dir is empty).
COPY backend/data/default_voices /app/seed_voices

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    MODEL_DIR=/app/data/models \
    DEFAULT_VOICES_DIR=/app/seed_voices \
    HF_HOME=/app/data/hf \
    EASYOCR_MODULE_PATH=/app/data/easyocr \
    BOOKVOICE_SERVER_MODE=1 \
    BOOKVOICE_HOST=0.0.0.0 \
    BOOKVOICE_PORT=8000 \
    OCR_USE_GPU=0

RUN useradd --uid 10001 bookvoice \
    && mkdir -p /app/data /app/data/models \
    && chown -R bookvoice:bookvoice /app/data
USER bookvoice

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app"]
