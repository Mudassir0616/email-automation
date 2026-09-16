/**
 * Tiny console logger with timestamps and levels.
 *
 * Deliberately dependency-free. When you later want a send log you can grep
 * (chunk 6: reply/status tracking), swap the `write` function here for one
 * that also appends JSON lines to a file — nothing else has to change.
 */

const COLORS = {
  info: '\x1b[36m', // cyan
  ok: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function write(level, message, meta) {
  const stamp = new Date().toISOString();
  const color = COLORS[level] ?? '';
  const label = level.toUpperCase().padEnd(5);
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `${color}[${stamp}] ${label}${COLORS.reset} ${message}${suffix}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message, meta) => write('info', message, meta),
  ok: (message, meta) => write('ok', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
