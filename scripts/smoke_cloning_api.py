import subprocess
import time
import requests
import sys
import os

print("Starting standalone API server in dist/...")
server_process = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"],
    cwd="dist",
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)

print("Waiting for server to start...")
time.sleep(5)
for _ in range(30):
    try:
        resp = requests.get("http://localhost:8000/api/translate/", timeout=2)
        if resp.status_code in [404, 405, 422]:
            break
    except:
        time.sleep(1)

success = True
try:
    print("\n--- Testing Voice Cloning API ---")
    
    # We will just upload verification_test.wav as the voice profile
    wav_path = "verification_test.wav"
    if not os.path.exists(wav_path):
        print("FAIL: verification_test.wav not found. Run TTS test first.")
        success = False
    else:
        with open(wav_path, "rb") as f:
            files = {"file": ("clone_test.wav", f, "audio/wav")}
            data = {"name": "Test Profile"}
            resp = requests.post("http://localhost:8000/api/voices/", files=files, data=data)
        
        print(f"POST /api/voices/ Status: {resp.status_code}")
        print(f"Response: {resp.json()}")
        if resp.status_code != 200:
            print("FAIL: Voice cloning API failed.")
            success = False
        else:
            voice_id = resp.json().get("id", "")
            profile_path = os.path.join("dist", "data", "voices", f"{voice_id}.wav")
            if voice_id and os.path.exists(profile_path) and os.path.getsize(profile_path) > 0:
                print(f"PASS: Voice profile audio created at {profile_path} (Size: {os.path.getsize(profile_path)} bytes)")
            else:
                print(f"FAIL: Voice profile audio not found at {profile_path}")
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
