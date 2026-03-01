import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Wallet
  privateKey: process.env.PRIVATE_KEY,         // EOA private key (for signing only)
  proxyWallet: process.env.PROXY_WALLET_ADDRESS, // Polymarket proxy wallet (deposit USDC here)

  // Polymarket API (optional, auto-derived if empty)
  clobApiKey: process.env.CLOB_API_KEY || '',
  clobApiSecret: process.env.CLOB_API_SECRET || '',
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || '',

  // Polymarket endpoints
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost: 'https://data-api.polymarket.com',
  chainId: 137,

  // Polygon RPC
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',

  // Dry run
  dryRun: process.env.DRY_RUN === 'true',

  // ── Dominance (Trend) ───────────────────────────────────────────
  dominanceDuration: process.env.DOMINANCE_DURATION || '5m', // '5m' or '15m'
  dominanceAssets: (process.env.DOMINANCE_ASSETS || '')
                    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  dominanceRefSymbols: Object.fromEntries(
    String(process.env.DOMINANCE_REF_SYMBOLS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [asset, symbol] = entry.split(':').map((part) => part.trim().toLowerCase());
        return asset && symbol ? [asset, symbol] : null;
      })
      .filter(Boolean),
  ),
  dominanceChainlinkStreams: Object.fromEntries(
    String(process.env.DOMINANCE_CHAINLINK_STREAMS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [asset, stream] = entry.split(':').map((part) => part.trim().toLowerCase());
        return asset && stream ? [asset, stream] : null;
      })
      .filter(Boolean),
  ),
  dominanceLateEntryWindowSec: Number(process.env.DOMINANCE_LATE_ENTRY_WINDOW_SEC),
  dominanceMinTimeLeftSec: Number(process.env.DOMINANCE_MIN_TIME_LEFT_SEC),
  dominanceRefMoveBps: Number(process.env.DOMINANCE_REF_MOVE_BPS),
  dominanceRefConfirmMs: Number(process.env.DOMINANCE_REF_CONFIRM_MS),
  dominanceHighPriceCutoff: Number(process.env.DOMINANCE_HIGH_PRICE_CUTOFF),
  dominanceExtremePriceCutoff: Number(process.env.DOMINANCE_EXTREME_PRICE_CUTOFF),
  dominanceHighPriceRefMoveBps: Number(process.env.DOMINANCE_HIGH_PRICE_REF_MOVE_BPS),
  dominanceExtremePriceRefMoveBps: Number(process.env.DOMINANCE_EXTREME_PRICE_REF_MOVE_BPS),
  dominanceHighPriceSizeMultiplier: Number(process.env.DOMINANCE_HIGH_PRICE_SIZE_MULTIPLIER),
  dominanceExtremePriceSizeMultiplier: Number(process.env.DOMINANCE_EXTREME_PRICE_SIZE_MULTIPLIER),
  dominanceRefInvalidationBps: Number(process.env.DOMINANCE_REF_INVALIDATION_BPS),
  dominanceRefInvalidationConfirmMs: Number(process.env.DOMINANCE_REF_INVALIDATION_CONFIRM_MS),
  dominanceEntryCutoff: Number(process.env.DOMINANCE_ENTRY_CUTOFF),
  dominanceMaxEntryPrice: Number(process.env.DOMINANCE_MAX_ENTRY_PRICE),
  dominanceMaxSpread: Number(process.env.DOMINANCE_MAX_SPREAD),
  dominanceMinTopSize: Number(process.env.DOMINANCE_MIN_TOP_SIZE),
  dominanceMaxBookAgeMs: Number(process.env.DOMINANCE_MAX_BOOK_AGE_MS),
  dominanceStopLossCutoff: Number(process.env.DOMINANCE_STOP_LOSS_CUTOFF),
  dominanceTPCutoff: Number(process.env.DOMINANCE_TP_CUTOFF),
  dominanceTimeCutSec: Number(process.env.DOMINANCE_TIME_CUT_SEC),
  dominanceTradeSize: Number(process.env.DOMINANCE_TRADE_SIZE),
};

// Validation for Dominance bot
export function validateDominanceConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.dominanceAssets.length === 0)
    throw new Error('DOMINANCE_ASSETS is required in .env');
  if (!['5m', '15m'].includes(config.dominanceDuration))
    throw new Error('DOMINANCE_DURATION must be "5m" or "15m"');
  if (Object.keys(config.dominanceRefSymbols).length === 0)
    throw new Error('DOMINANCE_REF_SYMBOLS is required in .env');
  if (Object.keys(config.dominanceChainlinkStreams).length === 0)
    throw new Error('DOMINANCE_CHAINLINK_STREAMS is required in .env');
  if (!Number.isFinite(config.dominanceTradeSize))
    throw new Error('DOMINANCE_TRADE_SIZE is required in .env');
  if (config.dominanceTradeSize <= 0) throw new Error('DOMINANCE_TRADE_SIZE must be > 0');
  if (!Number.isFinite(config.dominanceLateEntryWindowSec))
    throw new Error('DOMINANCE_LATE_ENTRY_WINDOW_SEC is required in .env');
  if (!Number.isFinite(config.dominanceMinTimeLeftSec))
    throw new Error('DOMINANCE_MIN_TIME_LEFT_SEC is required in .env');
  if (!Number.isFinite(config.dominanceRefMoveBps))
    throw new Error('DOMINANCE_REF_MOVE_BPS is required in .env');
  if (!Number.isFinite(config.dominanceRefConfirmMs))
    throw new Error('DOMINANCE_REF_CONFIRM_MS is required in .env');
  if (!Number.isFinite(config.dominanceHighPriceCutoff))
    throw new Error('DOMINANCE_HIGH_PRICE_CUTOFF is required in .env');
  if (!Number.isFinite(config.dominanceExtremePriceCutoff))
    throw new Error('DOMINANCE_EXTREME_PRICE_CUTOFF is required in .env');
  if (!Number.isFinite(config.dominanceHighPriceRefMoveBps))
    throw new Error('DOMINANCE_HIGH_PRICE_REF_MOVE_BPS is required in .env');
  if (!Number.isFinite(config.dominanceExtremePriceRefMoveBps))
    throw new Error('DOMINANCE_EXTREME_PRICE_REF_MOVE_BPS is required in .env');
  if (!Number.isFinite(config.dominanceHighPriceSizeMultiplier))
    throw new Error('DOMINANCE_HIGH_PRICE_SIZE_MULTIPLIER is required in .env');
  if (!Number.isFinite(config.dominanceExtremePriceSizeMultiplier))
    throw new Error('DOMINANCE_EXTREME_PRICE_SIZE_MULTIPLIER is required in .env');
  if (!Number.isFinite(config.dominanceRefInvalidationBps))
    throw new Error('DOMINANCE_REF_INVALIDATION_BPS is required in .env');
  if (!Number.isFinite(config.dominanceRefInvalidationConfirmMs))
    throw new Error('DOMINANCE_REF_INVALIDATION_CONFIRM_MS is required in .env');
  if (!Number.isFinite(config.dominanceEntryCutoff))
    throw new Error('DOMINANCE_ENTRY_CUTOFF is required in .env');
  if (!Number.isFinite(config.dominanceMaxEntryPrice))
    throw new Error('DOMINANCE_MAX_ENTRY_PRICE is required in .env');
  if (!Number.isFinite(config.dominanceMaxSpread))
    throw new Error('DOMINANCE_MAX_SPREAD is required in .env');
  if (!Number.isFinite(config.dominanceMinTopSize))
    throw new Error('DOMINANCE_MIN_TOP_SIZE is required in .env');
  if (!Number.isFinite(config.dominanceMaxBookAgeMs))
    throw new Error('DOMINANCE_MAX_BOOK_AGE_MS is required in .env');
  if (!Number.isFinite(config.dominanceStopLossCutoff))
    throw new Error('DOMINANCE_STOP_LOSS_CUTOFF is required in .env');
  if (!Number.isFinite(config.dominanceTPCutoff))
    throw new Error('DOMINANCE_TP_CUTOFF is required in .env');
  if (!Number.isFinite(config.dominanceTimeCutSec))
    throw new Error('DOMINANCE_TIME_CUT_SEC is required in .env');
  if (config.dominanceStopLossCutoff < 0 || config.dominanceStopLossCutoff >= 1)
    throw new Error('DOMINANCE_STOP_LOSS_CUTOFF must be between 0 and 1, or 0 to disable');
  if (config.dominanceEntryCutoff <= 0 || config.dominanceEntryCutoff >= 1)
    throw new Error('DOMINANCE_ENTRY_CUTOFF must be between 0 and 1');
  if (config.dominanceMaxEntryPrice <= 0 || config.dominanceMaxEntryPrice >= 1)
    throw new Error('DOMINANCE_MAX_ENTRY_PRICE must be between 0 and 1');
  if (config.dominanceHighPriceCutoff <= 0 || config.dominanceHighPriceCutoff >= 1)
    throw new Error('DOMINANCE_HIGH_PRICE_CUTOFF must be between 0 and 1');
  if (config.dominanceExtremePriceCutoff <= 0 || config.dominanceExtremePriceCutoff >= 1)
    throw new Error('DOMINANCE_EXTREME_PRICE_CUTOFF must be between 0 and 1');
  if (config.dominanceMaxSpread <= 0 || config.dominanceMaxSpread >= 1)
    throw new Error('DOMINANCE_MAX_SPREAD must be between 0 and 1');
  if (config.dominanceMinTopSize <= 0)
    throw new Error('DOMINANCE_MIN_TOP_SIZE must be > 0');
  if (config.dominanceMaxBookAgeMs <= 0)
    throw new Error('DOMINANCE_MAX_BOOK_AGE_MS must be > 0');
  if (config.dominanceLateEntryWindowSec <= 0)
    throw new Error('DOMINANCE_LATE_ENTRY_WINDOW_SEC must be > 0');
  if (config.dominanceMinTimeLeftSec < 0)
    throw new Error('DOMINANCE_MIN_TIME_LEFT_SEC must be >= 0');
  if (config.dominanceRefMoveBps <= 0)
    throw new Error('DOMINANCE_REF_MOVE_BPS must be > 0');
  if (config.dominanceRefConfirmMs <= 0)
    throw new Error('DOMINANCE_REF_CONFIRM_MS must be > 0');
  if (config.dominanceHighPriceRefMoveBps < config.dominanceRefMoveBps)
    throw new Error('DOMINANCE_HIGH_PRICE_REF_MOVE_BPS must be >= DOMINANCE_REF_MOVE_BPS');
  if (config.dominanceExtremePriceRefMoveBps < config.dominanceHighPriceRefMoveBps)
    throw new Error('DOMINANCE_EXTREME_PRICE_REF_MOVE_BPS must be >= DOMINANCE_HIGH_PRICE_REF_MOVE_BPS');
  if (config.dominanceHighPriceSizeMultiplier <= 0 || config.dominanceHighPriceSizeMultiplier > 1)
    throw new Error('DOMINANCE_HIGH_PRICE_SIZE_MULTIPLIER must be between 0 and 1');
  if (config.dominanceExtremePriceSizeMultiplier <= 0 || config.dominanceExtremePriceSizeMultiplier > 1)
    throw new Error('DOMINANCE_EXTREME_PRICE_SIZE_MULTIPLIER must be between 0 and 1');
  if (config.dominanceRefInvalidationBps <= 0)
    throw new Error('DOMINANCE_REF_INVALIDATION_BPS must be > 0');
  if (config.dominanceRefInvalidationConfirmMs <= 0)
    throw new Error('DOMINANCE_REF_INVALIDATION_CONFIRM_MS must be > 0');
  if (config.dominanceTimeCutSec < 0)
    throw new Error('DOMINANCE_TIME_CUT_SEC must be >= 0');
  if (config.dominanceAssets.some((asset) => !config.dominanceRefSymbols[asset]))
    throw new Error('DOMINANCE_REF_SYMBOLS must include every asset in DOMINANCE_ASSETS');
  if (config.dominanceAssets.some((asset) => !config.dominanceChainlinkStreams[asset]))
    throw new Error('DOMINANCE_CHAINLINK_STREAMS must include every asset in DOMINANCE_ASSETS');
  if (config.dominanceMinTimeLeftSec >= config.dominanceLateEntryWindowSec)
    throw new Error('DOMINANCE_MIN_TIME_LEFT_SEC must be less than DOMINANCE_LATE_ENTRY_WINDOW_SEC');
  if (config.dominanceStopLossCutoff > 0 && config.dominanceStopLossCutoff >= config.dominanceEntryCutoff)
    throw new Error('DOMINANCE_STOP_LOSS_CUTOFF must be less than DOMINANCE_ENTRY_CUTOFF');
  if (config.dominanceHighPriceCutoff >= config.dominanceExtremePriceCutoff)
    throw new Error('DOMINANCE_HIGH_PRICE_CUTOFF must be less than DOMINANCE_EXTREME_PRICE_CUTOFF');
  if (config.dominanceMaxEntryPrice <= config.dominanceEntryCutoff)
    throw new Error('DOMINANCE_MAX_ENTRY_PRICE must be greater than DOMINANCE_ENTRY_CUTOFF');
  if (config.dominanceTPCutoff <= config.dominanceEntryCutoff)
    throw new Error('DOMINANCE_TP_CUTOFF must be greater than DOMINANCE_ENTRY_CUTOFF');
}

export default config;
