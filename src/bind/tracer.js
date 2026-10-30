// Builds trace records (doc/console.md, Trace record) and passes them to an injected sink.

/**
 * @typedef {'SOURCE'|'CHANGE'|'REALTIME'|'BIND'|'AUDIO'|'VISUAL'|'RELOAD'|'SAFETY'} Stage
 * @typedef {{ t: string, traceId: string | null, stage: Stage, component: string, event: string,
 *   level: 'info'|'warn'|'error', data: Record<string, unknown> }} TraceRecord
 */

/**
 * @param {(record: TraceRecord) => void} sink
 * @param {() => number} wallNow epoch milliseconds
 */
export function createTracer(sink, wallNow = Date.now) {
  /**
   * @param {Stage} stage @param {string} component @param {string} event
   * @param {Record<string, unknown>} data
   * @param {{ traceId?: string | null, level?: 'info'|'warn'|'error' }} [opts]
   */
  return function emit(stage, component, event, data, opts = {}) {
    sink({
      t: new Date(wallNow()).toISOString(),
      traceId: opts.traceId ?? null,
      stage,
      component,
      event,
      level: opts.level ?? 'info',
      data,
    });
  };
}
