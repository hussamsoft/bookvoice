/**
 * Bridge to the pywebview native window shell (WindowApi in launch.py).
 *
 * The launcher appends `?shell=native` when it hosts the app in a frameless
 * pywebview window, so the custom title bar can render before the
 * `pywebviewready` bridge injection completes. In a plain browser
 * (`launch.py --browser` or dev server) none of this is active.
 */

let readyPromise = null;

export function isNativeShell() {
    if (typeof window === 'undefined') return false;
    if (window.pywebview) return true;
    try {
        return new URLSearchParams(window.location.search).get('shell') === 'native';
    } catch {
        return false;
    }
}

function api() {
    if (window.pywebview?.api) return Promise.resolve(window.pywebview.api);
    if (!readyPromise) {
        readyPromise = new Promise((resolve) => {
            window.addEventListener(
                'pywebviewready',
                () => resolve(window.pywebview.api),
                { once: true }
            );
        });
    }
    return readyPromise;
}

export async function minimizeWindow() {
    try {
        (await api()).minimize();
    } catch {
        /* bridge unavailable — nothing to minimize */
    }
}

/** Returns true when the window ends up maximized, false when restored. */
export async function toggleMaximizeWindow() {
    try {
        return Boolean(await (await api()).toggle_maximize());
    } catch {
        return false;
    }
}

export async function closeWindow() {
    try {
        (await api()).close();
    } catch {
        /* bridge unavailable — nothing to close */
    }
}
