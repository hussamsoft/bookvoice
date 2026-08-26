import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

const ICONS = {
    info: Info,
    loading: Info,
    success: CheckCircle2,
    error: AlertCircle,
    warning: AlertTriangle,
};

/**
 * One banner for model status, prefetch hints, and job outcomes.
 * tone: 'info' | 'loading' | 'success' | 'error' | 'warning' | 'prefetch'
 */
export default function StatusBanner({ tone = 'info', children, action }) {
    const Icon = ICONS[tone] ?? ICONS.info;
    const className =
        tone === 'error'
            ? 'status-banner error'
            : tone === 'loading' || tone === 'info'
                ? 'status-banner loading'
                : `status-banner ${tone}`;
    return (
        <div className={className} role="status">
            <Icon size={16} aria-hidden="true" />
            <span>{children}</span>
            {action}
        </div>
    );
}
