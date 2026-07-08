import subprocess
import webview
import time
import sys
import os
import traceback
import socket
import psutil
import threading

def get_listening_pid(port):
    try:
        for conn in psutil.net_connections(kind='inet'):
            if conn.laddr.port == port and conn.status == 'LISTEN':
                return conn.pid
    except psutil.AccessDenied:
        pass
    return None

def is_bookvoice_process(pid):
    try:
        proc = psutil.Process(pid)
        cmdline = " ".join(proc.cmdline()).lower()
        return "uvicorn" in cmdline and "main:app" in cmdline
    except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
        pass
    return False

def find_available_port(start_port=8000, max_port=8020):
    port = start_port
    while port <= max_port:
        pid = get_listening_pid(port)
        if pid is None:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                try:
                    s.bind(('0.0.0.0', port))
                    return port
                except OSError:
                    pass
        else:
            if is_bookvoice_process(pid):
                try:
                    psutil.Process(pid).terminate()
                    time.sleep(1)
                    if psutil.pid_exists(pid):
                        psutil.Process(pid).kill()
                    return port
                except Exception:
                    pass
        port += 1
    return None

def main():
    if getattr(sys, 'frozen', False):
        application_path = os.path.dirname(sys.executable)
    else:
        application_path = os.path.dirname(os.path.abspath(__file__))
    
    backend_path = os.path.join(application_path, "backend")
    if not os.path.exists(backend_path):
        # Fallback if launched from dist folder during dev
        backend_path = os.path.join(application_path, "..", "backend")
        
    os.chdir(backend_path)
    
    port = find_available_port(8000, 8020)
    if port is None:
        port = 8000
        
    python_exe = os.path.normpath(os.path.join(backend_path, ".venv", "Scripts", "python.exe"))
    if not os.path.exists(python_exe):
        python_exe = "python"
            
    cmd = [python_exe, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", str(port)]
    
    creationflags = 0
    if os.name == 'nt':
        creationflags = subprocess.CREATE_NO_WINDOW
        
    process = subprocess.Popen(
        cmd, 
        shell=False, 
        cwd=backend_path,
        creationflags=creationflags
    )
    
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Loading BookVoice...</title>
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                background: #14110f; 
                color: #e5e5e5; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                height: 100vh; 
                margin: 0; 
            }
            .loader { 
                border: 3px solid rgba(255,255,255,0.1); 
                border-top: 3px solid #8b5cf6; 
                border-radius: 50%; 
                width: 40px; 
                height: 40px; 
                animation: spin 1s linear infinite; 
                margin: 0 auto 1.5rem auto; 
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .container { text-align: center; }
            h2 { font-weight: 500; font-size: 1.2rem; letter-spacing: 0.5px; margin: 0; }
            p { color: #9ca3af; font-size: 0.9rem; margin-top: 0.5rem; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="loader"></div>
            <h2>Starting AI Engine</h2>
            <p>Warming up Neural Voices...</p>
        </div>
    </body>
    </html>
    """

    window = webview.create_window('BookVoice', html=html_content, width=1280, height=800)
    
    def check_server():
        for _ in range(30):
            time.sleep(1)
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(1)
                    s.connect(('127.0.0.1', port))
                window.load_url(f'http://127.0.0.1:{port}')
                break
            except (ConnectionRefusedError, socket.timeout, OSError):
                pass
                
    threading.Thread(target=check_server, daemon=True).start()
    
    webview.start()
    
    try:
        process.terminate()
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()

if __name__ == "__main__":
    main()
