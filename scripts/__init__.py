# Marker module — lets `build.py` and other repo-root scripts `import scripts`
# as a package (with `scripts.stage_media_tools`, `scripts.measure_bundle`,
# `scripts.stage_runtime_bundle`, etc.) without each import site having to
# know whether to import by short name or fully-qualified path.
