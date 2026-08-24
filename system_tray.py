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


def _has_useful_monitor_overlap(
    rect: tuple[int, int, int, int],
    work_areas: list[tuple[int, int, int, int]],
    minimum_width: int = 96,
    minimum_height: int = 64,
) -> bool:
    """Return whether enough of a window is visible to find and move it."""
    left, top, right, bottom = rect
    for area_left, area_top, area_right, area_bottom in work_areas:
        overlap_width = min(right, area_right) - max(left, area_left)
        overlap_height = min(bottom, area_bottom) - max(top, area_top)
        if overlap_width >= minimum_width and overlap_height >= minimum_height:
            return True
    return False


def _show_existing_window(user32, hwnd) -> None:
    """Show a hidden/minimized window without changing its restored size."""
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    elif not user32.IsWindowVisible(hwnd):
        user32.ShowWindow(hwnd, 5)  # SW_SHOW


def restore_window_to_foreground(title: str = "BookVoice") -> bool:
    """Bring this process's existing native window on-screen and to the front.

    pywebview can restore its window state, but Windows may retain coordinates
    from a disconnected display and does not guarantee foreground activation.
    Keep those platform details here so the reader UI remains untouched.
    """
    if os.name != "nt":
        return False

    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        process_id = os.getpid()
        matches: list[tuple[int, bool]] = []

        enum_window_proc = ctypes.WINFUNCTYPE(
            wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
        )

        def collect_window(hwnd, _lparam):
            owner_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
            if owner_pid.value != process_id:
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            text_buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, text_buffer, len(text_buffer))
            window_title = text_buffer.value.strip()
            if window_title:
                matches.append((hwnd, window_title == title))
            return True

        callback = enum_window_proc(collect_window)
        user32.EnumWindows(callback, 0)
        if not matches:
            return False
        hwnd = next((handle for handle, exact in matches if exact), matches[0][0])

        _show_existing_window(user32, hwnd)

        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return False
        window_rect = (rect.left, rect.top, rect.right, rect.bottom)

        monitor_areas: list[tuple[int, int, int, int]] = []

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]

        monitor_proc = ctypes.WINFUNCTYPE(
            wintypes.BOOL,
            wintypes.HANDLE,
            wintypes.HDC,
            ctypes.POINTER(wintypes.RECT),
            wintypes.LPARAM,
        )

        def collect_monitor(monitor, _hdc, _rect, _lparam):
            info = MONITORINFO()
            info.cbSize = ctypes.sizeof(MONITORINFO)
            if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                work = info.rcWork
                area = (work.left, work.top, work.right, work.bottom)
                if info.dwFlags & 1:
                    monitor_areas.insert(0, area)
                else:
                    monitor_areas.append(area)
            return True

        monitor_callback = monitor_proc(collect_monitor)
        user32.EnumDisplayMonitors(0, 0, monitor_callback, 0)

        SWP_NOZORDER = 0x0004
        SWP_SHOWWINDOW = 0x0040
        if monitor_areas and not _has_useful_monitor_overlap(window_rect, monitor_areas):
            primary = monitor_areas[0]
            work_width = primary[2] - primary[0]
            work_height = primary[3] - primary[1]
            width = min(max(rect.right - rect.left, 640), work_width)
            height = min(max(rect.bottom - rect.top, 480), work_height)
            x = primary[0] + (work_width - width) // 2
            y = primary[1] + (work_height - height) // 2
            user32.SetWindowPos(
                hwnd, 0, x, y, width, height, SWP_NOZORDER | SWP_SHOWWINDOW
            )

        # A tray click is a direct activation request. The brief topmost toggle
        # makes it deterministic even when Windows declines SetForegroundWindow.
        HWND_TOPMOST = wintypes.HWND(-1)
        HWND_NOTOPMOST = wintypes.HWND(-2)
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        return True
    except Exception:
        return False


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
            if restore_window_to_foreground():
                self._log.write(
                    "window restored from notification area and brought into view"
                )
            else:
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
