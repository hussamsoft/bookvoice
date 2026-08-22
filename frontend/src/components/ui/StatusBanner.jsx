import React from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';

const ICONS = {
    info: Info,
    loading: Info,
    success: CheckCircle2,
    error: AlertCircle,
};

/**
 * One banner for model status, prefetch hints, and job outcomes.
 * tone: 'info' | 'loading' | 'success' | 'error' | 'prefetch'
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
