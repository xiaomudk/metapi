export type SnapshotCacheStatus =
  | "disabled"
  | "miss"
  | "hit"
  | "stale"
  | "refresh";

export type SnapshotEnvelope<T> = {
  payload: T;
  generatedAt: string;
  cacheStatus: SnapshotCacheStatus;
};

export type PersistedSnapshotRecord<T> = {
  payload: T;
  generatedAt: string;
  expiresAt: string;
  staleUntil: string;
};

export type SnapshotPersistenceAdapter<T> = {
  read: () => Promise<PersistedSnapshotRecord<T> | null>;
  write: (record: PersistedSnapshotRecord<T>) => Promise<void>;
};

type SnapshotCacheEntry<T> = {
  payload: T;
  generatedAtMs: number;
  expiresAtMs: number;
  staleUntilMs: number;
  inFlight?: Promise<SnapshotEnvelope<T>>;
};

type ReadSnapshotOptions<T> = {
  namespace: string;
  key: string;
  ttlMs: number;
  staleMs?: number;
  forceRefresh?: boolean;
  loader: () => Promise<T>;
  persistence?: SnapshotPersistenceAdapter<T>;
};

const snapshotCache = new Map<string, SnapshotCacheEntry<unknown>>();

function shouldBypassSnapshotCache() {
  return !!process.env.VITEST;
}

function buildCacheKey(namespace: string, key: string) {
  return `${namespace}:${key}`;
}

async function loadAndStoreSnapshot<T>(
  cacheKey: string,
  loader: () => Promise<T>,
  ttlMs: number,
  staleMs: number,
  persistence?: SnapshotPersistenceAdapter<T>,
) {
  const payload = await loader();
  const nowMs = Date.now();
  const persistedRecord: PersistedSnapshotRecord<T> = {
    payload,
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Math.max(1, ttlMs)).toISOString(),
    staleUntil: new Date(
      nowMs + Math.max(Math.max(1, ttlMs), staleMs),
    ).toISOString(),
  };
  const envelope: SnapshotEnvelope<T> = {
    payload,
    generatedAt: persistedRecord.generatedAt,
    cacheStatus: "miss",
  };
  snapshotCache.set(cacheKey, {
    payload,
    generatedAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(1, ttlMs),
    staleUntilMs: nowMs + Math.max(Math.max(1, ttlMs), staleMs),
  });
  if (persistence) {
    await persistence.write(persistedRecord);
  }
  return envelope;
}

function parseSnapshotTimestamp(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCacheEntryFromPersistedSnapshot<T>(
  record: PersistedSnapshotRecord<T>,
): SnapshotCacheEntry<T> {
  return {
    payload: record.payload,
    generatedAtMs: parseSnapshotTimestamp(record.generatedAt),
    expiresAtMs: parseSnapshotTimestamp(record.expiresAt),
    staleUntilMs: parseSnapshotTimestamp(record.staleUntil),
  };
}

export async function readSnapshotCache<T>(
  options: ReadSnapshotOptions<T>,
): Promise<SnapshotEnvelope<T>> {
  const staleMs = Math.max(options.ttlMs, options.staleMs ?? options.ttlMs * 6);
  if (shouldBypassSnapshotCache()) {
    const payload = await options.loader();
    return {
      payload,
      generatedAt: new Date().toISOString(),
      cacheStatus: "disabled",
    };
  }

  const cacheKey = buildCacheKey(options.namespace, options.key);
  const nowMs = Date.now();
  let cached = snapshotCache.get(cacheKey) as
    | SnapshotCacheEntry<T>
    | undefined;

  if (!cached && !options.forceRefresh && options.persistence) {
    const persisted = await options.persistence.read();
    if (persisted) {
      cached = buildCacheEntryFromPersistedSnapshot(persisted);
      snapshotCache.set(cacheKey, cached as SnapshotCacheEntry<unknown>);
    }
  }

  if (
    !options.forceRefresh &&
    cached?.payload !== undefined &&
    cached.expiresAtMs > nowMs
  ) {
    return {
      payload: cached.payload,
      generatedAt: new Date(cached.generatedAtMs).toISOString(),
      cacheStatus: "hit",
    };
  }

  if (
    !options.forceRefresh &&
    cached?.payload !== undefined &&
    cached.staleUntilMs > nowMs
  ) {
    if (!cached.inFlight) {
      cached.inFlight = loadAndStoreSnapshot(
        cacheKey,
        options.loader,
        options.ttlMs,
        staleMs,
        options.persistence,
      ).finally(() => {
          const next = snapshotCache.get(cacheKey) as
            | SnapshotCacheEntry<T>
            | undefined;
          if (next) delete next.inFlight;
        });
      void cached.inFlight.catch(() => undefined);
    }

    return {
      payload: cached.payload,
      generatedAt: new Date(cached.generatedAtMs).toISOString(),
      cacheStatus: "stale",
    };
  }

  if (cached?.inFlight && !options.forceRefresh) {
    const result = await cached.inFlight;
    return {
      ...result,
      cacheStatus:
        cached.payload !== undefined ? "refresh" : result.cacheStatus,
    };
  }

  const inFlight = loadAndStoreSnapshot(
    cacheKey,
    options.loader,
    options.ttlMs,
    staleMs,
    options.persistence,
  ).finally(() => {
    const next = snapshotCache.get(cacheKey) as
      | SnapshotCacheEntry<T>
      | undefined;
    if (next) delete next.inFlight;
  });

  snapshotCache.set(cacheKey, {
    payload: cached?.payload as T,
    generatedAtMs: cached?.generatedAtMs ?? 0,
    expiresAtMs: cached?.expiresAtMs ?? 0,
    staleUntilMs: cached?.staleUntilMs ?? 0,
    inFlight,
  });

  const result = await inFlight;
  return {
    ...result,
    cacheStatus: options.forceRefresh
      ? "refresh"
      : cached?.payload !== undefined
        ? "refresh"
        : "miss",
  };
}

export function clearSnapshotCache(namespace?: string) {
  if (!namespace) {
    snapshotCache.clear();
    return;
  }
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(`${namespace}:`)) snapshotCache.delete(key);
  }
}
