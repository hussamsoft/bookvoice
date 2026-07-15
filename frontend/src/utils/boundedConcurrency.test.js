import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './boundedConcurrency';

describe('mapWithConcurrency', () => {
    it('preserves order while limiting parallel work', async () => {
        let active = 0;
        let peak = 0;
        const completed = [];
        const result = await mapWithConcurrency(
            [1, 2, 3, 4, 5],
            2,
            async (value) => {
                active += 1;
                peak = Math.max(peak, active);
                await Promise.resolve();
                active -= 1;
                return value * 2;
            },
            (count) => completed.push(count)
        );

        expect(result).toEqual([2, 4, 6, 8, 10]);
        expect(peak).toBe(2);
        expect(completed).toHaveLength(5);
    });
});
