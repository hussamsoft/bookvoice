# Running BookVoice (Packaged Build)

This `dist` folder contains the packaged, standalone version of BookVoice. The frontend has been built into static assets (`static/` folder) and is served directly by the FastAPI backend, so you only need to run one process.

## Prerequisites
- Python 3.11
- `uv` (fast Python package manager)
- An NVIDIA GPU (for CUDA)

## Setup
1. Open a terminal in this `dist` directory.
2. Create a virtual environment:
   ```bash
   uv venv --python 3.11
   ```
3. Activate it (Windows):
   ```bash
   .venv\Scripts\activate
   ```
4. Install the exact dependencies from the freeze file:
   ```bash
   uv pip install -r requirements.txt
   ```
   *(Note: This includes the specific CUDA version of PyTorch used during packaging).*

## Running the App
1. Start the server using Uvicorn:
   ```bash
   uvicorn main:app
   ```
   *(By default, it will run on `http://localhost:8000`)*

2. Open `http://localhost:8000` in your browser.
3. The server will handle all static files (HTML, CSS, JS) and API calls (`/api/tts/narrate`).

Enjoy narrating your physical books!
