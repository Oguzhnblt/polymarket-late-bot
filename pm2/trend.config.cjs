/**
 * PM2 config — Dominance / Trend Bot
 *
 * Usage (from project root):
 *   pm2 start pm2/trend.config.cjs
 *   pm2 start pm2/trend.config.cjs --env sim
 */
const path = require('path');
const root = path.join(__dirname, '..');

module.exports = {
    apps: [
        {
            name: 'polymarket-trend',
            script: path.join(root, 'src/trend.js'),
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                DRY_RUN: 'false',
            },
            env_sim: {
                NODE_ENV: 'production',
                DRY_RUN: 'true',
            },
            out_file: path.join(root, 'logs/trend-out.log'),
            error_file: path.join(root, 'logs/trend-error.log'),
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            merge_logs: true,
            restart_delay: 5000,
            max_restarts: 10,
            min_uptime: '10s',
            max_memory_restart: '256M',
            stop_exit_codes: [0],
        },
    ],
};
