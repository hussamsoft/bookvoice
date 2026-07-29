"""Windows notification-area integration for the BookVoice desktop shell."""
from __future__ import annotations

import os
import threading

try:
    import pystray
    from PIL import Image
except ImportError:  # pragma: no cover - packaged launcher includes both
    pystray = None
    Image = None


class TrayUnavailable(RuntimeError):
    """Raised when the notification-area icon cannot be started."""


class SystemTray:
    """Keep BookVoice available after its native window is minimized."""

    def __init__(self, window, icon_path: str, log):
        self._window = window
        self._icon_path = icon_path
        self._log = log
        self._icon = None
        self._hidden = False
        self._notified = False
        self._lock = threading.RLock()

    def start(self) -> None:
        """Start the detached notification-area message loop."""
        with self._lock:
            if self._icon is not None:
                return
            if pystray is None or Image is None:
                raise TrayUnavailable("pystray or Pillow is not installed")
            if not os.path.isfile(self._icon_path):
                raise TrayUnavailable(f"tray icon is missing: {self._icon_path}")

            try:
                with Image.open(self._icon_path) as source:
                    image = source.copy()
                menu = pystray.Menu(
                    pystray.MenuItem(
                        "Open BookVoice",
                        self.show_window,
                        default=True,
                    ),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Quit BookVoice", self.quit_app),
                )
                icon = pystray.Icon(
                    "BookVoice",
                    image,
                    "BookVoice — running",
                    menu,
                )
                ready = threading.Event()
                setup_error = []

                def mark_ready(active_icon):
                    try:
                        active_icon.visible = True
                    except Exception as exc:
                        setup_error.append(exc)
                    finally:
                        ready.set()

                icon.run_detached(mark_ready)
                if not ready.wait(timeout=5):
                    icon.stop()
                    raise TrayUnavailable("notification-area icon did not become ready")
                if setup_error:
                    icon.stop()
                    raise TrayUnavailable(str(setup_error[0]))
                self._icon = icon
            except Exception as exc:
                raise TrayUnavailable(str(exc)) from exc

    def minimize_to_tray(self) -> None:
        """Hide a minimized native window so it leaves the Windows taskbar."""
        with self._lock:
            self._hidden = True
            icon = self._icon
            should_notify = not self._notified
            self._notified = True

        try:
            self._window.hide()
            self._log.write("window minimized to notification area")
        except Exception as exc:
            self._log.write(f"could not hide window in notification area: {exc}")
            return

        if icon is not None and should_notify:
            try:
                icon.notify(
                    "BookVoice is still running. Click its icon to reopen it.",
                    "Running in the background",
                )
            except Exception as exc:
                self._log.write(f"notification-area message unavailable: {exc}")

    def show_window(self, _icon=None, _item=None) -> None:
        """Restore and activate the native window."""
        with self._lock:
            was_hidden = self._hidden
            self._hidden = False
        try:
            if was_hidden:
                self._window.restore()
            self._window.show()
            self._log.write("window restored from notification area")
        except Exception as exc:
            self._log.write(f"could not restore window from notification area: {exc}")

    def quit_app(self, _icon=None, _item=None) -> None:
        """Close the native shell; the launcher then stops its server and tunnel."""
        self._log.write("quit requested from notification area")
        try:
            self._window.destroy()
        except Exception as exc:
            self._log.write(f"could not close window from notification area: {exc}")
        finally:
            self.stop()

    def stop(self) -> None:
        """Remove the notification-area icon and stop its message loop."""
        with self._lock:
            icon = self._icon
            self._icon = None
            self._hidden = False
        if icon is not None:
            try:
                icon.stop()
            except Exception as exc:
                self._log.write(f"notification-area shutdown skipped: {exc}")
