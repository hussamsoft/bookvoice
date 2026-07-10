import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-pdf', () => ({ pdfjs: { getDocument: vi.fn() } }));
import { usePdfDocument } from './usePdfDocument';

describe('usePdfDocument', () => {
  it('reuses the PDF proxy loaded by react-pdf', async () => {
    const file = { arrayBuffer: vi.fn() };
    const proxy = { numPages: 12, getPage: vi.fn() };
    const { result } = renderHook(() => usePdfDocument({
      file,
      fileRef: { current: file },
      toast: null,
    }));

    act(() => result.current.adoptPdfDocument(proxy));
    await expect(result.current.getPdfDocument()).resolves.toBe(proxy);
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('keeps reviewed page text in the session cache', async () => {
    const { result } = renderHook(() => usePdfDocument({
      file: null,
      fileRef: { current: null },
      toast: null,
    }));

    act(() => result.current.cachePageText(3, 'corrected text'));
    await expect(result.current.preparePageText(3)).resolves.toBe('corrected text');
  });

  it('finds embedded PDF text without invoking OCR', async () => {
    const proxy = {
      numPages: 3,
      getPage: vi.fn(async (page) => ({
        getTextContent: async () => ({ items: [{ str: page === 2 ? 'needle here' : 'other' }] }),
      })),
    };
    const { result } = renderHook(() => usePdfDocument({ file: null, fileRef: { current: null }, toast: null }));
    act(() => result.current.adoptPdfDocument(proxy));

    await expect(result.current.findTextInDocument('needle', 1)).resolves.toBe(2);
  });
});
