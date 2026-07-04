# BookVoice

A web application that allows you to point a camera at a physical book page, extract the text using OCR, and narrate it using high-quality Text-to-Speech (Resemble AI Chatterbox).

## Architecture

*   **Frontend**: React + Vite + Tesseract.js (for client-side OCR)
*   **Backend**: Python FastAPI + Chatterbox TTS
*   **Storage**: Local files in `backend/data/` (no database required for MVP)

## Requirements

*   Node.js (for the frontend)
*   Python 3.11 (for the backend)
*   `uv` (fast Python package manager)
*   An NVIDIA GPU with at least 8GB VRAM (tested on RTX 4060)

## Quick Start (Development)

### 1. Setup Backend
1. `cd backend`
2. Create a virtual environment: `uv venv --python 3.11`
3. Activate the environment (Windows): `.venv\Scripts\activate`
4. Install PyTorch with CUDA 12.1:
   `uv pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121`
5. Install dependencies:
   `uv pip install chatterbox-tts setuptools fastapi[standard] pydantic python-multipart`
6. Start the server:
   `uvicorn main:app --reload`
   *(Runs on http://localhost:8000)*

### 2. Setup Frontend
1. `cd frontend`
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev`
4. Open the displayed local URL in your browser.

## Known Limitations

*   **Single-Shot Capture**: The application captures one page at a time. Continuous streaming is not yet supported.
*   **No Accounts / Cloud Sync**: Sessions and generated audio files are stored locally on disk (`backend/data/sessions/`). They are lost on browser refresh since the session ID generates randomly.
*   **Footnotes**: Footnote markers in text may be read aloud inline.
*   **Tesseract Data**: The frontend fetches Tesseract language data (~20MB) from a CDN on the first run.
