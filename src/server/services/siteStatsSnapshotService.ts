import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { fallbackTokenCost } from "./modelPricingService.js";
import {
  getLocalRangeStartUtc,
  toLocalDayKeyFromStoredUtc,
} from "./localTimeService.js";
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from "./snapshotCacheService.js";
import {
  buildProxyLogSiteTrendSelectFields,
  proxyCostSqlExpression,
  toRoundedMicroNumber,
} from "./statsShared.js";
import { createAdminSnapshotPersistence } from "./adminSnapshotStore.js";

export type SiteStatsSnapshotPayload = {
  distribution: Array<{
    siteId: number;
    siteName: string;
    platform: string | null;
    totalBalance: number;
    totalSpend: number;
    accountCount: number;
  }>;
  trend: Array<{
    date: string;
    sites: Record<string, { spend: number; calls: number }>;
  }>;
  sites: Array<typeof schema.sites.$inferSelect>;
};

const SITE_STATS_TTL_MS = 15_000;

async function loadSiteStatsSnapshotPayload(
  days: number,
): Promise<SiteStatsSnapshotPayload> {
  const sinceDate = getLocalRangeStartUtc(days);
  const proxyLogSiteTrendFields = buildProxyLogSiteTrendSelectFields();

  const [spendRows, trendRows, sites] = await Promise.all([
    db
      .select({
        siteId: schema.sites.id,
        totalSpend: sql<number>`coalesce(sum(${proxyCostSqlExpression()}), 0)`,
      })
      .from(schema.proxyLogs)
      .leftJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, "active"))
      .groupBy(schema.sites.id)
      .all(),
    db
      .select({
        proxy_logs: proxyLogSiteTrendFields,
        sites: {
          name: schema.sites.name,
          platform: schema.sites.platform,
        },
      })
      .from(schema.proxyLogs)
      .leftJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, sinceDate),
          eq(schema.sites.status, "active"),
        ),
      )
      .all(),
    db.select().from(schema.sites).all(),
  ]);

  const accountDistributionRows = await db
    .select({
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      platform: schema.sites.platform,
      totalBalance: sql<number>`coalesce(sum(coalesce(${schema.accounts.balance}, 0)), 0)`,
      accountCount: sql<number>`count(*)`,
    })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.sites.status, "active"))
    .groupBy(schema.sites.id, schema.sites.name, schema.sites.platform)
    .all();

  const spendBySiteId = new Map<number, number>();
  for (const row of spendRows) {
    if (row.siteId == null) continue;
    spendBySiteId.set(row.siteId, Number(row.totalSpend || 0));
  }

  const distribution = accountDistributionRows.map((row) => ({
    siteId: row.siteId,
    siteName: row.siteName,
    platform: row.platform,
    totalBalance: toRoundedMicroNumber(Number(row.totalBalance || 0)),
    totalSpend: toRoundedMicroNumber(spendBySiteId.get(row.siteId) || 0),
    accountCount: Number(row.accountCount || 0),
  }));

  const dayMap: Record<
    string,
    Record<string, { spend: number; calls: number }>
  > = {};
  for (const row of trendRows) {
    const log = row.proxy_logs;
    const siteName = row.sites?.name || "unknown";
    const platform = row.sites?.platform || "new-api";
    const date = toLocalDayKeyFromStoredUtc(log.createdAt);
    if (!date) continue;

    if (!dayMap[date]) dayMap[date] = {};
    if (!dayMap[date][siteName])
      dayMap[date][siteName] = { spend: 0, calls: 0 };

    const explicitCost =
      typeof log.estimatedCost === "number" ? log.estimatedCost : 0;
    const cost =
      explicitCost > 0
        ? explicitCost
        : fallbackTokenCost(log.totalTokens || 0, platform);
    dayMap[date][siteName].spend += cost;
    dayMap[date][siteName].calls += 1;
  }

  const trend = Object.entries(dayMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      sites: Object.fromEntries(
        Object.entries(value).map(([siteName, stats]) => [
          siteName,
          {
            spend: toRoundedMicroNumber(stats.spend),
            calls: stats.calls,
          },
        ]),
      ),
    }));

  return {
    distribution,
    trend,
    sites,
  };
}

export async function getSiteStatsSnapshot(options?: {
  days?: number;
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<SiteStatsSnapshotPayload>> {
  const days = Math.max(1, Math.trunc(options?.days || 7));
  return readSnapshotCache({
    namespace: "site-stats",
    key: JSON.stringify({ days }),
    ttlMs: SITE_STATS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: createAdminSnapshotPersistence<SiteStatsSnapshotPayload>({
      namespace: "site-stats",
      key: JSON.stringify({ days }),
    }),
    loader: async () => loadSiteStatsSnapshotPayload(days),
  });
}
