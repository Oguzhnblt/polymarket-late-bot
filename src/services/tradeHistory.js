import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

const HISTORY_PATH = path.resolve(process.cwd(), 'data', 'trade-history.jsonl');

function ensureHistoryStore() {
    mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
}

export function getTradeHistoryPath() {
    return HISTORY_PATH;
}

export function loadTradeHistory() {
    ensureHistoryStore();

    if (!existsSync(HISTORY_PATH)) {
        return [];
    }

    const raw = readFileSync(HISTORY_PATH, 'utf8');
    if (!raw.trim()) {
        return [];
    }

    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

export function appendTradeHistory(entry) {
    ensureHistoryStore();
    appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}
