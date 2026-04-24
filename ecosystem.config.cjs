// PM2 ecosystem — production process manifest for the nft-live-feed VPS.
//
// Two apps, one host:
//   - nft-backend   (Express + ingestion + control plane, bound to 127.0.0.1:3000)
//   - nft-frontend  (Next.js production server, bound to 127.0.0.1:3001)
//
// Both are fronted by nginx on :443. See docs/DEPLOY.md for the full plan.
//
// Secrets come from `.env` (backend) and `frontend/.env.production`
// (frontend). Neither is referenced here. The `env` keys below set only
// NODE_ENV so `process.env.NODE_ENV === 'production'` is true from the
// very first line — this flips on validateEnv() hard-fail mode, production
// CORS rules, and the no-fallback auth signing secret.
//
// `max_memory_restart` is a tripwire, not a tuning knob; if either app
// blows past the ceiling PM2 restarts it and the lock module handles the
// handoff. `kill_timeout: 10000` gives applyTransition('off') 10s to
// drain in-flight Helius calls before PM2 SIGKILLs the old process.
//
// Adjust `cwd` if you deploy under a different service-user home.

const HOME = '/home/nftfeed/nft-live-feed';

module.exports = {
  apps: [
    {
      name:               'nft-backend',
      cwd:                HOME,
      script:             'node_modules/.bin/ts-node',
      args:               'src/index.ts',
      env:                { NODE_ENV: 'production' },
      instances:          1,            // single-instance lock refuses a 2nd anyway
      exec_mode:          'fork',
      max_memory_restart: '800M',
      kill_timeout:       10000,        // 10s for graceful ingestion teardown
      out_file:           '/home/nftfeed/logs/backend.out.log',
      error_file:         '/home/nftfeed/logs/backend.err.log',
      merge_logs:         true,
      time:               true,
    },
    {
      name:               'nft-frontend',
      cwd:                `${HOME}/frontend`,
      script:             'node_modules/.bin/next',
      args:               'start -p 3001',
      env:                { NODE_ENV: 'production' },
      instances:          1,
      exec_mode:          'fork',
      max_memory_restart: '600M',
      out_file:           '/home/nftfeed/logs/frontend.out.log',
      error_file:         '/home/nftfeed/logs/frontend.err.log',
      merge_logs:         true,
      time:               true,
    },
  ],
};
