import { extractTextFromImageApi } from './api';

export async function extractTextFromImage(imageSrc) {
    try {
        return await extractTextFromImageApi(imageSrc);
    } catch (error) {
        console.error('OCR Error:', error);
        throw error;
    }
}
