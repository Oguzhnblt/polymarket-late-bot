# Polymarket Late Bot

Short-duration trend bot for Polymarket `Up or Down` markets.

The project now contains a single strategy:
- `dominance / trend`

It watches configured assets, follows a late-round external reference move, filters bad entries with market microstructure guards, opens one-sided positions, and holds them through expiry unless invalidated earlier.

## What It Does

- Trades only configured dominance assets
- Uses Binance spot as the live reference feed
- Verifies the market's declared Chainlink resolution source before entering
- Filters entries with:
  - reference confirmation
  - max entry price
  - tick-size saturation lock
  - top-of-book spread guard
  - top-of-book size guard
  - stale-book guard
- Exits with:
  - oracle invalidation
  - panic floor
  - take profit
  - expiry settlement / redeem

## Scripts

```bash
npm start        # live trend bot
npm run dev      # dry-run with nodemon
npm run trend    # live trend bot
npm run trend-sim
npm run trend-dev
```

## Required Env

Fill `.env` from `.env.example`.

Core wallet / network:

```env
PRIVATE_KEY=
PROXY_WALLET_ADDRESS=
POLYGON_RPC_URL=
DRY_RUN=true
```

Trend bot:

```env
DOMINANCE_DURATION=5m
DOMINANCE_ASSETS=btc,eth,sol
DOMINANCE_REF_SYMBOLS=btc:btcusdt,eth:ethusdt,sol:solusdt
DOMINANCE_CHAINLINK_STREAMS=btc:btc-usd,eth:eth-usd,sol:sol-usd

DOMINANCE_LATE_ENTRY_WINDOW_SEC=60
DOMINANCE_MIN_TIME_LEFT_SEC=12
DOMINANCE_REF_MOVE_BPS=8
DOMINANCE_REF_CONFIRM_MS=2000
DOMINANCE_REF_INVALIDATION_BPS=6
DOMINANCE_REF_INVALIDATION_CONFIRM_MS=2000

DOMINANCE_ENTRY_CUTOFF=0.80
DOMINANCE_MAX_ENTRY_PRICE=0.98
DOMINANCE_MAX_SPREAD=0.03
DOMINANCE_MIN_TOP_SIZE=25
DOMINANCE_MAX_BOOK_AGE_MS=1500

DOMINANCE_STOP_LOSS_CUTOFF=0.15
DOMINANCE_TP_CUTOFF=1.00
DOMINANCE_TIME_CUT_SEC=0
DOMINANCE_TRADE_SIZE=50
```

## Runtime Layout

- `src/trend.js`: entry point
- `src/services/dominanceDetector.js`: market discovery + signal generation
- `src/services/dominanceExecutor.js`: entry, monitoring, exits, settlement
- `src/services/referencePriceFeed.js`: Binance reference feed
- `src/services/marketChannel.js`: Polymarket market websocket
- `src/utils/tui.js`: terminal UI

## PM2

```bash
pm2 start pm2/trend.config.cjs
pm2 start pm2/trend.config.cjs --env sim
```
