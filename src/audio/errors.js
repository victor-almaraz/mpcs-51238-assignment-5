// Errors thrown by the engine's effect and modulation APIs (effects.md, Limits; modulation.md,
// Limits and Engine API). `limit` and `target` name what was rejected.

export class FxLimitError extends Error {
  /** @param {string} limit */
  constructor(limit, detail = '') {
    super(`Effect limit exceeded: ${limit}${detail ? ` (${detail})` : ''}`);
    this.name = 'FxLimitError';
    this.limit = limit;
  }
}

export class ModLimitError extends Error {
  /** @param {string} limit */
  constructor(limit, detail = '') {
    super(`Modulation limit exceeded: ${limit}${detail ? ` (${detail})` : ''}`);
    this.name = 'ModLimitError';
    this.limit = limit;
  }
}

export class ModTargetError extends Error {
  /** @param {string} target */
  constructor(target, reason = 'not a modulatable parameter') {
    super(`Invalid modulation target: ${target}: ${reason}`);
    this.name = 'ModTargetError';
    this.target = target;
  }
}
