import { useEffect, useState } from 'react';
import { KeyRound, RotateCw } from 'lucide-react';
import { signIn } from '../utils/api';
import { loadAccessState, resetCapabilities } from '../utils/capabilities';

/**
 * Password gate for hosted deployments.
 *
 * The desktop app binds to loopback and the backend reports `authRequired:
 * false`, so this renders its children immediately and never appears.
 */
export default function AccessGate({ children }) {
    const [state, setState] = useState(null);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadAccessState().then((next) => {
            if (!cancelled) setState(next);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const submit = async (event) => {
        event.preventDefault();
        setSubmitting(true);
        setError('');
        try {
            await signIn(password);
            resetCapabilities();
            setPassword('');
            setState({ authRequired: true, authenticated: true });
        } catch (signInError) {
            setError(signInError.message || 'That password is not correct.');
        } finally {
            setSubmitting(false);
        }
    };

    if (state === null) {
        return (
            <div className="access-gate" role="status">
                <RotateCw size={20} className="spin" aria-hidden="true" /> Checking access…
            </div>
        );
    }

    if (!state.authRequired || state.authenticated) {
        return children;
    }

    return (
        <div className="access-gate">
            <form className="access-card" onSubmit={submit}>
                <KeyRound size={28} aria-hidden="true" />
                <h1>BookVoice</h1>
                <p>This deployment is private. Enter the access password to continue.</p>
                <label htmlFor="access-password">Access password</label>
                <input
                    id="access-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={submitting}
                    autoFocus
                />
                {error && <p className="access-error" role="alert">{error}</p>}
                <button className="btn primary" type="submit" disabled={submitting || !password}>
                    {submitting ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}
