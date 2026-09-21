// Pre-paint theme bootstrap. Loaded as an external <script src=…> so the
// production CSP (default-src 'self', no 'unsafe-inline') can ship without
// needing a per-build SHA hash. Runs synchronously before <link rel="stylesheet">
// is parsed, so it sets the data-palette / data-mode attributes that tokens.css
// is scoped to and avoids the white-flash dark-mode users see on every cold
// start when the theme is applied only after React mounts.
//
// Storage keys (same read order as frontend/src/hooks/useTheme.js):
//   bookvoice.mode    / bookvoice:mode / bookvoice.theme  -> 'dark' | 'light' | 'system'
//   bookvoice.palette / bookvoice:palette                 -> one of PALETTE_IDS
//
// F-35: this mirrors the React side's validation. Unknown palette ids and
// unknown mode values (stale or hand-edited storage) fall back to the
// defaults instead of painting a half-migrated theme. 'system' resolves
// through prefers-color-scheme here, exactly like useTheme's effectiveMode.
// The hard-coded palette→background map below mirrors the values in
// frontend/src/styles/tokens.css for the default `paper` palette; the
// initial data-palette is set to whichever *valid* palette is stored so
// the very first paint already shows the user's chosen colours.
(function bootstrapTheme() {
    var PALETTE_IDS = ['paper', 'blue', 'sage', 'plum', 'sand'];
    var MODES = ['system', 'light', 'dark'];
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var palette = 'paper';
    var storedMode, storedPalette;
    function firstStored(keys) {
        for (var i = 0; i < keys.length; i += 1) {
            try {
                var value = window.localStorage.getItem(keys[i]);
                if (value !== null) return value;
            } catch {
                return null;
            }
        }
        return null;
    }
    try {
        storedMode = firstStored(['bookvoice.mode', 'bookvoice:mode', 'bookvoice.theme']);
        if (storedMode !== null && MODES.indexOf(storedMode) !== -1) {
            dark = storedMode === 'dark'
                || (storedMode === 'system' && dark);
        }
        // Anything else (unknown value or nothing stored) keeps 'system'
        // semantics: resolve from prefers-color-scheme above.
        storedPalette = firstStored(['bookvoice.palette', 'bookvoice:palette']);
        if (storedPalette !== null && PALETTE_IDS.indexOf(storedPalette) !== -1) {
            palette = storedPalette;
        }
    } catch (storageError) {
        // Storage is unavailable (private mode, quota, etc.); fall back
        // to the system colour-scheme preference above.
        void storageError;
    }
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
}());
