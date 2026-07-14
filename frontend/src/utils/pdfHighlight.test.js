import { describe, it, expect } from 'vitest';
import { applyWordHighlight, buildWordSpanMap, splitTextLayerWordRuns } from './pdfHighlight';

function fakeSpan(text) {
  return { textContent: text };
}

describe('buildWordSpanMap', () => {
  it('maps words to spans sequentially without false global matches', () => {
    const words = ['Once', 'upon', 'a', 'time', 'in', 'a', 'land'];
    const spans = [
      fakeSpan('Once upon'),
      fakeSpan('a time'),
      fakeSpan('in a land'),
    ];
    const layer = {
      querySelectorAll: () => spans,
    };
    const map = buildWordSpanMap(words, layer);
    expect(map[0]).toBe(spans[0]);
    expect(map[1]).toBe(spans[0]);
    expect(map[2]).toBe(spans[1]);
    expect(map[3]).toBe(spans[1]);
    expect(map[4]).toBe(spans[2]);
    // Second "a" should be the one in the third span, not the first "a"
    expect(map[5]).toBe(spans[2]);
    expect(map[6]).toBe(spans[2]);
  });

  it('splits multi-word PDF runs into independently highlightable fragments', () => {
    const layer = document.createElement('div');
    const run = document.createElement('span');
    run.textContent = 'Once upon a time';
    layer.appendChild(run);

    splitTextLayerWordRuns(layer);
    const map = buildWordSpanMap(['Once', 'upon', 'a', 'time'], layer);

    expect(map.every(Boolean)).toBe(true);
    expect(new Set(map).size).toBe(4);
    expect(map.map((span) => span.textContent)).toEqual(['Once', 'upon', 'a', 'time']);
  });

  it('highlights without scrolling the PDF or outer window', () => {
    const layer = document.createElement('div');
    const span = document.createElement('span');
    span.scrollIntoView = vi.fn();
    layer.appendChild(span);

    applyWordHighlight(layer, [span], 0, { current: null });

    expect(span).toHaveClass('highlight-active');
    expect(span.scrollIntoView).not.toHaveBeenCalled();
  });
});
