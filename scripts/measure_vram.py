import subprocess
import time
import threading
import sys

def monitor_vram(interval=0.5, stop_event=None):
    max_vram = 0
    print("Starting VRAM monitor...")
    while not stop_event.is_set():
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                check=True
            )
            vram = int(result.stdout.strip())
            if vram > max_vram:
                max_vram = vram
        except Exception:
            pass
        time.sleep(interval)
    print(f"Max VRAM usage during run: {max_vram} MiB")
    return max_vram

stop_event = threading.Event()
monitor_thread = threading.Thread(target=monitor_vram, args=(0.5, stop_event))
monitor_thread.start()

print("Running verify_chatterbox.py...")
try:
    subprocess.run([sys.executable, "verify_chatterbox.py"], check=True)
finally:
    stop_event.set()
    monitor_thread.join()
