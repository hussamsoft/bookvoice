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

