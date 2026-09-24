// Pre-paint theme bootstrap. Loaded as an external <script src=…> so the
// production CSP (default-src 'self', no 'unsafe-inline') can ship without
// needing a per-build SHA hash. Runs synchronously before <link rel="stylesheet">
// is parsed, so it sets the data-palette / data-mode attributes that tokens.css
// is scoped to and avoids the white-flash dark-mode users see on every cold
// start when the theme is applied only after React mounts.
//
// Storage keys mirror frontend/src/hooks/useTheme.js. Paper is the default
// light surface, Night is selected with the existing dark mode value, and
// legacy palette ids normalize to Paper without changing the chosen mode.
(function bootstrapTheme() {
    var MODES = ['system', 'light', 'dark'];
    var dark = false;
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
                || (storedMode === 'system' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
        }
        storedPalette = firstStored(['bookvoice.palette', 'bookvoice:palette']);
        if (storedPalette === 'night' && storedMode === null) dark = true;
    } catch (storageError) {
        void storageError;
    }
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
}());
