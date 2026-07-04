export function cleanExtractedText(text) {
    if (!text) return "";
    
    // Strip standalone page numbers and running headers/footers
    // Removes lines that only contain numbers and whitespace
    let cleaned = text.replace(/^\s*\d+\s*$/gm, "");
    
    // Fix hyphenated line-break words (e.g. "exam-\nple" -> "example")
    // Match a letter, a hyphen, optional whitespace/newlines, and another letter
    cleaned = cleaned.replace(/([a-zA-Z])-\s*\n\s*([a-zA-Z])/g, "$1$2");
    
    // Collapse excessive whitespace/line breaks into natural paragraph breaks
    // Preserve double newlines as paragraphs, but single newlines inside paragraphs become spaces
    
    // First, standardize line endings
    cleaned = cleaned.replace(/\r\n/g, "\n");
    
    // Split by double newlines to find paragraphs
    const paragraphs = cleaned.split(/\n\s*\n/);
    
    // Inside each paragraph, replace single newlines with spaces
    const processedParagraphs = paragraphs.map(p => {
        return p.replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();
    }).filter(p => p.length > 0);
    
    // Rejoin with double newlines
    return processedParagraphs.join("\n\n");
}
