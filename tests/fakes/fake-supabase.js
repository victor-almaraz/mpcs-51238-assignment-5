// In-memory Supabase client for sky store tests: REST query builder and Realtime channels.

/**
 * @param {{ tables?: Record<string, object[]>, autoSubscribe?: boolean }} [opts]
 */
export function createFakeSupabase({ tables = {}, autoSubscribe = true } = {}) {
  /** @type {Record<string, object[]>} */
  const db = { sky_objects: [], source_status: [], changes: [], ...structuredClone(tables) };
  /** @type {FakeChannel[]} */
  const channels = [];
  /** @type {Map<string, { message: string }[]>} */
  const failures = new Map();
  /** @type {Map<string, Promise<void>>} */
  const holds = new Map();
  /** @type {{ table: string, ops: any[] }[]} */
  const queries = [];
  let setAuthCalls = 0;

  class Query {
    /** @param {string} table */
    constructor(table) {
      this.table = table;
      /** @type {any[]} */
      this.ops = [];
      this.cols = '*';
      /** @type {[number, number] | null} */
      this.rng = null;
    }
    /** @param {string} cols */
    select(cols = '*') { this.cols = cols; return this; }
    /** @param {string} c @param {unknown[]} v */
    in(c, v) { this.ops.push(['in', c, v]); return this; }
    /** @param {string} c @param {null} v */
    is(c, v) { this.ops.push(['is', c, v]); return this; }
    /** @param {string} c @param {unknown} v */
    eq(c, v) { this.ops.push(['eq', c, v]); return this; }
    /** @param {string} c @param {unknown} v */
    gte(c, v) { this.ops.push(['gte', c, v]); return this; }
    /** @param {string} c @param {unknown} v */
    lt(c, v) { this.ops.push(['lt', c, v]); return this; }
    /** @param {string} c @param {{ ascending?: boolean }} [o] */
    order(c, o = {}) { this.ops.push(['order', c, o.ascending !== false]); return this; }
    /** @param {number} a @param {number} b */
    range(a, b) { this.rng = [a, b]; return this; }
    async run() {
      queries.push({ table: this.table, ops: this.ops, range: this.rng });
      const hold = holds.get(this.table);
      if (hold) await hold;
      const f = failures.get(this.table);
      if (f && f.length) return { data: null, error: f.shift() };
      let rows = (db[this.table] ?? []).map((r) => structuredClone(r));
      /** @type {[string, boolean][]} */
      const orders = [];
      for (const [op, c, v] of this.ops) {
        if (op === 'in') rows = rows.filter((r) => v.includes(r[c]));
        else if (op === 'is') rows = rows.filter((r) => (r[c] ?? null) === v);
        else if (op === 'eq') rows = rows.filter((r) => r[c] === v);
        else if (op === 'gte') rows = rows.filter((r) => cmp(r[c], v) >= 0);
        else if (op === 'lt') rows = rows.filter((r) => cmp(r[c], v) < 0);
        else if (op === 'order') orders.push([c, v]);
      }
      rows.sort((a, b) => {
        for (const [c, asc] of orders) {
          const d = cmp(a[c], b[c]);
          if (d) return asc ? d : -d;
        }
        return 0;
      });
      if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
      if (this.cols !== '*') {
        const keep = this.cols.split(',').map((s) => s.trim());
        rows = rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k]])));
      }
      return { data: rows, error: null };
    }
    /** @param {(v: any) => any} res @param {(e: any) => any} rej */
    then(res, rej) {
      return this.run().then(res, rej);
    }
  }

  class FakeChannel {
    /** @param {string} name */
    constructor(name) {
      this.name = name;
      /** @type {any} */
      this.filter = null;
      /** @type {((p: any) => void) | null} */
      this.handler = null;
      /** @type {((s: string, e?: any) => void) | null} */
      this.statusCb = null;
      this.removed = false;
    }
    /** @param {string} type @param {any} filter @param {(p: any) => void} cb */
    on(type, filter, cb) {
      if (type !== 'postgres_changes') throw new Error(`fake channel supports postgres_changes only, got ${type}`);
      this.filter = filter;
      this.handler = cb;
      return this;
    }
    /** @param {(s: string, e?: any) => void} cb */
    subscribe(cb) {
      this.statusCb = cb;
      if (autoSubscribe) queueMicrotask(() => { if (!this.removed) cb('SUBSCRIBED'); });
      return this;
    }
    /** @param {string} s @param {any} [err] */
    status(s, err) {
      this.statusCb?.(s, err);
    }
    /** Delivers a payload if the channel's group filter matches. @param {any} payload */
    deliver(payload) {
      if (this.removed || !this.handler) return false;
      const m = /^group_key=in\.\((.*)\)$/.exec(this.filter?.filter ?? '');
      const group = payload.new?.group_key ?? payload.old?.group_key;
      if (m && group !== undefined && !m[1].split(',').includes(group)) return false;
      this.handler(payload);
      return true;
    }
  }

  const client = {
    /** @param {string} table */
    from(table) {
      return new Query(table);
    },
    /**
     * Like realtime-js 2.x: a channel stays registered under its topic until its removal has been
     * acknowledged, and channel() returns that registered channel, even while it is leaving.
     * @param {string} name
     */
    channel(name) {
      const registered = channels.find((c) => c.name === name && !c.unregistered);
      if (registered) return registered;
      const ch = new FakeChannel(name);
      channels.push(ch);
      return ch;
    },
    /** @param {FakeChannel} ch */
    async removeChannel(ch) {
      if (ch.removed) return 'ok';
      ch.removed = true;
      ch.statusCb?.('CLOSED');
      await Promise.resolve(); // the server's leave acknowledgement
      ch.unregistered = true;
      return 'ok';
    },
    realtime: {
      async setAuth() {
        setAuthCalls++;
      },
    },
  };

  return {
    client,
    db,
    channels,
    queries,
    /** Live channel (last created and not removed). */
    live() {
      for (let i = channels.length - 1; i >= 0; i--) if (!channels[i].removed) return channels[i];
      return null;
    },
    /** Makes the next query on a table fail. @param {string} table @param {string} message */
    failNext(table, message) {
      if (!failures.has(table)) failures.set(table, []);
      /** @type {any[]} */ (failures.get(table)).push({ message });
    },
    /** Holds queries on a table until the returned function is called. @param {string} table */
    hold(table) {
      /** @type {() => void} */
      let release = () => {};
      holds.set(table, new Promise((r) => { release = r; }));
      return () => {
        holds.delete(table);
        release();
      };
    },
    setAuthCalls: () => setAuthCalls,
  };
}

/** @param {any} a @param {any} b */
function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    const da = Date.parse(a);
    const dbb = Date.parse(b);
    if (Number.isFinite(da) && Number.isFinite(dbb) && /^\d{4}-/.test(a) && /^\d{4}-/.test(b)) return da - dbb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A sky_objects row.
 * @param {string} group @param {string} key @param {Record<string, any>} fields
 * @param {{ traceId?: string, updatedAt?: string, removedAt?: string | null, source?: string }} [o]
 */
export function skyRow(group, key, fields, o = {}) {
  return {
    id: `${group}:${key}`,
    source: o.source ?? group,
    group_key: group,
    fields,
    hash: 'h',
    trace_id: o.traceId ?? `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    updated_at: o.updatedAt ?? '2026-10-29T12:00:00.000Z',
    removed_at: o.removedAt ?? null,
  };
}

/**
 * A Realtime postgres_changes payload.
 * @param {any} row @param {{ eventType?: string, commit?: string }} [o]
 */
export function payload(row, o = {}) {
  return {
    schema: 'public',
    table: 'sky_objects',
    commit_timestamp: o.commit ?? row.updated_at,
    eventType: o.eventType ?? 'UPDATE',
    new: o.eventType === 'DELETE' ? {} : row,
    old: { id: row.id },
    errors: null,
  };
}
