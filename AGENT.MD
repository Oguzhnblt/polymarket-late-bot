# Repository Notes

This repository is now dominance-only.

## Entry Point

- [src/trend.js](/Users/oguz/Desktop/polymarket-terminal/src/trend.js)

## Core Modules

- [src/config/index.js](/Users/oguz/Desktop/polymarket-terminal/src/config/index.js)
- [src/services/client.js](/Users/oguz/Desktop/polymarket-terminal/src/services/client.js)
- [src/services/dominanceDetector.js](/Users/oguz/Desktop/polymarket-terminal/src/services/dominanceDetector.js)
- [src/services/dominanceExecutor.js](/Users/oguz/Desktop/polymarket-terminal/src/services/dominanceExecutor.js)
- [src/services/referencePriceFeed.js](/Users/oguz/Desktop/polymarket-terminal/src/services/referencePriceFeed.js)
- [src/services/marketChannel.js](/Users/oguz/Desktop/polymarket-terminal/src/services/marketChannel.js)
- [src/services/wsPriceWatcher.js](/Users/oguz/Desktop/polymarket-terminal/src/services/wsPriceWatcher.js)
- [src/services/redeemer.js](/Users/oguz/Desktop/polymarket-terminal/src/services/redeemer.js)
- [src/services/ctf.js](/Users/oguz/Desktop/polymarket-terminal/src/services/ctf.js)
- [src/utils/tui.js](/Users/oguz/Desktop/polymarket-terminal/src/utils/tui.js)
- [src/utils/logger.js](/Users/oguz/Desktop/polymarket-terminal/src/utils/logger.js)

## Strategy Summary

- Watches configured `DOMINANCE_ASSETS`
- Confirms late-round external reference move
- Requires resolution-source alignment
- Applies execution guards:
  - tick-size saturation lock
  - max spread
  - minimum top ask size
  - maximum book age
- Manages exits with:
  - oracle invalidation
  - panic floor
  - take profit
  - optional time cut
  - expiry settlement

## Scripts

```bash
npm start
npm run dev
npm run trend
npm run trend-sim
npm run trend-dev
```
