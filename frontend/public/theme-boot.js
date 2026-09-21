// Pre-paint theme bootstrap. Loaded as an external <script src=…> so the
// production CSP (default-src 'self', no 'unsafe-inline') can ship without
// needing a per-build SHA hash. Runs synchronously before <link rel="stylesheet">
// is parsed, so it sets the data-palette / data-mode attributes that tokens.css
// is scoped to, and avoids the white-flash dark-mode users see on every cold
// start when the theme is applied only after React mounts.
//
// Storage keys:
//   bookvoice.mode / bookvoice:mode / bookvoice.theme  -> 'dark' | 'light'
//   bookvoice.palette / bookvoice:palette              -> any palette id
//
// The hard-coded palette→background map below mirrors the values in
// frontend/src/styles/tokens.css for the default `paper` palette; the
// initial data-palette is set to whichever palette is stored so the very
// first paint already shows the user's chosen colours.
(function bootstrapTheme() {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var palette = 'paper';
    var storedMode, storedPalette;
    try {
        storedMode = window.localStorage.getItem('bookvoice.mode');
        if (storedMode !== 'dark' && storedMode !== 'light') {
            storedMode = window.localStorage.getItem('bookvoice:mode');
        }
        if (storedMode !== 'dark' && storedMode !== 'light') {
            storedMode = window.localStorage.getItem('bookvoice.theme');
        }
        if (storedMode === 'dark' || storedMode === 'light') dark = storedMode === 'dark';
        storedPalette = window.localStorage.getItem('bookvoice.palette');
        if (!storedPalette) storedPalette = window.localStorage.getItem('bookvoice:palette');
        if (storedPalette) palette = storedPalette;
    } catch (storageError) {
        // Storage is unavailable (private mode, quota, etc.); fall back
        // to the system colour-scheme preference above.
        void storageError;
    }
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
}());
