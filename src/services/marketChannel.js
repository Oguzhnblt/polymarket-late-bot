import WebSocket from 'ws';
import logger from '../utils/logger.js';

const MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;
const MAX_TRADE_HISTORY_MS = 5000;

let ws = null;
let reconnectTimer = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let shuttingDown = false;

const subscribedTokenIds = new Set();
const tokenState = new Map();

function pruneTrades(state, now = Date.now()) {
    state.recentTrades = (state.recentTrades || []).filter(
        (trade) => now - trade.timestamp <= MAX_TRADE_HISTORY_MS,
    );
}

function getOrCreateTokenState(tokenId) {
    const key = String(tokenId);
    if (!tokenState.has(key)) {
        tokenState.set(key, {
            tokenId: key,
            bestBid: 0,
            bestBidSize: 0,
            bestAsk: 0,
            bestAskSize: 0,
            spread: null,
            imbalance: null,
            microprice: null,
            micropriceEdge: null,
            lastTradePrice: 0,
            lastTradeSide: '',
            lastTradeTimestamp: 0,
            recentTrades: [],
            bookTimestamp: 0,
            tickSize: 0,
            tickSizeChanged: false,
            lastTickChangeTimestamp: 0,
        });
    }
    return tokenState.get(key);
}

function normalizePrice(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function readOptionalNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function updateMicrostructure(state) {
    if (state.bestBid > 0 && state.bestAsk > 0) {
        state.spread = Math.max(0, state.bestAsk - state.bestBid);
    } else {
        state.spread = null;
    }

    const totalSize = state.bestBidSize + state.bestAskSize;
    if (state.bestBid > 0 && state.bestAsk > 0 && totalSize > 0) {
        state.imbalance = state.bestBidSize / totalSize;
        state.microprice = (
            (state.bestAsk * state.bestBidSize) +
            (state.bestBid * state.bestAskSize)
        ) / totalSize;
        state.micropriceEdge = state.microprice - ((state.bestBid + state.bestAsk) / 2);
    } else {
        state.imbalance = null;
        state.microprice = null;
        state.micropriceEdge = null;
    }
}

function handleBookEvent(event) {
    const state = getOrCreateTokenState(event.asset_id);
    const bids = Array.isArray(event.bids) ? event.bids : [];
    const asks = Array.isArray(event.asks) ? event.asks : [];

    state.bestBid = bids.length > 0 ? normalizePrice(bids[0].price) : 0;
    state.bestBidSize = bids.length > 0 ? normalizePrice(bids[0].size) : 0;
    state.bestAsk = asks.length > 0 ? normalizePrice(asks[0].price) : 0;
    state.bestAskSize = asks.length > 0 ? normalizePrice(asks[0].size) : 0;
    state.bookTimestamp = Number(event.timestamp) || Date.now();
    updateMicrostructure(state);
}

function handleBestBidAskEvent(event) {
    const state = getOrCreateTokenState(event.asset_id);
    state.bestBid = normalizePrice(event.best_bid);
    state.bestAsk = normalizePrice(event.best_ask);
    const bestBidSize = readOptionalNumber(
        event.best_bid_size ?? event.bid_size ?? event.bidSize,
    );
    const bestAskSize = readOptionalNumber(
        event.best_ask_size ?? event.ask_size ?? event.askSize,
    );
    if (bestBidSize !== null) state.bestBidSize = bestBidSize;
    if (bestAskSize !== null) state.bestAskSize = bestAskSize;
    state.bookTimestamp = Number(event.timestamp) || Date.now();
    updateMicrostructure(state);
}

function handlePriceChangeEvent(event) {
    const changes = Array.isArray(event.price_changes) ? event.price_changes : [];
    for (const change of changes) {
        const state = getOrCreateTokenState(change.asset_id);
        state.bestBid = normalizePrice(change.best_bid);
        state.bestAsk = normalizePrice(change.best_ask);
        const bestBidSize = readOptionalNumber(
            change.best_bid_size ?? change.bid_size ?? change.bidSize,
        );
        const bestAskSize = readOptionalNumber(
            change.best_ask_size ?? change.ask_size ?? change.askSize,
        );
        if (bestBidSize !== null) state.bestBidSize = bestBidSize;
        if (bestAskSize !== null) state.bestAskSize = bestAskSize;
        state.bookTimestamp = Number(event.timestamp) || Date.now();
        updateMicrostructure(state);
    }
}

function handleLastTradeEvent(event) {
    const state = getOrCreateTokenState(event.asset_id);
    const timestamp = Number(event.timestamp) || Date.now();

    state.lastTradePrice = normalizePrice(event.price);
    state.lastTradeSide = String(event.side || '').toUpperCase();
    state.lastTradeTimestamp = timestamp;
    state.recentTrades.push({
        side: state.lastTradeSide,
        price: state.lastTradePrice,
        size: normalizePrice(event.size),
        timestamp,
    });
    pruneTrades(state, timestamp);
}

function handleTickSizeChangeEvent(event) {
    const state = getOrCreateTokenState(event.asset_id);
    state.tickSizeChanged = true;
    state.lastTickChangeTimestamp = Number(event.timestamp) || Date.now();
    state.tickSize = normalizePrice(
        event.new_tick_size
        ?? event.tick_size
        ?? event.tickSize
        ?? event.min_tick_size
        ?? event.minimum_tick_size,
    );
}

function handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    switch (event.event_type) {
        case 'book':
            handleBookEvent(event);
            break;
        case 'best_bid_ask':
            handleBestBidAskEvent(event);
            break;
        case 'price_change':
            handlePriceChangeEvent(event);
            break;
        case 'last_trade_price':
            handleLastTradeEvent(event);
            break;
        case 'tick_size_change':
            handleTickSizeChangeEvent(event);
            break;
        default:
            break;
    }
}

function onMessage(raw) {
    try {
        const parsed = JSON.parse(raw.toString());
        if (Array.isArray(parsed)) {
            parsed.forEach(handleEvent);
            return;
        }
        handleEvent(parsed);
    } catch {
        // Ignore malformed payloads from the public market stream.
    }
}

function scheduleReconnect() {
    if (reconnectTimer || shuttingDown || subscribedTokenIds.size === 0) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }, reconnectDelayMs);
}

function sendSubscription() {
    if (!ws || ws.readyState !== WebSocket.OPEN || subscribedTokenIds.size === 0) return;
    ws.send(JSON.stringify({
        assets_ids: Array.from(subscribedTokenIds),
        type: 'market',
        custom_feature_enabled: true,
    }));
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
    if (schedule) {
        scheduleReconnect();
    }
}

function connect() {
    if (shuttingDown || subscribedTokenIds.size === 0 || ws) return;

    ws = new WebSocket(MARKET_WS_URL);

    ws.on('open', () => {
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        sendSubscription();
    });

    ws.on('message', onMessage);

    ws.on('close', () => {
        cleanupSocket(true);
    });

    ws.on('error', (err) => {
        logger.warn(`Market channel error: ${err.message}`);
        cleanupSocket(true);
    });
}

export function subscribeMarketTokens(tokenIds) {
    tokenIds.map(String).forEach((tokenId) => subscribedTokenIds.add(tokenId));
    shuttingDown = false;
    if (!ws) {
        connect();
        return;
    }
    if (ws.readyState === WebSocket.OPEN) {
        sendSubscription();
    }
}

export function unsubscribeMarketTokens(tokenIds) {
    tokenIds.map(String).forEach((tokenId) => {
        subscribedTokenIds.delete(tokenId);
        tokenState.delete(tokenId);
    });

    if (subscribedTokenIds.size === 0) {
        stopMarketChannel();
        return;
    }
    if (ws?.readyState === WebSocket.OPEN) {
        sendSubscription();
    }
}

export function getMarketTokenState(tokenId) {
    const state = tokenState.get(String(tokenId));
    if (!state) return null;
    pruneTrades(state);
    return {
        ...state,
        recentTrades: [...state.recentTrades],
    };
}

export function stopMarketChannel() {
    shuttingDown = true;
    subscribedTokenIds.clear();
    tokenState.clear();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        cleanupSocket(false);
    }
}
