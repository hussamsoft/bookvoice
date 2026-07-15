export async function mapWithConcurrency(items, limit, worker, onComplete = () => {}) {
    const values = Array.from(items || []);
    if (!values.length) return [];
    const width = Math.max(1, Math.min(values.length, Math.floor(Number(limit)) || 1));
    const results = new Array(values.length);
    let cursor = 0;
    let completed = 0;

    async function run() {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(values[index], index);
            completed += 1;
            onComplete(completed, values.length, values[index]);
        }
    }

    await Promise.all(Array.from({ length: width }, () => run()));
    return results;
}
