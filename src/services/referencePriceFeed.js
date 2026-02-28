import WebSocket from 'ws';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443';
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;

let ws = null;
let reconnectTimer = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let shuttingDown = false;
let started = false;

const stateByAsset = new Map();

function getStreamNames() {
    const interval = config.dominanceDuration;
    return config.dominanceAssets.flatMap((asset) => {
        const symbol = config.dominanceRefSymbols[asset];
        return [
            `${symbol}@trade`,
            `${symbol}@kline_${interval}`,
        ];
    });
}

function getWsUrl() {
    const streams = getStreamNames().join('/');
    return `${BINANCE_WS_BASE}/stream?streams=${streams}`;
}

function getOrCreateState(asset) {
    if (!stateByAsset.has(asset)) {
        stateByAsset.set(asset, {
            asset,
            symbol: config.dominanceRefSymbols[asset],
            currentPrice: 0,
            openPrice: 0,
            closePrice: 0,
            deltaBps: 0,
            klineStart: 0,
            eventTime: 0,
        });
    }
    return stateByAsset.get(asset);
}

function updateDelta(state) {
    if (state.currentPrice > 0 && state.openPrice > 0) {
        state.deltaBps = ((state.currentPrice - state.openPrice) / state.openPrice) * 10000;
    } else {
        state.deltaBps = 0;
    }
}

function handleTradeEvent(event) {
    const symbol = String(event.s || '').toLowerCase();
    const asset = Object.entries(config.dominanceRefSymbols).find(([, mapped]) => mapped === symbol)?.[0];
    if (!asset) return;

    const state = getOrCreateState(asset);
    state.currentPrice = Number(event.p) || state.currentPrice;
    state.eventTime = Number(event.E) || Date.now();
    updateDelta(state);
}

function handleKlineEvent(event) {
    const kline = event.k;
    if (!kline) return;

    const symbol = String(event.s || '').toLowerCase();
    const asset = Object.entries(config.dominanceRefSymbols).find(([, mapped]) => mapped === symbol)?.[0];
    if (!asset) return;

    const state = getOrCreateState(asset);
    state.openPrice = Number(kline.o) || state.openPrice;
    state.closePrice = Number(kline.c) || state.closePrice;
    state.klineStart = Number(kline.t) || state.klineStart;
    state.eventTime = Number(event.E) || Date.now();
    if (state.currentPrice <= 0 && state.closePrice > 0) {
        state.currentPrice = state.closePrice;
    }
    updateDelta(state);
}

function handlePayload(payload) {
    const data = payload?.data || payload;
    if (!data || typeof data !== 'object') return;

    switch (data.e) {
        case 'trade':
            handleTradeEvent(data);
            break;
        case 'kline':
            handleKlineEvent(data);
            break;
        default:
            break;
    }
}

function scheduleReconnect() {
    if (reconnectTimer || shuttingDown || !started) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }, reconnectDelayMs);
}

function cleanupSocket(schedule = true) {
    const socket = ws;
    if (socket) {
        ws = null;
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.on('close', () => {});
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
        }
    }
    if (schedule) scheduleReconnect();
}

function connect() {
    if (shuttingDown || !started || ws) return;

    ws = new WebSocket(getWsUrl());

    ws.on('open', () => {
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        logger.info(`Reference feed connected (${config.dominanceDuration.toUpperCase()} Binance spot)`);
    });

    ws.on('message', (raw) => {
        try {
            handlePayload(JSON.parse(raw.toString()));
        } catch {
            // Ignore malformed public market payloads.
        }
    });

    ws.on('close', () => {
        cleanupSocket(true);
    });

    ws.on('error', (err) => {
        logger.warn(`Reference feed error: ${err.message}`);
        cleanupSocket(true);
    });
}

export function startReferencePriceFeed() {
    if (started) return;
    started = true;
    shuttingDown = false;
    stateByAsset.clear();
    connect();
}

export function getReferencePriceState(asset) {
    const state = stateByAsset.get(String(asset).toLowerCase());
    return state ? { ...state } : null;
}

export function stopReferencePriceFeed() {
    started = false;
    shuttingDown = true;
    stateByAsset.clear();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        cleanupSocket(false);
    }
}
