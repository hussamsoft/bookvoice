import React from 'react';
import BookSession from './components/BookSession';

function App() {
    return (
        <div className="app-container">
            <header className="main-header">
                <h1>BookVoice</h1>
                <p>Physical Book Narration</p>
            </header>
            
            <main className="main-content">
                <BookSession />
            </main>
        </div>
    );
}

export default App;
