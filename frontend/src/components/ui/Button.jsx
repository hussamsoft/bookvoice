import React from 'react';

/**
 * The single button implementation. Variants map to the design-system
 * classes; `ghost` is the quiet inline action and `danger` composes with any
 * variant (e.g. primary+danger for destructive confirmations).
 */
const BASE_CLASS = 'btn';

function classesFor({ variant, compact, className }) {
    const names = [BASE_CLASS];
    if (variant === 'primary') names.push('primary');
    else if (variant === 'ghost') names.push('text');
    else names.push('secondary');
    if (variant === 'danger' || variant === 'primary-danger') {
        names.push('danger');
        if (variant === 'primary-danger') names.push('primary');
    }
    if (compact) names.push('compact');
    if (className) names.push(className);
    return names.join(' ');
}

export default function Button({
    variant = 'secondary',
    compact = false,
    icon: Icon,
    className = '',
    type = 'button',
    children,
    ...rest
}) {
    return (
        <button type={type} className={classesFor({ variant, compact, className })} {...rest}>
            {Icon ? <Icon size={16} aria-hidden="true" /> : null}
            {children}
        </button>
    );
}
