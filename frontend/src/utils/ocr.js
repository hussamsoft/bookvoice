const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export async function extractTextFromImage(imageSrc) {
    try {
        const response = await fetch(`${API_BASE}/api/ocr/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ image_data: imageSrc })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || "Failed to process image OCR on the server.");
        }
        
        const data = await response.json();
        return data.text;
    } catch (error) {
        console.error("OCR Error:", error);
        throw error;
    }
}
