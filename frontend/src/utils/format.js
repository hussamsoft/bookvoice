/**
 * Shared time formatting. Every clock label in the app comes from here so
 * durations look identical across the reader, recorder, and studio.
 */

export function formatClock(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const whole = Math.floor(value);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function formatClockTenths(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const rest = (value % 60).toFixed(1).padStart(4, '0');
    return `${minutes}:${rest}`;
}

export function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
