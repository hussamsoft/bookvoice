"""
Standalone BookVoice-Launcher.

One small executable end users download and pin to the taskbar. Double-clicking
it starts BookVoice if the app is installed; if it is not, the same executable
first downloads and installs the release, then starts the app. No console
window, no batch files, and no separate setup program.

Behavior:
  * Installed      -> spawn the installed ``Launcher.exe`` detached and exit;
                      nothing is ever shown on this fast path.
  * Not installed  -> show a compact progress window, fetch the checksummed
                      release manifest, download the offline cabinets, run the
                      selected MSI, then start the app.
  * ``--repair``   -> force the install flow even when an install exists.
  * ``--machine``  -> install the all-users MSI (elevates via UAC).
  * ``--quiet``    -> run Windows Installer silently where possible.

All other arguments (``--browser``, ``--tunnel``, ``--port``, ``--host``, a
``.bookvoice`` path, ...) are forwarded to the installed launcher untouched.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path

APP_NAME = "BookVoice"
LAUNCHER_EXE = "Launcher.exe"
REPOSITORY_URL = "https://github.com/hussamsoft/bookvoice/releases"

INSTALL_KEY = r"Software\BookVoice\Install"
ASSOC_COMMAND_KEY = r"Software\Classes\BookVoice.PreparedBook\shell\open\command"
SETUP_MUTEX_NAME = "Local\\BookVoice-Launcher-Setup"

DETACHED_PROCESS = 0x00000008

LAUNCHER_FLAGS = {"--repair", "--reinstall", "--machine", "--quiet", "--help", "-h"}
LAUNCHER_VALUE_FLAGS = {"--manifest-url"}


def log_path() -> Path:
    base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    directory = Path(base) / APP_NAME
    try:
        directory.mkdir(parents=True, exist_ok=True)
        return directory / "launcher.log"
    except OSError:
        return Path(tempfile.gettempdir()) / "bookvoice_launcher.log"


LOG_PATH = log_path()


def log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}"
    try:
        with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def split_args(argv: list[str]) -> tuple[dict[str, str | bool], list[str]]:
    """Separate launcher-only flags from arguments meant for the app."""
    options: dict[str, str | bool] = {}
    forwarded: list[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in LAUNCHER_VALUE_FLAGS:
            value = argv[index + 1] if index + 1 < len(argv) else ""
            options[token.lstrip("-")] = value
            index += 2
            continue
        if token in LAUNCHER_FLAGS:
            options[token.lstrip("-")] = True
            index += 1
            continue
        if not token.startswith("-") and token.lower().endswith(".bookvoice"):
            forwarded.append(os.path.realpath(token))
            index += 1
            continue
        forwarded.append(token)
        index += 1
    return options, forwarded


def looks_like_install(directory: Path) -> bool:
    """Cheap payload check mirroring launch.py's own validation."""
    exe = directory / LAUNCHER_EXE
    if not exe.is_file():
        return False
    for candidate in (directory, directory.parent):
        if (candidate / "main.py").is_file() and (candidate / "static" / "index.html").is_file():
            return True
    return False


def candidate_from_registry_path(root_name: str) -> Path | None:
    try:
        import winreg
    except ImportError:
        return None
    try:
        root = getattr(winreg, root_name)
        # x64 MSIs write anchors to the 64-bit view; a 32-bit launcher process
        # must read that view explicitly or machine installs become invisible.
        access = winreg.KEY_READ | winreg.KEY_WOW64_64KEY
        with winreg.OpenKey(root, INSTALL_KEY, 0, access) as key:
            value, _type = winreg.QueryValueEx(key, "Path")
    except OSError:
        return None
    directory = Path(str(value).strip().strip('"'))
    return directory if looks_like_install(directory) else None


def candidate_from_association(root_name: str) -> Path | None:
    try:
        import winreg
    except ImportError:
        return None
    try:
        root = getattr(winreg, root_name)
        access = winreg.KEY_READ | winreg.KEY_WOW64_64KEY
        with winreg.OpenKey(root, ASSOC_COMMAND_KEY, 0, access) as key:
            command, _type = winreg.QueryValueEx(key, "")
    except OSError:
        return None
    match = re.search(r'"([^"]+)' + re.escape(LAUNCHER_EXE) + r'"', str(command))
    if not match:
        return None
    # group(1) ends right before "Launcher.exe", often including the final
    # path separator; rebuild the executable path instead of taking .parent
    # of a directory-looking string.
    directory = Path(f"{match.group(1)}{LAUNCHER_EXE}").parent
    return directory if looks_like_install(directory) else None


def default_candidates() -> list[Path]:
    local = os.environ.get("LOCALAPPDATA")
    # Prefer the 64-bit path: a 32-bit launcher process resolves ProgramFiles
    # to "Program Files (x86)", where machine installs never live.
    program_files = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles")
    candidates = []
    if local:
        candidates.append(Path(local) / APP_NAME / "App")
    if program_files:
        candidates.append(Path(program_files) / APP_NAME)
    return candidates


def discover_install() -> Path | None:
    for root_name in ("HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"):
        found = candidate_from_registry_path(root_name) or candidate_from_association(root_name)
        if found:
            return found
    for directory in default_candidates():
        if looks_like_install(directory):
            return directory
    return None


def spawn_app(install_dir: Path, forwarded: list[str]) -> None:
    exe = install_dir / LAUNCHER_EXE
    log(f"starting {exe} args={forwarded}")
    subprocess.Popen(
        [str(exe), *forwarded],
        cwd=str(install_dir),
        creationflags=DETACHED_PROCESS,
        close_fds=True,
    )


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def elevate_and_restart(argv: list[str]) -> bool:
    """Re-run this launcher elevated so a machine-scope install can proceed.

    The exact argv the user supplied is forwarded verbatim; rebuilding it from
    parsed state would silently drop unknown-but-forwarded flags.
    """
    if getattr(sys, "frozen", False):
        executable = sys.executable
        parameters = list(argv)
    else:
        executable = sys.executable
        parameters = [str(Path(__file__).resolve()), *argv]
    code = ctypes.windll.shell32.ShellExecuteW(
        None, "runas", executable, subprocess.list2cmdline(parameters), None, 1
    )
    if code > 32:
        log("elevation accepted; handing off to elevated copy")
        return True
    log(f"elevation declined or failed (code={code})")
    return False


def acquire_setup_mutex() -> int | None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.restype = ctypes.wintypes.HANDLE
    kernel32.CreateMutexW.argtypes = [
        ctypes.wintypes.HANDLE,
        ctypes.wintypes.BOOL,
        ctypes.wintypes.LPCWSTR,
    ]
    handle = kernel32.CreateMutexW(None, False, SETUP_MUTEX_NAME)
    if handle and ctypes.get_last_error() != 183:
        return handle
    if handle:
        kernel32.CloseHandle(handle)
    return None


def release_setup_mutex(handle: int | None) -> None:
    if handle:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
        kernel32.CloseHandle(ctypes.c_void_p(handle))


class InstallFlow:
    """Drives manifest fetch, download, and MSI installation off the UI thread."""

    def __init__(self, options: dict[str, str | bool]):
        self.options = options
        self.cancel_event = threading.Event()
        self.events: queue.Queue = queue.Queue()
        self._mutex: int | None = None

    def post(self, kind: str, **payload) -> None:
        self.events.put({"kind": kind, **payload})

    def run(self) -> None:
        self._mutex = acquire_setup_mutex()
        if not self._mutex:
            self.post("error", message="Another BookVoice install is already running.")
            return
        try:
            self._run_inner()
        finally:
            release_setup_mutex(self._mutex)

    def _run_inner(self) -> None:
        try:
            bootstrapper = _load_bootstrapper()
        except Exception as exc:
            log(f"bootstrapper unavailable: {exc}")
            self.post("error", message="Installer components are missing from this executable.")
            return

        try:
            product = "machine" if self.options.get("machine") else "user"
            manifest_url = str(self.options.get("manifest-url") or "") or bootstrapper.DEFAULT_MANIFEST_URL
            self.post("status", message="Checking the latest release…")
            manifest = bootstrapper.fetch_manifest(manifest_url)
            bootstrapper.validate_manifest(manifest)
            base_url = manifest_url.rsplit("/", 1)[0]

            def report(event: dict) -> None:
                kind = event.get("kind")
                if kind == "plan":
                    self.post("plan", files=event["files"], total_bytes=event["bytes"])
                elif kind == "file":
                    self.post(
                        "file",
                        name=event["name"],
                        index=event["index"],
                        count=event["count"],
                        size=int(manifest["assets"][event["name"]]["size"]),
                    )
                elif kind == "bytes":
                    self.post("bytes", received=event["received"], size=event["size"])

            target = bootstrapper.ensure_files(
                manifest,
                base_url,
                product,
                progress=report,
                cancel_event=self.cancel_event,
            )
        except bootstrapper.InstallCancelled:
            self.post("cancelled")
            return
        except Exception as exc:
            log(f"download failed: {exc}")
            self.post("error", message=str(exc))
            return

        self.post("phase-install")
        try:
            quiet = bool(self.options.get("quiet")) or product == "user"
            code = bootstrapper.run_installer(target, manifest["products"][product]["msi"], quiet)
        except Exception as exc:
            log(f"msiexec failed: {exc}")
            self.post("error", message=str(exc))
            return
        # 0 = success, 3010/1641 = success pending a reboot.
        if code not in (0, 3010, 1641):
            log(f"msiexec returned {code}")
            self.post("error", message=f"Windows Installer exited with code {code}.")
            return
        self.post("done")


def _load_bootstrapper():
    try:
        import setup_bootstrapper as module
        return module
    except ImportError:
        pass
    scripts_dir = Path(__file__).resolve().parent / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import setup_bootstrapper as module
    return module


USAGE = (
    f"{APP_NAME} Launcher\n\n"
    "Double-click to start BookVoice; installs it first if needed.\n\n"
    "Options:\n"
    "  --repair          Reinstall even when BookVoice is already installed\n"
    "  --machine         Install for all users (asks for administrator access)\n"
    "  --quiet           Install silently\n"
    "  --manifest-url U  Fetch release metadata from U instead of GitHub\n\n"
    "Everything else is passed to BookVoice itself, e.g.\n"
    f"  BookVoice-Launcher.exe --browser\n"
    '  BookVoice-Launcher.exe "My Book.bookvoice"\n\n'
    f"Log: {LOG_PATH}"
)


def show_message(title: str, message: str) -> None:
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(title, message, parent=root)
        root.destroy()
    except Exception:
        ctypes.windll.user32.MessageBoxW(None, message, title, 0x40)


class InstallWindow:
    """Compact progress dialog shown only while installing."""

    WIDTH = 470
    HEIGHT = 190

    def __init__(self, flow: InstallFlow, on_finished):
        import tkinter as tk
        from tkinter import ttk

        self.tk = tk
        self.ttk = ttk
        self.flow = flow
        self.on_finished = on_finished

        self.file_size = 0
        self.file_index = 0
        self.file_count = 0
        self.file_name = ""
        self.installing = False

        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.resizable(False, False)

        frame = ttk.Frame(self.root, padding=18)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text=f"Installing {APP_NAME}", font=("Segoe UI", 12, "bold")).pack(anchor="w")

        self.status = tk.StringVar(value="Preparing…")
        ttk.Label(frame, textvariable=self.status, wraplength=self.WIDTH - 60).pack(anchor="w", pady=(6, 10))

        style = ttk.Style(self.root)
        style.theme_use("vista" if "vista" in style.theme_names() else "default")
        self.bar = ttk.Progressbar(frame, maximum=10000, length=self.WIDTH - 60)
        self.bar.pack(fill="x")

        buttons = ttk.Frame(frame)
        buttons.pack(anchor="e", pady=(12, 0))
        self.retry_button = ttk.Button(buttons, text="Retry", command=self.start_retry, state="disabled")
        self.retry_button.pack(side="left", padx=4)
        self.page_button = ttk.Button(
            buttons, text="Open download page", command=lambda: webbrowser.open(REPOSITORY_URL)
        )
        self.page_button.pack(side="left", padx=4)
        self.close_button = ttk.Button(buttons, text="Cancel", command=self.cancel)
        self.close_button.pack(side="left", padx=4)

        self.root.protocol("WM_DELETE_WINDOW", self.cancel)
        self.center()
        self.root.after(80, self.poll)
        self.start_worker()

    def center(self):
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() - self.WIDTH) // 2
        y = (self.root.winfo_screenheight() - self.HEIGHT) // 3
        self.root.geometry(f"{self.WIDTH}x{self.HEIGHT}+{x}+{y}")

    def start_worker(self):
        self.worker_thread = threading.Thread(target=self.flow.run, daemon=True)
        self.worker_thread.start()

    def start_retry(self):
        self.retry_button.configure(state="disabled")
        self.installing = False
        self.bar.configure(value=0)
        self.status.set("Retrying…")
        self.close_button.configure(state="normal", text="Cancel", command=self.cancel)
        self.flow.cancel_event = threading.Event()
        self.start_worker()

    def cancel(self):
        if getattr(self, "installing", False):
            # Windows Installer is mid-flight; aborting here would orphan
            # msiexec and let a second launcher race it. Closing is refused
            # until the install phase reports back.
            return
        self.flow.cancel_event.set()
        self.root.destroy()

    def poll(self):
        try:
            while True:
                event = self.flow.events.get_nowait()
                if not self.handle(event):
                    return
        except queue.Empty:
            pass
        self.root.after(80, self.poll)

    def handle(self, event: dict) -> bool:
        kind = event["kind"]
        if kind == "plan":
            self.status.set(f"Downloading {APP_NAME} ({event['files']} files, "
                            f"{event['total_bytes'] / (1024 * 1024):,.0f} MB)…")
        elif kind == "status":
            self.status.set(event["message"])
        elif kind == "file":
            self.file_name = event["name"]
            self.file_size = event["size"]
            self.file_index = event["index"]
            self.file_count = event["count"]
        elif kind == "bytes":
            size = max(int(event.get("size") or self.file_size or 1), 1)
            received_mib = event["received"] / (1024 * 1024)
            total_mib = size / (1024 * 1024)
            self.bar.configure(value=min(int((event["received"] / size) * 10000), 10000))
            self.status.set(
                f"{self.file_name} ({self.file_index} of {self.file_count}) — "
                f"{received_mib:,.0f} of {total_mib:,.0f} MB"
            )
        elif kind == "phase-install":
            self.installing = True
            self.bar.configure(value=10000)
            self.close_button.configure(state="disabled", text="Installing…")
            self.status.set("Installing BookVoice — this can take a minute…")
        elif kind == "cancelled":
            self.root.destroy()
            return False
        elif kind == "done":
            # Launch immediately: a fast Close click must never swallow the
            # auto-start that was just promised.
            self.installing = False
            self.close_button.configure(state="disabled")
            self.status.set("Installed. Starting BookVoice…")
            self.on_finished()
            self.root.after(400, self.root.destroy)
            return False
        elif kind == "error":
            self.fail(event["message"])
        return True

    def fail(self, message: str):
        self.installing = False
        self.status.set(message)
        self.close_button.configure(state="normal", text="Close", command=self.root.destroy)
        self.retry_button.configure(state="normal")


def wait_for_install(max_seconds: float = 20.0) -> Path | None:
    deadline = time.time() + max_seconds
    while time.time() < deadline:
        found = discover_install()
        if found:
            return found
        time.sleep(0.5)
    return discover_install()


def run_install_and_launch(options: dict[str, str | bool], forwarded: list[str]) -> int:
    flow = InstallFlow(options)
    launcher_thread: list[threading.Thread] = []

    def launch_when_installed():
        install_dir = wait_for_install()
        if not install_dir:
            show_message(
                APP_NAME,
                "BookVoice was installed, but the launcher could not locate it.\n"
                f"Please double-click this launcher again. Log: {LOG_PATH}",
            )
            return
        try:
            spawn_app(install_dir, forwarded)
        except Exception as exc:
            log(f"post-install spawn failed: {exc}")
            show_message(
                APP_NAME,
                f"BookVoice was installed but did not start.\n{exc}\n\n"
                f"Double-click this launcher to try again. Log: {LOG_PATH}",
            )

    def on_finished():
        thread = threading.Thread(target=launch_when_installed, daemon=False)
        launcher_thread.append(thread)
        thread.start()

    try:
        window = InstallWindow(flow, on_finished)
    except Exception as exc:
        log(f"GUI unavailable ({exc}); cannot run the interactive install.")
        show_message(
            APP_NAME,
            "The installer window could not start.\n"
            f"See {LOG_PATH} for details, or download an installer manually:\n{REPOSITORY_URL}",
        )
        return 1
    window.root.mainloop()
    for thread in [*launcher_thread, getattr(window, "worker_thread", None)]:
        if thread is not None:
            # The worker may still be inside msiexec; abandoning it would
            # orphan a running installer.
            thread.join(timeout=120)
    return 0


def main(argv: list[str] | None = None) -> int:
    if os.name != "nt":
        message = f"{APP_NAME} is currently available for Windows."
        try:
            print(message, file=sys.stderr)
        except (OSError, AttributeError, ValueError):
            pass
        return 1

    argv = list(sys.argv[1:] if argv is None else argv)
    options, forwarded = split_args(argv)
    log(f"launcher start options={options} forwarded={forwarded}")

    if options.get("help"):
        show_message(f"{APP_NAME} Launcher", USAGE)
        return 0

    # Machine scope needs elevation before any window appears; UAC must not be
    # triggered from a Tk callback.
    if options.get("machine") and not is_admin():
        if elevate_and_restart(argv):
            return 0
        show_message(
            APP_NAME,
            "An all-users installation needs administrator permission.\n"
            "Run this launcher again and approve the prompt, or double-click it "
            "without --machine to install just for you.",
        )
        return 1

    repair = bool(options.get("repair") or options.get("reinstall"))
    if not repair:
        install_dir = discover_install()
        if install_dir:
            last_error = None
            for attempt in (1, 2, 3):
                try:
                    spawn_app(install_dir, forwarded)
                    return 0
                except Exception as exc:  # OSError plus stray Popen failures
                    last_error = exc
                    log(f"spawn attempt {attempt}/3 failed ({exc})")
                    time.sleep(1.0)
            show_message(
                APP_NAME,
                f"BookVoice was found but did not start.\n{last_error}\n\n"
                "Run this launcher with --repair to reinstall it.\n"
                f"Log: {LOG_PATH}",
            )
            return 1

    return run_install_and_launch(options, forwarded)


if __name__ == "__main__":
    raise SystemExit(main())
