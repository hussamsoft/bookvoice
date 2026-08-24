from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import launch


def test_splash_uses_packaged_identity_and_accessible_real_progress(tmp_path):
    icon = tmp_path / "bookvoice.ico"
    icon.write_bytes(b"bookvoice-icon")

    markup = launch.splash_html(str(icon))

    assert "data:image/x-icon;base64," in markup
    assert "BookVoice" in markup
    assert "Read, listen, and create" in markup
    assert 'role="progressbar"' in markup
    assert 'aria-valuenow="0"' in markup
    assert "prefers-reduced-motion:reduce" in markup
    assert "forced-colors:active" in markup
    assert "@keyframes" not in markup


def test_status_updates_copy_and_clamps_milestone_progress():
    calls = []
    window = SimpleNamespace(evaluate_js=calls.append)

    launch.set_status(window, "Reader's ready", "Opening </script> safely", 140)

    assert len(calls) == 1
    assert 'Reader\'s ready' in calls[0]
    assert "Opening </script> safely" in calls[0]
    assert "const value=100" in calls[0]
    assert "aria-valuenow" in calls[0]


def test_main_window_receives_splash_and_matching_dark_background(tmp_path):
    (tmp_path / "bookvoice.ico").write_bytes(b"icon")
    captured = {}

    class FakeWebview:
        @staticmethod
        def create_window(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return object()

    launch.create_main_window(FakeWebview(), str(tmp_path))

    assert captured["args"] == ("BookVoice",)
    assert "Startup progress" in captured["kwargs"]["html"]
    assert captured["kwargs"]["background_color"] == "#18181b"


def test_startup_error_keeps_technical_log_secondary_and_escapes_markup(tmp_path):
    log_path = tmp_path / "bookvoice_launch.log"
    log_path.write_text("private <trace> details", encoding="utf-8")
    loaded = []
    window = SimpleNamespace(load_html=loaded.append)

    with patch.object(launch, "webview", object()):
        launch.show_error(window, "Bad <runtime>", str(log_path))

    assert len(loaded) == 1
    assert "Bad &lt;runtime&gt;" in loaded[0]
    assert "<details>" in loaded[0]
    assert "private &lt;trace&gt; details" in loaded[0]
