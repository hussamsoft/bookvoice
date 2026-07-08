import React from 'react';
import { BookOpen } from 'lucide-react';
import BookSession from './components/BookSession';

import PdfViewer from './components/PdfViewer';

function App() {
    const [mode, setMode] = React.useState('pdf'); // 'camera' or 'pdf'

    return (
        <div className="app-container">
            <header className="main-header">
                <div className="brand" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BookOpen className="brand-icon" size={28} strokeWidth={1.5} />
                        <div>
                            <h1>BookVoice</h1>
                            <p>Turn any page into narration</p>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button 
                            className={`btn ${mode === 'camera' ? 'primary' : 'secondary'}`} 
                            onClick={() => setMode('camera')}
                        >
                            Camera Mode
                        </button>
                        <button 
                            className={`btn ${mode === 'pdf' ? 'primary' : 'secondary'}`} 
                            onClick={() => setMode('pdf')}
                        >
                            PDF Mode
                        </button>
                    </div>
                </div>
            </header>
            
            <main className="main-content">
                {mode === 'camera' ? <BookSession /> : <PdfViewer />}
            </main>
        </div>
    );
}

export default App;
