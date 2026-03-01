/**
 * trend.js — Dominance (Trend) Bot Entry Point
 */

import { validateDominanceConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient } from './services/client.js';
import { startDominanceDetector, stopDominanceDetector } from './services/dominanceDetector.js';
import { executeDominanceStrategy, getActiveDominancePositions, getStats } from './services/dominanceExecutor.js';
import { stopPriceWatcher } from './services/wsPriceWatcher.js';
import { initTUI, logToTUI } from './utils/tui.js';

// Intercept console for logger and set TUI output
logger.interceptConsole();
logger.setOutput(logToTUI);

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateDominanceConfig();
} catch (err) {
    logger.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Startup ──────────────────────────────────────────────────────────────────
const modeLabel = config.dryRun ? 'SIMULATION' : 'LIVE';

// Start services
initTUI();
logger.info(`=== Dominance (Trend) Bot [${modeLabel}] ===`);
logger.info(`Assets    : ${config.dominanceAssets.join(', ').toUpperCase()}`);
logger.info(
    `Source    : Chainlink ${config.dominanceAssets
        .map((asset) => `${asset.toUpperCase()}=${config.dominanceChainlinkStreams[asset]}`)
        .join(' | ')}`,
);
logger.info(`Ref Move  : ${config.dominanceRefMoveBps}bps`);
logger.info(
    `Ref Bands : >= $${config.dominanceHighPriceCutoff} => ${config.dominanceHighPriceRefMoveBps}bps x${config.dominanceHighPriceSizeMultiplier.toFixed(2)} | ` +
    `>= $${config.dominanceExtremePriceCutoff} => ${config.dominanceExtremePriceRefMoveBps}bps x${config.dominanceExtremePriceSizeMultiplier.toFixed(2)}`,
);
logger.info(`Ref Exit  : ${config.dominanceRefInvalidationBps}bps / ${config.dominanceRefInvalidationConfirmMs}ms`);
logger.info(`Window    : ${config.dominanceLateEntryWindowSec}s -> ${config.dominanceMinTimeLeftSec}s left`);
logger.info(`Entry     : $${config.dominanceEntryCutoff} to $${config.dominanceMaxEntryPrice}`);
logger.info(
    `Exec      : spread <= $${config.dominanceMaxSpread} | ` +
    `top ask >= ${config.dominanceMinTopSize} | book <= ${config.dominanceMaxBookAgeMs}ms`,
);
logger.info(`Panic Flr : < $${config.dominanceStopLossCutoff}`);
logger.info(`TP        : > $${config.dominanceTPCutoff}`);
logger.info(`Time Cut  : ${config.dominanceTimeCutSec}s`);
logger.info(`Size      : $${config.dominanceTradeSize} per asset`);

startDominanceDetector(async (results, direction) => {
    try {
        await executeDominanceStrategy(results, direction);
    } catch (err) {
        logger.error(`Dominance strategy error: ${err.message}`);
    }
});
logger.success('Oracle-follow bot started — watching resolution-aligned late-round moves...');

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
    logger.warn('Trend Bot: shutting down...');
    stopDominanceDetector();
    stopPriceWatcher();
    setTimeout(() => {
        console.clear();
        process.exit(0);
    }, 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
