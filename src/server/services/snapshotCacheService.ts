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
) {
  const payload = await loader();
  const nowMs = Date.now();
  const envelope: SnapshotEnvelope<T> = {
    payload,
    generatedAt: new Date(nowMs).toISOString(),
    cacheStatus: "miss",
  };
  snapshotCache.set(cacheKey, {
    payload,
    generatedAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(1, ttlMs),
    staleUntilMs: nowMs + Math.max(Math.max(1, ttlMs), staleMs),
  });
  return envelope;
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
  const cached = snapshotCache.get(cacheKey) as
    | SnapshotCacheEntry<T>
    | undefined;

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
