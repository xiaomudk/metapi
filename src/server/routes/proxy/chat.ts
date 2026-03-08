import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { tokenRouter } from '../../services/tokenRouter.js';
import { db, schema } from '../../db/index.js';
import { fetch } from 'undici';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { resolveProxyUrlForSite, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { type DownstreamFormat } from '../../transformers/shared/normalized.js';
import {
  buildMinimalJsonHeadersForCompatibility,
  buildUpstreamEndpointRequest,
  isEndpointDispatchDeniedError,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  promoteResponsesCandidateAfterLegacyChatError,
  resolveUpstreamEndpointCandidates,
} from './upstreamEndpoint.js';
import {
  ensureModelAllowedForDownstreamKey,
  getDownstreamRoutingPolicy,
  recordDownstreamCostUsage,
} from './downstreamPolicy.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { executeEndpointFlow, withUpstreamPath } from './endpointFlow.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { resolveProxyLogBilling } from './proxyBilling.js';
import { openAiChatTransformer } from '../../transformers/openai/chat/index.js';
import { anthropicMessagesTransformer } from '../../transformers/anthropic/messages/index.js';
import { getProxyResourceOwner } from '../../middleware/auth.js';
import {
  ProxyInputFileResolutionError,
  hasNonImageFileInputInOpenAiBody,
  resolveOpenAiBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';

const MAX_RETRIES = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export async function chatProxyRoute(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) =>
    handleChatProxyRequest(request, reply, 'openai'));
}

export async function claudeMessagesProxyRoute(app: FastifyInstance) {
  app.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) =>
    handleChatProxyRequest(request, reply, 'claude'));
}

async function handleChatProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamFormat: DownstreamFormat,
) {
  const downstreamTransformer = downstreamFormat === 'claude'
    ? anthropicMessagesTransformer
    : openAiChatTransformer;
  const parsedRequest = downstreamTransformer.transformRequest(request.body);
  if (parsedRequest.error) {
    return reply.code(parsedRequest.error.statusCode).send(parsedRequest.error.payload);
  }

  const { requestedModel, isStream, upstreamBody, claudeOriginalBody } = parsedRequest.value!;
  const downstreamPath = downstreamFormat === 'claude' ? '/v1/messages' : '/v1/chat/completions';
  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPolicy = getDownstreamRoutingPolicy(request);
  const owner = getProxyResourceOwner(request);
  let resolvedOpenAiBody = upstreamBody;
  if (owner) {
    try {
      resolvedOpenAiBody = await resolveOpenAiBodyInputFiles(upstreamBody, owner);
    } catch (error) {
      if (error instanceof ProxyInputFileResolutionError) {
        return reply.code(error.statusCode).send(error.payload);
      }
      throw error;
    }
  }
  const hasNonImageFileInput = hasNonImageFileInputInOpenAiBody(resolvedOpenAiBody);

  const excludeChannelIds: number[] = [];
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    let selected = retryCount === 0
      ? await tokenRouter.selectChannel(requestedModel, downstreamPolicy)
      : await tokenRouter.selectNextChannel(requestedModel, excludeChannelIds, downstreamPolicy);

    if (!selected && retryCount === 0) {
      await refreshModelsAndRebuildRoutes();
      selected = await tokenRouter.selectChannel(requestedModel, downstreamPolicy);
    }

    if (!selected) {
      await reportProxyAllFailed({
        model: requestedModel,
        reason: 'No available channels after retries',
      });
      return reply.code(503).send({
        error: { message: 'No available channels for this model', type: 'server_error' },
      });
    }

    excludeChannelIds.push(selected.channel.id);

    const modelName = selected.actualModel || requestedModel;
      const endpointCandidates = [
        ...await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        downstreamFormat,
        requestedModel,
        {
          hasNonImageFileInput,
        },
        ),
      ];
    let startTime = Date.now();

    try {
      const endpointResult = await executeEndpointFlow({
        siteUrl: selected.site.url,
        proxyUrl: resolveProxyUrlForSite(selected.site),
        endpointCandidates,
        buildRequest: (endpoint) => {
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: isStream,
            tokenValue: selected.tokenValue,
            sitePlatform: selected.site.platform,
            siteUrl: selected.site.url,
            openaiBody: resolvedOpenAiBody,
            downstreamFormat,
            claudeOriginalBody,
            downstreamHeaders: request.headers as Record<string, unknown>,
          });
          return {
            endpoint,
            path: endpointRequest.path,
            headers: endpointRequest.headers,
            body: endpointRequest.body as Record<string, unknown>,
          };
        },
        tryRecover: async (ctx) => {
          if (anthropicMessagesTransformer.compatibility.shouldRetryNormalizedBody({
            downstreamFormat,
            endpointPath: ctx.request.path,
            status: ctx.response.status,
            upstreamErrorText: ctx.rawErrText,
          })) {
            const normalizedClaudeRequest = buildUpstreamEndpointRequest({
              endpoint: ctx.request.endpoint,
              modelName,
              stream: isStream,
              tokenValue: selected.tokenValue,
              sitePlatform: selected.site.platform,
              siteUrl: selected.site.url,
              openaiBody: resolvedOpenAiBody,
              downstreamFormat,
              claudeOriginalBody,
              forceNormalizeClaudeBody: true,
              downstreamHeaders: request.headers as Record<string, unknown>,
            });
            const normalizedTargetUrl = `${selected.site.url}${normalizedClaudeRequest.path}`;
            const normalizedResponse = await fetch(normalizedTargetUrl, withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: normalizedClaudeRequest.headers,
              body: JSON.stringify(normalizedClaudeRequest.body),
            }));

            if (normalizedResponse.ok) {
              return {
                upstream: normalizedResponse,
                upstreamPath: normalizedClaudeRequest.path,
              };
            }

            ctx.request = {
              ...ctx.request,
              path: normalizedClaudeRequest.path,
              headers: normalizedClaudeRequest.headers,
              body: normalizedClaudeRequest.body as Record<string, unknown>,
            };
            ctx.response = normalizedResponse;
            ctx.rawErrText = await normalizedResponse.text().catch(() => 'unknown error');
          }

          if (!isUnsupportedMediaTypeError(ctx.response.status, ctx.rawErrText)) {
            return null;
          }

          const minimalHeaders = buildMinimalJsonHeadersForCompatibility({
            headers: ctx.request.headers,
            endpoint: ctx.request.endpoint,
            stream: isStream,
          });
          const normalizedCurrentHeaders = Object.fromEntries(
            Object.entries(ctx.request.headers).map(([key, value]) => [key.toLowerCase(), value]),
          );
          if (JSON.stringify(minimalHeaders) === JSON.stringify(normalizedCurrentHeaders)) {
            return null;
          }

          const minimalResponse = await fetch(ctx.targetUrl, withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: minimalHeaders,
            body: JSON.stringify(ctx.request.body),
          }));

          if (minimalResponse.ok) {
            return {
              upstream: minimalResponse,
              upstreamPath: ctx.request.path,
            };
          }

          ctx.request = {
            ...ctx.request,
            headers: minimalHeaders,
          };
          ctx.response = minimalResponse;
          ctx.rawErrText = await minimalResponse.text().catch(() => 'unknown error');
          return null;
        },
        shouldDowngrade: (ctx) => (
          (() => {
            promoteResponsesCandidateAfterLegacyChatError(endpointCandidates, {
              status: ctx.response.status,
              upstreamErrorText: ctx.rawErrText,
              downstreamFormat,
              sitePlatform: selected.site.platform,
              modelName,
              requestedModelHint: requestedModel,
              currentEndpoint: ctx.request.endpoint,
            });
            return (
              ctx.response.status >= 500
              || isEndpointDowngradeError(ctx.response.status, ctx.rawErrText)
              || anthropicMessagesTransformer.compatibility.isMessagesRequiredError(ctx.rawErrText)
              || isEndpointDispatchDeniedError(ctx.response.status, ctx.rawErrText)
            );
          })()
        ),
        onDowngrade: (ctx) => {
          logProxy(
            selected,
            requestedModel,
            'failed',
            ctx.response.status,
            Date.now() - startTime,
            ctx.errText,
            retryCount,
            downstreamPath,
          );
        },
      });

      if (!endpointResult.ok) {
        const status = endpointResult.status || 502;
        const errText = endpointResult.errText || 'unknown error';
        tokenRouter.recordFailure(selected.channel.id);
        logProxy(selected, requestedModel, 'failed', status, Date.now() - startTime, errText, retryCount, downstreamPath);

        if (isTokenExpiredError({ status, message: errText })) {
          await reportTokenExpired({
            accountId: selected.account.id,
            username: selected.account.username,
            siteName: selected.site.name,
            detail: `HTTP ${status}`,
          });
        }

        if (shouldRetryProxyRequest(status, errText) && retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }

        await reportProxyAllFailed({
          model: requestedModel,
          reason: `upstream returned HTTP ${status}`,
        });

        return reply.code(status).send({
          error: { message: errText, type: 'upstream_error' },
        });
      }

      const upstream = endpointResult.upstream;
      const successfulUpstreamPath = endpointResult.upstreamPath;

      if (isStream) {
        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');

        const streamContext = downstreamTransformer.createStreamContext(modelName);
        const claudeContext = anthropicMessagesTransformer.createDownstreamContext();
        let parsedUsage: ReturnType<typeof parseProxyUsage> = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          promptTokensIncludeCache: null,
        };

        const writeLines = (lines: string[]) => {
          for (const line of lines) {
            reply.raw.write(line);
          }
        };

        const writeDone = () => {
          writeLines(downstreamTransformer.serializeDone(streamContext, claudeContext));
        };

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        if (!upstreamContentType.includes('text/event-stream')) {
          const fallbackText = await upstream.text();
          let fallbackData: unknown = null;
          try {
            fallbackData = JSON.parse(fallbackText);
          } catch {
            fallbackData = fallbackText;
          }

          parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(fallbackData));
          if (downstreamFormat === 'openai') {
            const syntheticLines = openAiChatTransformer.serializeUpstreamFinalAsStream(
              fallbackData,
              modelName,
              fallbackText,
              streamContext,
            );
            writeLines(syntheticLines);
          } else {
            writeLines(
              anthropicMessagesTransformer.serializeUpstreamFinalAsStream(
                fallbackData,
                modelName,
                fallbackText,
                streamContext,
                claudeContext,
              ),
            );
          }
          writeDone();
          reply.raw.end();

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName,
            requestStartedAtMs: startTime,
            requestEndedAtMs: startTime + latency,
            localLatencyMs: latency,
            usage: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
            },
          });

          const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
            site: selected.site,
            account: selected.account,
            modelName,
            parsedUsage,
            resolvedUsage,
          });

          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected,
            requestedModel,
            'success',
            200,
            latency,
            null,
            retryCount,
            downstreamPath,
            resolvedUsage.promptTokens,
            resolvedUsage.completionTokens,
            resolvedUsage.totalTokens,
            estimatedCost,
            billingDetails,
            successfulUpstreamPath,
          );
          return;
        }

        const reader = upstream.body?.getReader();
        if (!reader) {
          writeDone();
          reply.raw.end();
          return;
        }

        const decoder = new TextDecoder();
        let sseBuffer = '';
        let shouldTerminateEarly = false;

        const consumeSseBuffer = (incoming: string): string => {
          const pulled = downstreamTransformer.pullSseEvents(incoming);
          for (const eventBlock of pulled.events) {
            if (eventBlock.data === '[DONE]') {
              writeDone();
              shouldTerminateEarly = true;
              continue;
            }

            let parsedPayload: unknown = null;
            if (downstreamFormat === 'claude') {
              const consumed = anthropicMessagesTransformer.consumeSseEventBlock(
                eventBlock,
                streamContext,
                claudeContext,
                modelName,
              );
              parsedPayload = consumed.parsedPayload;
              if (parsedPayload && typeof parsedPayload === 'object') {
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(parsedPayload));
              }
              if (consumed.handled) {
                writeLines(consumed.lines);
                if (consumed.done) {
                  shouldTerminateEarly = true;
                  break;
                }
                continue;
              }
            } else {
              try {
                parsedPayload = JSON.parse(eventBlock.data);
              } catch {
                parsedPayload = null;
              }
              if (parsedPayload && typeof parsedPayload === 'object') {
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(parsedPayload));
              }
            }

            if (parsedPayload && typeof parsedPayload === 'object') {
              const normalizedEvent = downstreamTransformer.transformStreamEvent(parsedPayload, streamContext, modelName);
              writeLines(downstreamTransformer.serializeStreamEvent(normalizedEvent, streamContext, claudeContext));
              if (downstreamFormat === 'claude' && claudeContext.doneSent) {
                shouldTerminateEarly = true;
                break;
              }
              if (streamContext.doneSent) {
                shouldTerminateEarly = true;
                break;
              }
              continue;
            }

            if (downstreamFormat === 'openai') {
              reply.raw.write(`data: ${eventBlock.data}\n\n`);
            } else {
              writeLines(anthropicMessagesTransformer.serializeStreamEvent({
                contentDelta: eventBlock.data,
              }, streamContext, claudeContext));
              if (claudeContext.doneSent) {
                shouldTerminateEarly = true;
                break;
              }
            }
          }

          return pulled.rest;
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            sseBuffer += decoder.decode(value, { stream: true });
            sseBuffer = consumeSseBuffer(sseBuffer);
            if (shouldTerminateEarly) {
              await reader.cancel().catch(() => {});
              break;
            }
          }

          if (!shouldTerminateEarly) {
            sseBuffer += decoder.decode();
          }
          if (!shouldTerminateEarly && sseBuffer.trim().length > 0) {
            sseBuffer = consumeSseBuffer(`${sseBuffer}\n\n`);
          }
        } finally {
          reader.releaseLock();
          writeDone();
          reply.raw.end();
        }

        const latency = Date.now() - startTime;
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
          tokenName: selected.tokenName,
          modelName,
          requestStartedAtMs: startTime,
          requestEndedAtMs: startTime + latency,
          localLatencyMs: latency,
          usage: {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
          },
        });

        const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
          site: selected.site,
          account: selected.account,
          modelName,
          parsedUsage,
          resolvedUsage,
        });

        tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected,
          requestedModel,
          'success',
          200,
          latency,
          null,
          retryCount,
          downstreamPath,
          resolvedUsage.promptTokens,
          resolvedUsage.completionTokens,
          resolvedUsage.totalTokens,
          estimatedCost,
          billingDetails,
          successfulUpstreamPath,
        );
        return;
      }

      const rawText = await upstream.text();
      let upstreamData: unknown = rawText;
      try {
        upstreamData = JSON.parse(rawText);
      } catch {
        upstreamData = rawText;
      }

      const latency = Date.now() - startTime;
      const parsedUsage = parseProxyUsage(upstreamData);
      const normalizedFinal = downstreamTransformer.transformFinalResponse(upstreamData, modelName, rawText);
      const downstreamResponse = downstreamTransformer.serializeFinalResponse(normalizedFinal, parsedUsage);

      const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
        site: selected.site,
        account: selected.account,
        tokenValue: selected.tokenValue,
        tokenName: selected.tokenName,
        modelName,
        requestStartedAtMs: startTime,
        requestEndedAtMs: startTime + latency,
        localLatencyMs: latency,
        usage: {
          promptTokens: parsedUsage.promptTokens,
          completionTokens: parsedUsage.completionTokens,
          totalTokens: parsedUsage.totalTokens,
        },
      });

      const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
        site: selected.site,
        account: selected.account,
        modelName,
        parsedUsage,
        resolvedUsage,
      });

      tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
      recordDownstreamCostUsage(request, estimatedCost);
      logProxy(
        selected,
        requestedModel,
        'success',
        200,
        latency,
        null,
        retryCount,
        downstreamPath,
        resolvedUsage.promptTokens,
        resolvedUsage.completionTokens,
        resolvedUsage.totalTokens,
        estimatedCost,
        billingDetails,
        successfulUpstreamPath,
      );

      return reply.send(downstreamResponse);
    } catch (err: any) {
      tokenRouter.recordFailure(selected.channel.id);
      logProxy(selected, requestedModel, 'failed', 0, Date.now() - startTime, err?.message || 'network error', retryCount, downstreamPath);

      if (retryCount < MAX_RETRIES) {
        retryCount += 1;
        continue;
      }

      await reportProxyAllFailed({
        model: requestedModel,
        reason: err?.message || 'network failure',
      });

      return reply.code(502).send({
        error: {
          message: `Upstream error: ${err?.message || 'network failure'}`,
          type: 'upstream_error',
        },
      });
    }
  }
}

async function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamPath: string,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  estimatedCost = 0,
  billingDetails: unknown = null,
  upstreamPath: string | null = null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      downstreamPath,
      upstreamPath,
      errorMessage,
    });
    await db.insert(schema.proxyLogs).values({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      modelRequested,
      modelActual: selected.actualModel,
      status,
      httpStatus,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      billingDetails: billingDetails ? JSON.stringify(billingDetails) : null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    }).run();
  } catch (error) {
    console.warn('[proxy/chat] failed to write proxy log', error);
  }
}
