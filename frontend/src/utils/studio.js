export const DEFAULT_STUDIO_SETTINGS = {
    pace: 1,
    expression: 0.5,
    temperature: 0.8,
    guidance: null,
    seed: null,
};

export const STUDIO_DELIVERY_PRESETS = [
    { id: 'natural', label: 'Natural', pace: 1.0, expression: 0.5, temperature: 0.8, hint: 'Balanced reading' },
    { id: 'expressive', label: 'Expressive', pace: 0.95, expression: 0.75, temperature: 0.9, hint: 'Story & dramatic tone' },
    { id: 'fast', label: 'Fast & Crisp', pace: 1.15, expression: 0.35, temperature: 0.6, hint: 'Podcast & news tempo' },
];
