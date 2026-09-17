"""Public surface for the Voice Studio service.

The package was extracted from a single 1,777-line ``studio_service.py``
module; the public surface is preserved 1:1 so callers
(``routes/studio.py``, the desktop shell, the e2e journeys) see no
change. Internally the work is split into:

- ``devices``     - per-device ownership and ContextVar
- ``recordings``   - recording-retention helpers
- ``manifest``     - manifest IO + shared project/job state
- ``projects``     - project CRUD
- ``jobs``         - job orchestration
- ``media``        - media inspection, audio extraction, video preview, waveform peaks
- ``voice_profiles`` - voice profile creation
- ``narration``    - standalone Studio narration
- ``conversion``   - voice conversion
- ``repair``       - audio repair
- ``downloads``    - asset path resolution + output download
"""
from __future__ import annotations

# Re-exports preserve the legacy ``from services.studio_service import X``
# call sites. Tests that do ``patch("services.studio_service.X", ...)``
# continue to work because the package's ``__getattr__`` resolution
# forwards to the right submodule.

# devices
from .devices import (
    activate_device,
    current_device_id,
    deactivate_device,
    device_scope,
    validate_device_id,
)

# projects
from .projects import (
    claim_legacy_projects,
    create_project,
    delete_project,
    duplicate_project,
    get_project,
    legacy_projects_available,
    list_projects,
    reset_runtime_state_for_tests,
    update_project,
)

# jobs
from .jobs import (
    cancel_job,
    get_job,
    submit_job,
    update_job_progress,
)

# media
from .media import import_source_path

# voice_profiles
from .voice_profiles import create_voice_profile

# narration
from .narration import create_narration, validate_generation_settings

# conversion
from .conversion import create_conversion

# repair
from .repair import create_repair, export_repair_video

# downloads
from .downloads import (
    asset_path,
    open_project_folder,
    output_download,
)


# Expose the submodules so tests that previously reset
# ``services.studio_service._locks_guard = ...`` can now target
# ``services.studio_service.manifest._locks_guard = ...`` — the state
# lives in the submodules, not in the package namespace.
from . import devices  # noqa: E402,F401
from . import manifest  # noqa: E402,F401
from . import projects  # noqa: E402,F401
from . import jobs  # noqa: E402,F401
from . import media  # noqa: E402,F401
from . import recordings  # noqa: E402,F401
from . import voice_profiles  # noqa: E402,F401
from . import narration  # noqa: E402,F401
from . import conversion  # noqa: E402,F401
from . import repair  # noqa: E402,F401
from . import downloads  # noqa: E402,F401


__all__ = [
    # devices
    "activate_device",
    "current_device_id",
    "deactivate_device",
    "device_scope",
    "validate_device_id",
    # projects
    "claim_legacy_projects",
    "create_project",
    "delete_project",
    "duplicate_project",
    "get_project",
    "legacy_projects_available",
    "list_projects",
    "reset_runtime_state_for_tests",
    "update_project",
    # jobs
    "cancel_job",
    "get_job",
    "submit_job",
    "update_job_progress",
    # media
    "import_source_path",
    # voice_profiles
    "create_voice_profile",
    # narration
    "create_narration",
    "validate_generation_settings",
    # conversion
    "create_conversion",
    # repair
    "create_repair",
    "export_repair_video",
    # downloads
    "asset_path",
    "open_project_folder",
    "output_download",
    # submodules
    "devices",
    "manifest",
    "projects",
    "jobs",
    "media",
    "recordings",
    "voice_profiles",
    "narration",
    "conversion",
    "repair",
    "downloads",
]


# Forward attribute access on the package to its submodules. This keeps
# legacy ``services.studio_service._project_lock`` / ``_load_manifest``
# / ``MEDIA_EXTENSIONS`` / etc. paths working for tests that previously
# reached into the monolith's private namespace. ``__getattr__`` only
# runs when normal attribute lookup misses — the explicit re-exports
# above still win, and writes to module attributes (which tests no
# longer do after the setUp refactor) bypass this hook entirely.
_SUBMODULES_FOR_FORWARD = (
    devices,
    manifest,
    projects,
    jobs,
    media,
    recordings,
    voice_profiles,
    narration,
    conversion,
    repair,
    downloads,
)


def __getattr__(name):
    for sub in _SUBMODULES_FOR_FORWARD:
        try:
            return getattr(sub, name)
        except AttributeError:
            continue
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
