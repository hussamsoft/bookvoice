import React from 'react';

export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('BookVoice UI error', error, info?.componentStack || '');
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <main className="error-fallback" role="alert">
                <h1>The reader hit an unexpected error</h1>
                <p>Your book and settings have not been deleted. Reload the reader to continue.</p>
                <button
                    type="button"
                    className="btn primary"
                    onClick={() => this.setState({ error: null })}
                >
                    Try again
                </button>
            </main>
        );
    }
}
