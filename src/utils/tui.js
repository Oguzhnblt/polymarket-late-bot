import blessed from 'blessed';
import config from '../config/index.js';
import { getStats, getActiveDominancePositions } from '../services/dominanceExecutor.js';
import { getMarketPrices } from '../services/dominanceDetector.js';

let screen;
let headerBox;
let summaryBox;
let cardsWrapper;
let cardsGrid;
let activityLog;
let assetCards = [];

// ── Theme ──────────────────────────────────────────────────────────
const CARD_BORDERS = ['cyan', 'green', 'yellow', 'magenta'];
const SEP = '{gray-fg}│{/gray-fg}';
const DOT_OK = '{green-fg}●{/green-fg}';
const DOT_WARN = '{yellow-fg}●{/yellow-fg}';
const DOT_ERR = '{red-fg}●{/red-fg}';
const DOT_OFF = '{gray-fg}○{/gray-fg}';

// ── Layout constants ───────────────────────────────────────────────
const HEADER_HEIGHT = 3;
const SUMMARY_HEIGHT = 5;
const SECTION_GAP = 1;
const MIN_CARD_WIDTH = 46;
const CARD_HEIGHT = 16;
const MIN_ACTIVITY_HEIGHT = 8;

// ── Card internal row offsets (inside border, 0-based) ─────────────
//  0  HEADER        BTC  ▲ UP  ⏱ 4m 32s
//  1  ────────────────────────────────────
//  2  ┌─ UP ──────┐ ┌─ DOWN ─────┐
//  3  │  $0.571    │ │  $0.429    │
//  4  └────────────┘ └────────────┘
//  5  ────────────────────────────────────
//  6  SRC  ● ok   binance → binance
//  7  REF  +12.3bps  ●
//  8  EXEC ● ok   tick-ok
//  9  BOOK spr $0.012  ask 340  age 82ms
// 10  ────────────────────────────────────
// 11  POS  YES 14.20 @ $0.541
// 12  PNL  +$1.23 live
// ─────────────────────────────────────────

// ── Helpers ────────────────────────────────────────────────────────

function getSlotClock() {
    const slotSec = config.dominanceDuration === '15m' ? 900 : 300;
    const now = Math.floor(Date.now() / 1000);
    const remaining = ((Math.floor(now / slotSec) + 1) * slotSec) - now;
    return { mins: Math.floor(remaining / 60), secs: remaining % 60 };
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function fmtMoney(value, { sign = false } = {}) {
    const abs = Math.abs(value).toFixed(2);
    const prefix = sign ? (value >= 0 ? '+' : '-') : (value < 0 ? '-' : '');
    const tag = value >= 0 ? 'green-fg' : 'red-fg';
    return `{${tag}}${prefix}$${abs}{/${tag}}`;
}

function fmtPrice(v) {
    return v ? `$${v.toFixed(3)}` : '$—';
}

function fmtTime(secs) {
    return `${Math.floor(secs / 60)}m ${pad2(secs % 60)}s`;
}

function truncate(value, max) {
    const t = String(value || '');
    return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

function dirPill(dir) {
    if (dir === 'YES') return '{black-fg}{green-bg} ▲ UP {/}';
    if (dir === 'NO') return '{white-fg}{red-bg} ▼ DN {/}';
    return '{black-fg}{yellow-bg}  —  {/}';
}

function hRule(w) {
    return `{gray-fg}${'─'.repeat(w)}{/gray-fg}`;
}

// ── Header ─────────────────────────────────────────────────────────

function buildHeader() {
    const { mins, secs } = getSlotClock();
    const mode = config.dryRun
        ? '{black-fg}{yellow-bg} ◆ SIM {/}'
        : '{white-fg}{red-bg} ◆ LIVE {/}';
    const assets = config.dominanceAssets.map((a) => a.toUpperCase()).join('  ');

    headerBox.setContent(
        ` {bold}Polymarket Oracle-Follow Board{/bold}  ${mode}` +
        `  ${SEP}  ⏱  {bold}${mins}m ${pad2(secs)}s{/bold}` +
        `  ${SEP}  ${assets}`,
    );
}

// ── Summary ────────────────────────────────────────────────────────

function buildSummary() {
    const s = getStats();
    const last = s.trades?.length > 0 ? s.trades[s.trades.length - 1] : null;
    const bal = typeof s.balance === 'number' ? `${s.balance.toFixed(2)}` : s.balance;
    const latestText = last
        ? `${last.asset.toUpperCase()} ${last.type}  ${fmtMoney(last.pnl, { sign: true })}`
        : '{gray-fg}none{/gray-fg}';
    const kv = (l, v) => `{gray-fg}${l}{/gray-fg} {bold}${v}{/bold}`;

    const line1 = [
        kv('BAL', bal), kv('OPEN', s.activeCount),
        kv('TRADES', s.totalTrades),
        `{gray-fg}PNL{/gray-fg} ${fmtMoney(s.totalPnl, { sign: true })}`,
        `{gray-fg}Latest ▸{/gray-fg} ${latestText}`,
    ].join(`  ${SEP}  `);

    const line2 = [
        kv('Ref', `${config.dominanceRefMoveBps}bps`),
        kv('Exit', `${config.dominanceRefInvalidationBps}bps`),
        kv('Win', `${config.dominanceLateEntryWindowSec}–${config.dominanceMinTimeLeftSec}s`),
        kv('Entry', `${config.dominanceEntryCutoff}–${config.dominanceMaxEntryPrice}`),
    ].join('  ');

    const line3 = [
        kv('Spr', `≤${config.dominanceMaxSpread}`),
        kv('Ask', `≥${config.dominanceMinTopSize}`),
        kv('Age', `≤${config.dominanceMaxBookAgeMs}ms`),
        kv('SL', `${config.dominanceStopLossCutoff}`),
        kv('TP', `${config.dominanceTPCutoff}`),
        kv('TC', `${config.dominanceTimeCutSec}s`),
    ].join('  ');

    summaryBox.setContent(` ${line1}\n ${line2}\n ${line3}`);
}

// ── Card content builder ───────────────────────────────────────────

function buildCardContent(asset, marketMap, positionsMap, innerW) {
    const m = marketMap.get(asset);
    const pos = positionsMap.get(asset);
    const match = Boolean(pos && m && pos.conditionId === m.conditionId);
    const yesP = m?.yesPrice || 0;
    const noP = m?.noPrice || (yesP > 0 ? Math.max(0, 1 - yesP) : 0);
    const dir = m?.direction || 'NEUTRAL';

    // ── Row 0: Header ──
    let timeBadge = '{gray-fg}—{/gray-fg}';
    if (m?.endTime) {
        const secs = Math.max(0, Math.round((new Date(m.endTime).getTime() - Date.now()) / 1000));
        timeBadge = `⏱ ${fmtTime(secs)}`;
    }
    const headerLine = ` {bold}${asset.toUpperCase()}{/bold}  ${dirPill(dir)}  ${timeBadge}`;

    // ── Row 1: Separator ──
    const sep = ` ${hRule(innerW - 2)}`;

    // ── Row 2-4: Price boxes (text-art style, no nested borders) ──
    const half = Math.max(8, Math.floor((innerW - 3) / 2));
    const yesText = yesP ? yesP.toFixed(3) : '—';
    const noText = noP ? noP.toFixed(3) : '—';

    const upLabel = '▲ UP'.padStart(Math.floor((half + 4) / 2)).padEnd(half);
    const dnLabel = '▼ DN'.padStart(Math.floor((half + 4) / 2)).padEnd(half);
    const upPrice = `$${yesText}`.padStart(Math.floor((half + yesText.length + 1) / 2)).padEnd(half);
    const dnPrice = `$${noText}`.padStart(Math.floor((half + noText.length + 1) / 2)).padEnd(half);

    const priceLine1 = ` {green-fg}${upLabel}{/green-fg} {red-fg}${dnLabel}{/red-fg}`;
    const priceLine2 = ` {green-fg}{bold}${upPrice}{/bold}{/green-fg} {red-fg}{bold}${dnPrice}{/bold}{/red-fg}`;

    // ── Row 6-9: Metrics ──
    const srcLine = m?.expectedResolutionStream
        ? ` {gray-fg}SRC {/gray-fg} ${m.sourceAligned ? DOT_OK : DOT_ERR}  ${truncate(`${m.resolutionStream || '?'} → ${m.expectedResolutionStream}`, Math.max(12, innerW - 14))}`
        : ` {gray-fg}SRC {/gray-fg} ${DOT_OFF} n/a`;

    const refLine = m?.refOpenPrice > 0
        ? ` {gray-fg}REF {/gray-fg} ${m.refDeltaBps >= 0 ? '{green-fg}+' : '{red-fg}'}${m.refDeltaBps.toFixed(1)}bps{/${m.refDeltaBps >= 0 ? 'green-fg' : 'red-fg'}}  ${m.refConfirmed ? DOT_OK : DOT_WARN}`
        : ` {gray-fg}REF {/gray-fg} ${DOT_OFF} pending`;

    const tickLock = dir === 'NO' ? m?.noTickSizeChanged : m?.yesTickSizeChanged;
    const execLine =
        ` {gray-fg}EXEC{/gray-fg} ${m?.executionOk !== false ? DOT_OK : DOT_ERR}  ${tickLock ? `${DOT_ERR} {red-fg}tick-lock{/red-fg}` : `${DOT_OK} tick-ok`}`;

    const spread = dir === 'NO' ? m?.noSpread : m?.yesSpread;
    const topSize = dir === 'NO' ? m?.noTopSize : m?.yesTopSize;
    const bookAge = dir === 'NO' ? m?.noBookAgeMs : m?.yesBookAgeMs;
    const bookLine =
        ` {gray-fg}BOOK{/gray-fg} spr ${spread ? `$${spread.toFixed(3)}` : '—'}  ask ${topSize ? topSize.toFixed(0) : '—'}  age ${bookAge ?? '—'}ms`;

    // ── Row 11-12: Position & PnL ──
    let posLine, pnlLine;
    if (!pos) {
        posLine = ` {gray-fg}POS {/gray-fg} ${DOT_OFF} flat`;
        pnlLine = ` {gray-fg}PNL {/gray-fg} —`;
    } else {
        const posText = `${pos.direction} ${pos.shares.toFixed(2)} @ ${fmtPrice(pos.entryPrice)}`;
        if (pos.resolving || !match) {
            posLine = ` {gray-fg}POS {/gray-fg} ${DOT_WARN} {yellow-fg}${truncate(posText, innerW - 12)}{/yellow-fg}`;
            pnlLine = ` {gray-fg}PNL {/gray-fg} {gray-fg}resolving…{/gray-fg}`;
        } else {
            posLine = ` {gray-fg}POS {/gray-fg} {white-fg}${truncate(posText, innerW - 8)}{/white-fg}`;
            const cur = pos.direction === 'YES' ? yesP : noP;
            pnlLine = cur > 0
                ? ` {gray-fg}PNL {/gray-fg} ${fmtMoney((cur - pos.entryPrice) * pos.shares, { sign: true })} {gray-fg}live{/gray-fg}`
                : ` {gray-fg}PNL {/gray-fg} —`;
        }
    }

    // ── Assemble all rows ──
    return [
        headerLine,       // 0
        sep,              // 1
        priceLine1,       // 2
        priceLine2,       // 3
        '',               // 4  spacer
        sep,              // 5
        srcLine,          // 6
        refLine,          // 7
        execLine,         // 8
        bookLine,         // 9
        sep,              // 10
        posLine,          // 11
        pnlLine,          // 12
    ].join('\n');
}

// ── Layout engine ──────────────────────────────────────────────────

function getCardLayoutMetrics() {
    const usableWidth = Math.max(40, screen.width - 4);
    const columns = Math.max(
        1,
        Math.min(config.dominanceAssets.length, Math.floor((usableWidth + 1) / (MIN_CARD_WIDTH + 1))),
    );
    const rows = Math.ceil(config.dominanceAssets.length / columns);
    const totalHeight = (rows * CARD_HEIGHT) + (Math.max(0, rows - 1));
    return { columns, rows, totalHeight };
}

function relayoutShell() {
    if (!screen) return;
    const cardsTop = HEADER_HEIGHT + SUMMARY_HEIGHT + SECTION_GAP;
    const layout = getCardLayoutMetrics();
    const available = Math.max(22, screen.height - cardsTop);
    const maxCards = Math.max(CARD_HEIGHT, available - MIN_ACTIVITY_HEIGHT - SECTION_GAP);
    const cardsH = Math.min(layout.totalHeight, maxCards);
    const actTop = cardsTop + cardsH + SECTION_GAP;

    headerBox.top = 0;
    headerBox.height = HEADER_HEIGHT;
    summaryBox.top = HEADER_HEIGHT;
    summaryBox.height = SUMMARY_HEIGHT;
    cardsWrapper.top = cardsTop;
    cardsWrapper.height = cardsH;
    activityLog.top = actTop;
    activityLog.height = Math.max(MIN_ACTIVITY_HEIGHT, screen.height - actTop);
}

function layoutCards() {
    if (!cardsGrid || !screen) return;

    assetCards.forEach(({ box }) => { cardsGrid.remove(box); box.destroy(); });
    assetCards = [];

    const gridW = Math.max(20, (typeof cardsGrid.width === 'number' ? cardsGrid.width : screen.width - 6) - 1);
    const { columns } = getCardLayoutMetrics();
    const usableW = Math.max(20, gridW - (columns - 1));
    const cardW = Math.max(MIN_CARD_WIDTH, Math.floor(usableW / columns));

    config.dominanceAssets.forEach((asset, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        const left = col * (cardW + 1);
        const top = row * (CARD_HEIGHT + 1);
        const width = col === columns - 1 ? Math.max(cardW, gridW - left) : cardW;

        const box = blessed.box({
            parent: cardsGrid,
            top, left, width, height: CARD_HEIGHT,
            tags: true,
            border: { type: 'line' },
            style: { border: { fg: CARD_BORDERS[i % CARD_BORDERS.length] } },
        });

        // Single content box fills the entire card interior
        const content = blessed.box({
            parent: box,
            top: 0, left: 1,
            width: Math.max(10, width - 4),
            height: CARD_HEIGHT - 2,
            tags: true,
        });

        assetCards.push({ asset, box, content, width });
    });
}

// ── Card update ────────────────────────────────────────────────────

function updateCards() {
    const marketMap = new Map(getMarketPrices().map((m) => [m.asset, m]));
    const posMap = new Map(getActiveDominancePositions().map((p) => [p.asset, p]));

    assetCards.forEach(({ asset, content, width }) => {
        const innerW = Math.max(10, width - 4);
        content.setContent(buildCardContent(asset, marketMap, posMap, innerW));
    });
}

// ── Render loop ────────────────────────────────────────────────────

function updateTUI() {
    if (!screen) return;
    try {
        buildHeader();
        buildSummary();
        updateCards();
        screen.render();
    } catch {
        // Ignore transient render issues
    }
}

// ── Init ───────────────────────────────────────────────────────────

export function initTUI() {
    screen = blessed.screen({
        smartCSR: true,
        title: 'Polymarket Oracle-Follow Board',
        forceUnicode: true,
        fullUnicode: true,
    });

    headerBox = blessed.box({
        top: 0, left: 0, width: '100%', height: HEADER_HEIGHT,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'white' } },
    });

    summaryBox = blessed.box({
        top: HEADER_HEIGHT, left: 0, width: '100%', height: SUMMARY_HEIGHT,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'blue' } },
    });

    cardsWrapper = blessed.box({
        top: HEADER_HEIGHT + SUMMARY_HEIGHT + SECTION_GAP,
        left: 0, width: '100%', height: CARD_HEIGHT,
        tags: true,
    });

    cardsGrid = blessed.box({
        parent: cardsWrapper,
        top: 0, left: 0, width: '100%', height: '100%',
    });

    activityLog = blessed.log({
        top: 26, left: 0, width: '100%', height: 10,
        label: ' ◆ Activity ',
        padding: { left: 1, right: 1 },
        border: { type: 'line' },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: '▐', inverse: true },
        tags: true,
        style: { border: { fg: 'white' }, scrollbar: { bg: 'cyan' } },
    });

    screen.append(headerBox);
    screen.append(summaryBox);
    screen.append(cardsWrapper);
    screen.append(activityLog);

    relayoutShell();
    layoutCards();

    screen.on('resize', () => {
        relayoutShell();
        layoutCards();
        updateTUI();
    });

    screen.key(['q', 'C-c'], () => process.exit(0));

    setInterval(updateTUI, 200);
    updateTUI();
}

export function logToTUI(msg) {
    if (!activityLog) return;
    if (/\bINFO\b/.test(msg)) return;
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    activityLog.log(`{gray-fg}${ts}{/gray-fg}  ${msg}`);
    screen.render();
}
