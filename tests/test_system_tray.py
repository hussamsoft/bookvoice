from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import launch
import system_tray


class _EventHook:
    def __init__(self):
        self.callbacks = []

    def __iadd__(self, callback):
        self.callbacks.append(callback)
        return self


class _Window:
    def __init__(self):
        self.events = SimpleNamespace(minimized=_EventHook())
        self.hide = MagicMock()
        self.restore = MagicMock()
        self.show = MagicMock()
        self.destroy = MagicMock()


class _Log:
    def __init__(self):
        self.messages = []

    def write(self, message):
        self.messages.append(message)


def _started_controller(tmp_path):
    icon_path = tmp_path / "bookvoice.ico"
    icon_path.write_bytes(b"icon")
    window = _Window()
    log = _Log()
    icon = MagicMock()
    image = MagicMock()
    source = MagicMock()
    source.copy.return_value = image

    image_open = MagicMock()
    image_open.return_value.__enter__.return_value = source
    fake_pystray = MagicMock()
    fake_pystray.Menu.side_effect = lambda *items: items
    fake_pystray.MenuItem.side_effect = lambda *args, **kwargs: (args, kwargs)
    fake_pystray.Icon.return_value = icon
    icon.run_detached.side_effect = lambda setup: setup(icon)

    image_patch = patch.object(system_tray, "Image", SimpleNamespace(open=image_open))
    pystray_patch = patch.object(system_tray, "pystray", fake_pystray)
    image_patch.start()
    pystray_patch.start()

    controller = system_tray.SystemTray(window, str(icon_path), log)
    controller.start()
    return controller, window, log, icon, image_patch, pystray_patch


def test_tray_starts_with_open_and_quit_actions(tmp_path):
    controller, _window, _log, icon, image_patch, pystray_patch = _started_controller(
        tmp_path
    )
    try:
        icon.run_detached.assert_called_once()
        assert callable(icon.run_detached.call_args.args[0])
        assert system_tray.pystray.MenuItem.call_count == 2
        first_call = system_tray.pystray.MenuItem.call_args_list[0]
        assert first_call.args[0] == "Open BookVoice"
        assert first_call.kwargs["default"] is True
        assert system_tray.pystray.MenuItem.call_args_list[1].args[0] == "Quit BookVoice"
    finally:
        controller.stop()
        image_patch.stop()
        pystray_patch.stop()


def test_minimize_hides_from_taskbar_and_restore_reopens(tmp_path):
    controller, window, _log, icon, image_patch, pystray_patch = _started_controller(
        tmp_path
    )
    try:
        controller.minimize_to_tray()
        controller.minimize_to_tray()

        assert window.hide.call_count == 2
        icon.notify.assert_called_once()

        with patch.object(
            system_tray, "restore_window_to_foreground", return_value=True
        ) as foreground:
            controller.show_window()

        window.restore.assert_called_once_with()
        window.show.assert_called_once_with()
        foreground.assert_called_once_with()
        assert any("brought into view" in message for message in _log.messages)
    finally:
        controller.stop()
        image_patch.stop()
        pystray_patch.stop()


def test_quit_from_tray_closes_window_and_stops_icon(tmp_path):
    controller, window, _log, icon, image_patch, pystray_patch = _started_controller(
        tmp_path
    )
    try:
        controller.quit_app()

        window.destroy.assert_called_once_with()
        icon.stop.assert_called_once_with()
    finally:
        controller.stop()
        image_patch.stop()
        pystray_patch.stop()


def test_monitor_overlap_requires_a_usefully_visible_window_area():
    monitors = [(0, 0, 1920, 1040), (1920, 0, 3840, 1040)]

    assert system_tray._has_useful_monitor_overlap((120, 80, 1320, 880), monitors)
    assert system_tray._has_useful_monitor_overlap((2000, 40, 3200, 840), monitors)
    assert not system_tray._has_useful_monitor_overlap((3900, 80, 5100, 880), monitors)
    assert not system_tray._has_useful_monitor_overlap((-1190, 40, 10, 840), monitors)


def test_native_visibility_does_not_unmaximize_an_already_visible_window():
    user32 = MagicMock()
    user32.IsIconic.return_value = False
    user32.IsWindowVisible.return_value = True

    system_tray._show_existing_window(user32, 123)

    user32.ShowWindow.assert_not_called()


def test_native_visibility_restores_only_a_still_minimized_window():
    user32 = MagicMock()
    user32.IsIconic.return_value = True

    system_tray._show_existing_window(user32, 123)

    user32.ShowWindow.assert_called_once_with(123, 9)


def test_launcher_attaches_tray_only_after_it_starts(tmp_path):
    window = _Window()
    log = _Log()
    controller = MagicMock()

    with patch.object(system_tray, "SystemTray", return_value=controller) as factory:
        configured = launch.configure_system_tray(window, str(tmp_path), log)

    assert configured is controller
    factory.assert_called_once_with(
        window,
        str(tmp_path / "bookvoice.ico"),
        log,
    )
    controller.start.assert_called_once_with()
    assert window.events.minimized.callbacks == [controller.minimize_to_tray]


def test_launcher_keeps_normal_window_behavior_when_tray_is_unavailable(tmp_path):
    window = _Window()
    log = _Log()

    with patch.object(
        system_tray,
        "SystemTray",
        side_effect=system_tray.TrayUnavailable("not installed"),
    ):
        configured = launch.configure_system_tray(window, str(tmp_path), log)

    assert configured is None
    assert window.events.minimized.callbacks == []
    assert any("notification-area icon unavailable" in message for message in log.messages)
