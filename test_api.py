import subprocess
import time
import requests
import sys
import os
import threading

# Start uvicorn server in dist/
print("Starting standalone API server in dist/...")
server_process = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"],
    cwd="dist",
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True
)

def stream_logs(proc):
    for line in iter(proc.stdout.readline, ''):
        print(f"[SERVER] {line.rstrip()}")

threading.Thread(target=stream_logs, args=(server_process,), daemon=True).start()

# Wait for server to be ready
print("Waiting for server to start...")
time.sleep(5)
for _ in range(30):
    try:
        resp = requests.get("http://localhost:8000/api/translate/", timeout=2)
        if resp.status_code in [404, 405, 422]: # API is up
            break
    except:
        time.sleep(1)

success = True
try:
    # 1. Test frontend static serving
    print("\n--- Testing Frontend Static Serving ---")
    resp = requests.get("http://localhost:8000/")
    print(f"GET / Status: {resp.status_code}")
    if resp.status_code != 200 or "<html" not in resp.text:
        print("FAIL: Frontend not served correctly.")
        success = False
    else:
        print("PASS")

    # 2. Test Translation API
    print("\n--- Testing Translation API ---")
    resp = requests.post("http://localhost:8000/api/translate/", json={"text": "Hello world", "target_lang": "es"})
    print(f"POST /api/translate Status: {resp.status_code}")
    if resp.status_code != 200:
        print("FAIL: Translation API failed.")
        success = False
    else:
        print("PASS")

    # 3. Test TTS Narration API (English)
    print("\n--- Testing TTS Narration API (English) ---")
    resp = requests.post("http://localhost:8000/api/tts/narrate", json={
        "text": "This is a backend test.",
        "session_id": "test_session_123",
        "page_index": 0,
        "language_id": "en"
    })
    print(f"POST /api/tts/narrate Status: {resp.status_code}")
    if resp.status_code != 200:
        print("FAIL: TTS API failed.")
        success = False
    else:
        audio_url = resp.json().get("audio_url")
        if audio_url:
            local_path = os.path.join("dist", audio_url.lstrip("/"))
            if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                print(f"PASS: Audio file created at {local_path} (Size: {os.path.getsize(local_path)} bytes)")
            else:
                print(f"FAIL: Audio file not found at {local_path}")
                success = False

    # 4. Test TTS Narration API (Multilingual)
    print("\n--- Testing TTS Narration API (Multilingual) ---")
    resp = requests.post("http://localhost:8000/api/tts/narrate", json={
        "text": "Bonjour tout le monde.",
        "session_id": "test_session_123",
        "page_index": 1,
        "language_id": "fr"
    })
    print(f"POST /api/tts/narrate (French) Status: {resp.status_code}")
    if resp.status_code != 200:
        print("FAIL: Multilingual TTS API failed.")
        success = False
    else:
        audio_url = resp.json().get("audio_url")
        if audio_url:
            local_path = os.path.join("dist", audio_url.lstrip("/"))
            if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                print(f"PASS: Multilingual audio file created at {local_path} (Size: {os.path.getsize(local_path)} bytes)")
            else:
                print(f"FAIL: Multilingual audio file not found at {local_path}")
                success = False
except Exception as e:
    print(f"Exception during testing: {e}")
    success = False
finally:
    print("\nShutting down server...")
    server_process.terminate()
    try:
        server_process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server_process.kill()

if not success:
    sys.exit(1)
