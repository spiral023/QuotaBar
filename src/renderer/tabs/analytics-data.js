/* global QB */
'use strict';

/** Bounded, generation-aware requests shared by prefetch and the active view. */
QB.createAnalyticsData = function createAnalyticsData(limit = 32) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid analytics cache capacity');
  /** @type {Map<string, Promise<import('../../main/analyticsSummary').AnalyticsData | import('../../shared/rendererIpc').PortableDataPreparing | undefined>>} */
  const entries = new Map();
  let generation = 0;
  /** @param {import('../../shared/rendererIpc').AnalyticsQuery} query */
  const keyOf = (query) => JSON.stringify([query.since, query.until, query.timeZone]);
  return {
    has: (query) => entries.has(keyOf(query)),
    clear() { generation++; entries.clear(); },
    load(query) {
      const key = keyOf(query);
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key); entries.set(key, existing);
        return existing;
      }
      const epoch = generation;
      const pending = QB.ipc.invoke('analytics:get', query).then((data) => {
        if (epoch !== generation) return undefined;
        if (QB.isPortableDataPreparing(data) && entries.get(key) === pending) entries.delete(key);
        return data;
      }, (error) => {
        if (entries.get(key) === pending) entries.delete(key);
        if (epoch !== generation) return undefined;
        throw error;
      });
      entries.set(key, pending);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return pending;
    },
  };
};
