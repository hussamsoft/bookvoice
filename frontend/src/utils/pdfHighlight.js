/**
 * Align narrated words to PDF.js text-layer spans sequentially so highlighting
 * tracks reading order instead of substring-matching every "the"/"and" on the page.
 */

function normalizeToken(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}']/gu, '')
        .trim();
}

/** Split each PDF.js text run into visual word fragments without changing text. */
export function splitTextLayerWordRuns(textLayerEl) {
    if (!textLayerEl?.children) return;
    const runs = Array.from(textLayerEl.children).filter(
        (el) => el.tagName === 'SPAN' && !el.dataset.wordRunSplit
    );
    for (const run of runs) {
        const text = run.textContent || '';
        const parts = text.match(/\s+|\S+/gu) || [];
        if (parts.filter((part) => !/^\s+$/u.test(part)).length < 2) continue;
        const fragment = document.createDocumentFragment();
        for (const part of parts) {
            if (/^\s+$/u.test(part)) {
                fragment.appendChild(document.createTextNode(part));
            } else {
                const word = document.createElement('span');
                word.className = 'pdf-word-fragment';
                word.textContent = part;
                fragment.appendChild(word);
            }
        }
        run.replaceChildren(fragment);
        run.dataset.wordRunSplit = 'true';
    }
}

/**
 * Build a map: wordIndex → DOM span element (best effort sequential alignment).
 */
export function buildWordSpanMap(words, textLayerEl) {
    const map = new Array(words.length).fill(null);
    if (!textLayerEl || !words?.length) return map;

    const fragments = Array.from(textLayerEl.querySelectorAll('.pdf-word-fragment'));
    const spans = (fragments.length ? fragments : Array.from(textLayerEl.querySelectorAll('span'))).filter(
        (s) => s.textContent && s.textContent.trim()
    );

    let wordIdx = 0;
    for (const span of spans) {
        if (wordIdx >= words.length) break;

        // PDF spans may hold one or many tokens
        const spanTokens = span.textContent
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(normalizeToken)
            .filter(Boolean);

        if (!spanTokens.length) continue;

        // Consume as many upcoming words as match this span's tokens in order
        let ti = 0;
        while (wordIdx < words.length && ti < spanTokens.length) {
            const want = normalizeToken(words[wordIdx]);
            if (!want) {
                wordIdx++;
                continue;
            }
            const have = spanTokens[ti];
            if (
                have === want ||
                have.startsWith(want) ||
                want.startsWith(have) ||
                (want.length > 3 && have.includes(want)) ||
                (have.length > 3 && want.includes(have))
            ) {
                map[wordIdx] = span;
                wordIdx++;
                ti++;
            } else {
                // Span token doesn't match current word — try next span
                break;
            }
        }
    }

    return map;
}

/**
 * Apply highlight class only to the span for the current word (and optionally
 * a small look-ahead for multi-span words). Clears previous highlights first.
 */
export function applyWordHighlight(textLayerEl, wordSpanMap, currentWord, prevSpanRef) {
    if (!textLayerEl) return;

    // Clear previous single-span highlight if known, else full clear (rare)
    if (prevSpanRef?.current) {
        prevSpanRef.current.classList.remove('highlight-active');
        prevSpanRef.current = null;
    } else {
        textLayerEl.querySelectorAll('.highlight-active').forEach((el) => {
            el.classList.remove('highlight-active');
        });
    }

    if (currentWord < 0 || !wordSpanMap) return;

    const span = wordSpanMap[currentWord];
    if (span) {
        span.classList.add('highlight-active');
        if (prevSpanRef) prevSpanRef.current = span;

        // Keep active word roughly in view inside the scroll container
        try {
            span.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch {
            /* ignore */
        }
    }
}

export function clearPdfHighlights(root = document) {
    root.querySelectorAll?.('.highlight-active')?.forEach((el) => {
        el.classList.remove('highlight-active');
    });
}
