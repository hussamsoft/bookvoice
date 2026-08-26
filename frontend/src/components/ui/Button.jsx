import React, { forwardRef } from 'react';

/**
 * The single button primitive. Variants map to the design-system classes;
 * sizes map to the --control-h tokens (`md` is the .btn default height).
 * `ghost` is the quiet inline action and `danger` reads as destructive.
 */
const VARIANT_CLASS = {
    primary: 'primary',
    secondary: 'secondary',
    ghost: 'text',
    danger: 'danger',
};

const SIZE_CLASS = {
    sm: 'btn-sm',
    md: '',
    lg: 'btn-lg',
};

const Button = forwardRef(function Button(
    {
        variant = 'secondary',
        size = 'md',
        icon: Icon,
        className = '',
        type = 'button',
        children,
        ...rest
    },
    ref
) {
    const names = ['btn', VARIANT_CLASS[variant] || 'secondary'];
    const sizeClass = SIZE_CLASS[size];
    if (sizeClass) names.push(sizeClass);
    if (className) names.push(className);
    return (
        <button ref={ref} type={type} className={names.join(' ')} {...rest}>
            {Icon ? <Icon size={16} aria-hidden="true" /> : null}
            {children}
        </button>
    );
});

export default Button;
