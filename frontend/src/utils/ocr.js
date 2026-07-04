import Tesseract from 'tesseract.js';

export async function extractTextFromImage(imageSrc) {
    try {
        // We use Tesseract's CDN to fetch the English .traineddata file (~20MB) 
        // on the first run rather than bundling it locally. This avoids bloating the
        // initial package and simplifies the worker setup for the MVP.
        const result = await Tesseract.recognize(
            imageSrc,
            'eng',
            { logger: m => console.log(m) }
        );
        return result.data.text;
    } catch (error) {
        console.error("OCR Error:", error);
        throw new Error("Failed to extract text from image.");
    }
}
