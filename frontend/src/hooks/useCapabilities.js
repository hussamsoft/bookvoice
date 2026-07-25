import { useEffect, useState } from 'react';
import { DEFAULT_CAPABILITIES, loadCapabilities } from '../utils/capabilities';

/** Backend-reported capability flags, defaulting to desktop behaviour. */
export function useCapabilities() {
    const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);

    useEffect(() => {
        let cancelled = false;
        loadCapabilities().then((next) => {
            if (!cancelled) setCapabilities(next);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return capabilities;
}
