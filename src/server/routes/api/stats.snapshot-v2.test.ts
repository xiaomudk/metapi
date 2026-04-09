import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DbModule = typeof import("../../db/index.js");

describe("stats snapshot v2 routes", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let dataDir = "";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "metapi-stats-snapshot-v2-"));
    process.env.DATA_DIR = dataDir;

    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./stats.js");
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it("returns dashboard and site snapshot payloads for progressive loading", async () => {
    const site = await db
      .insert(schema.sites)
      .values({
        name: "stats-site",
        url: "https://stats-site.example.com",
        platform: "new-api",
      })
      .returning()
      .get();
    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "stats-user",
        accessToken: "stats-token",
        balance: 42,
        status: "active",
      })
      .returning()
      .get();

    await db
      .insert(schema.proxyLogs)
      .values([
        {
          accountId: account.id,
          status: "success",
          modelRequested: "gpt-4o",
          modelActual: "gpt-4o",
          totalTokens: 120,
          estimatedCost: 0.5,
          latencyMs: 320,
          createdAt: new Date().toISOString(),
        },
        {
          accountId: account.id,
          status: "failed",
          modelRequested: "gpt-4o-mini",
          modelActual: "gpt-4o-mini",
          totalTokens: 60,
          estimatedCost: 0.25,
          latencyMs: 220,
          createdAt: new Date().toISOString(),
        },
      ])
      .run();

    const summaryResponse = await app.inject({
      method: "GET",
      url: "/api/stats/dashboard/snapshot-v2",
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.headers["x-dashboard-summary-cache"]).toBeTruthy();
    const summary = summaryResponse.json() as {
      generatedAt: string;
      totalBalance: number;
      proxy24h: { total: number };
    };
    expect(Date.parse(summary.generatedAt)).not.toBeNaN();
    expect(summary.totalBalance).toBe(42);
    expect(summary.proxy24h.total).toBe(2);

    const insightsResponse = await app.inject({
      method: "GET",
      url: "/api/stats/dashboard/insights-v2",
    });
    expect(insightsResponse.statusCode).toBe(200);
    const insights = insightsResponse.json() as {
      generatedAt: string;
      siteAvailability: Array<{ siteId: number }>;
      modelAnalysis: { totals: { calls: number } };
    };
    expect(Date.parse(insights.generatedAt)).not.toBeNaN();
    expect(insights.siteAvailability).toEqual([
      expect.objectContaining({ siteId: site.id }),
    ]);
    expect(insights.modelAnalysis.totals.calls).toBe(2);

    const siteSnapshotResponse = await app.inject({
      method: "GET",
      url: "/api/stats/site-snapshot-v2?days=7",
    });
    expect(siteSnapshotResponse.statusCode).toBe(200);
    expect(siteSnapshotResponse.headers["x-site-stats-cache"]).toBeTruthy();
    const siteSnapshot = siteSnapshotResponse.json() as {
      generatedAt: string;
      distribution: Array<{ siteId: number; totalSpend: number }>;
      trend: Array<{ date: string }>;
      sites: Array<{ id: number; name: string }>;
    };
    expect(Date.parse(siteSnapshot.generatedAt)).not.toBeNaN();
    expect(siteSnapshot.distribution).toEqual([
      expect.objectContaining({ siteId: site.id, totalSpend: 0.75 }),
    ]);
    expect(siteSnapshot.trend.length).toBeGreaterThan(0);
    expect(siteSnapshot.sites).toEqual([
      expect.objectContaining({ id: site.id, name: "stats-site" }),
    ]);
  });
});
