"""Guard the launcher entrypoints against references to deleted functions.

`migrate_legacy_runtime` was removed from launch.py in v2.4.1 but both call
sites survived: launch.main() kept a bare call (NameError on every launch) and
dev_launcher.main() kept `launch.migrate_legacy_runtime(...)` (AttributeError).
`launch.wait_until` never existed at all. None of it is covered by an
end-to-end test, so all of it shipped. These checks are static, so they run
without starting a server or touching the filesystem.
"""

import ast
import builtins
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILTINS = set(dir(builtins))

# Modules whose call targets must all resolve to something the module binds.
SCRIPT_MODULES = ("launch.py", "dev_launcher.py", "launcher_app.py", "system_tray.py")

# Modules that do `import launch` and reach through it.
LAUNCH_CONSUMERS = ("dev_launcher.py",)


def _load_launch():
    spec = importlib.util.spec_from_file_location("launch", ROOT / "launch.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _bound_names(tree: ast.AST) -> set[str]:
    """Every name bound anywhere in the tree: assignments, defs, imports, params.

    Closures and platform-guarded definitions make per-scope resolution noisy,
    and a name bound in no scope at all is the failure this module guards.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
            args = getattr(node, "args", None)
            if args is not None:
                for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
                    names.add(arg.arg)
                for arg in (args.vararg, args.kwarg):
                    if arg is not None:
                        names.add(arg.arg)
        elif isinstance(node, ast.Lambda):
            args = node.args
            for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
                names.add(arg.arg)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
    return names


def _dotted_path(node: ast.Attribute) -> str | None:
    """Flatten `launch.tunnel.resolve_settings` into that dotted string.

    Returns None for anything not rooted at a bare `launch` name, e.g. a
    subscript or a call result in the middle of the chain.
    """
    parts = []
    current: ast.expr = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name) or current.id != "launch":
        return None
    return ".".join(reversed(parts))


def _launch_attribute_paths(tree: ast.AST) -> set[str]:
    """Every full `launch.…` chain, not just its first hop.

    Checking one level only verified that `launch.tunnel` exists while letting
    `launch.tunnel.resolve_settings` through unchecked -- the same shape of
    AttributeError this module exists to catch.
    """
    paths = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        # Skip inner nodes: the outermost Attribute carries the whole chain.
        if isinstance(getattr(node, "parent", None), ast.Attribute):
            continue
        path = _dotted_path(node)
        if path:
            paths.add(path)
    return paths


def _unresolved_segment(launch, path: str) -> bool:
    """True when any hop of the dotted path is missing from the live module."""
    target = launch
    for part in path.split("."):
        if not hasattr(target, part):
            return True
        target = getattr(target, part)
    return False


def _link_parents(tree: ast.AST) -> ast.AST:
    """ast nodes carry no parent pointer; the chain walk needs one."""
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            child.parent = parent
    return tree


class EntrypointSymbolTests(unittest.TestCase):
    def test_launch_attributes_used_by_consumers_exist(self):
        """`launch.X` (and `launch.X.Y`) reached through an import must exist."""
        launch = _load_launch()
        for rel in LAUNCH_CONSUMERS:
            with self.subTest(module=rel):
                tree = _link_parents(ast.parse((ROOT / rel).read_text(encoding="utf-8")))
                missing = sorted(
                    {
                        path
                        for path in _launch_attribute_paths(tree)
                        if _unresolved_segment(launch, path)
                    }
                )
                self.assertEqual(
                    missing,
                    [],
                    f"{rel} references launch attributes that do not exist: {missing}",
                )

    def test_script_modules_have_no_undefined_call_targets(self):
        """A bare call to a name nothing binds is a NameError waiting to fire."""
        for rel in SCRIPT_MODULES:
            with self.subTest(module=rel):
                tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
                known = _bound_names(tree) | BUILTINS
                unresolved = sorted(
                    {
                        node.func.id
                        for node in ast.walk(tree)
                        if isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name)
                        and node.func.id not in known
                    }
                )
                self.assertEqual(
                    unresolved,
                    [],
                    f"{rel} calls undefined names: {unresolved}",
                )


if __name__ == "__main__":
    unittest.main()
