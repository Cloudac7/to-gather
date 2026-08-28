import { mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const astroBin = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url));
const logDirectory = fileURLToPath(new URL('../.wrangler/logs/', import.meta.url));
const logPath = fileURLToPath(new URL('../.wrangler/logs/dev-setup.log', import.meta.url));

mkdirSync(logDirectory, { recursive: true });

console.log('Preparing local D1 database...');
const migration = spawnSync(
  process.execPath,
  [wranglerBin, 'd1', 'migrations', 'apply', 'to-gather', '--local'],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: '1',
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? logPath,
    },
  },
);

if (migration.error) {
  console.error(`Unable to prepare the local database: ${migration.error.message}`);
  process.exit(1);
}

if (migration.status !== 0) {
  console.error('Local database migration failed. The development server was not started.');
  process.exit(migration.status ?? 1);
}

console.log('Local database ready. Starting Astro...');
const astro = spawn(process.execPath, [astroBin, 'dev', ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? logPath,
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => astro.kill(signal));
}

astro.on('error', (error) => {
  console.error(`Unable to start Astro: ${error.message}`);
  process.exit(1);
});

astro.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
