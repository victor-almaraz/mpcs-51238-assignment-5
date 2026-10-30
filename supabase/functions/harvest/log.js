const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(name) {
  return Object.hasOwn(LEVELS, name);
}

/**
 * JSON-lines logger. `write` receives one line without the newline.
 * @param {{ level?: string, write?: (line: string) => void, now?: () => Date }} [opts]
 */
export function createLogger({ level = 'warn', write = (line) => console.error(line), now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.warn;
  const emit = (lvl, fields) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ t: now().toISOString(), level: lvl, ...fields }));
  };
  return {
    debug: (f) => emit('debug', f),
    info: (f) => emit('info', f),
    warn: (f) => emit('warn', f),
    error: (f) => emit('error', f),
  };
}
