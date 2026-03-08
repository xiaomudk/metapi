import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { resolveProxyUrlForSite, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import {
  buildMinimalJsonHeadersForCompatibility,
  buildUpstreamEndpointRequest,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  resolveUpstreamEndpointCandidates,
} from './upstreamEndpoint.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { executeEndpointFlow, withUpstreamPath } from './endpointFlow.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { resolveProxyLogBilling } from './proxyBilling.js';
import { getProxyResourceOwner } from '../../middleware/auth.js';
import {
  ProxyInputFileResolutionError,
  hasNonImageFileInputInOpenAiBody,
  resolveOpenAiBodyInputFiles,
  resolveResponsesBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';

const MAX_RETRIES = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function hasResponsesReasoningRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const relevantKeys = ['effort', 'budget_tokens', 'budgetTokens', 'max_tokens', 'maxTokens', 'summary'];
  return relevantKeys.some((key) => {
    const entry = value[key];
    if (typeof entry === 'string') return entry.trim().length > 0;
    return entry !== undefined && entry !== null;
  });
}

function wantsNativeResponsesReasoning(body: unknown): boolean {
  if (!isRecord(body)) return false;

  const include = Array.isArray(body.include)
    ? body.include
    : (typeof body.include === 'string' ? [body.include] : []);

  return include.some((item) => (
    typeof item === 'string'
    && item.trim().toLowerCase() === 'reasoning.encrypted_content'
  )) || hasResponsesReasoningRequest(body.reasoning);
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function responsesProxyRoute(app: FastifyInstance) {
  const handleResponsesRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
    downstreamPath: string,
  ) => {
    const body = request.body as any;
    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const isCompactRequest = downstreamPath === '/v1/responses/compact';

    const isStream = body.stream === true;
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
      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(body, modelName, isStream);
      const owner = getProxyResourceOwner(request);
      let resolvedOpenAiBody = openAiBody;
      let resolvedResponsesBody = body;
      if (owner) {
        try {
          resolvedOpenAiBody = await resolveOpenAiBodyInputFiles(openAiBody, owner);
          resolvedResponsesBody = await resolveResponsesBodyInputFiles(body, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            return reply.code(error.statusCode).send(error.payload);
          }
          throw error;
        }
      }
      const hasNonImageFileInput = hasNonImageFileInputInOpenAiBody(resolvedOpenAiBody);
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(resolvedResponsesBody);
      const endpointCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        'responses',
        requestedModel,
        {
          hasNonImageFileInput,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      );
      if (endpointCandidates.length === 0) {
        endpointCandidates.push('responses', 'chat', 'messages');
      }

      const startTime = Date.now();

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
              downstreamFormat: 'responses',
              responsesOriginalBody: resolvedResponsesBody,
              downstreamHeaders: request.headers as Record<string, unknown>,
            });
            const upstreamPath = (
              isCompactRequest && endpoint === 'responses'
                ? `${endpointRequest.path}/compact`
                : endpointRequest.path
            );
            return {
              endpoint,
              path: upstreamPath,
              headers: endpointRequest.headers,
              body: endpointRequest.body as Record<string, unknown>,
            };
        },
        tryRecover: async (ctx) => {
            if (openAiResponsesTransformer.compatibility.shouldRetry({
              endpoint: ctx.request.endpoint,
              status: ctx.response.status,
              rawErrText: ctx.rawErrText,
            })) {
              const compatibilityBodies = openAiResponsesTransformer.compatibility.buildRetryBodies(ctx.request.body);
              const compatibilityHeaders = openAiResponsesTransformer.compatibility.buildRetryHeaders(
                ctx.request.headers,
                isStream,
              );

              for (const compatibilityHeadersCandidate of compatibilityHeaders) {
                for (const compatibilityBody of compatibilityBodies) {
                  const compatibilityResponse = await fetch(
                    ctx.targetUrl,
                    withSiteRecordProxyRequestInit(selected.site, {
                      method: 'POST',
                      headers: compatibilityHeadersCandidate,
                      body: JSON.stringify(compatibilityBody),
                    }),
                  );
                  if (compatibilityResponse.ok) {
                    return {
                      upstream: compatibilityResponse,
                      upstreamPath: ctx.request.path,
                    };
                  }

                  ctx.request = {
                    ...ctx.request,
                    headers: compatibilityHeadersCandidate,
                    body: compatibilityBody,
                  };
                  ctx.response = compatibilityResponse;
                  ctx.rawErrText = await compatibilityResponse.text().catch(() => 'unknown error');
                }
              }
            }

            if (!isUnsupportedMediaTypeError(ctx.response.status, ctx.rawErrText)) {
              return null;
            }

            const minimalHeaders = buildMinimalJsonHeadersForCompatibility({
              headers: ctx.request.headers,
              endpoint: ctx.request.endpoint,
              stream: isStream,
            });
            const minimalResponse = await fetch(
              ctx.targetUrl,
              withSiteRecordProxyRequestInit(selected.site, {
                method: 'POST',
                headers: minimalHeaders,
                body: JSON.stringify(ctx.request.body),
              }),
            );
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
            ctx.response.status >= 500
            || isEndpointDowngradeError(ctx.response.status, ctx.rawErrText)
            || openAiResponsesTransformer.compatibility.shouldDowngradeChatToMessages(
              ctx.request.path,
              ctx.response.status,
              ctx.rawErrText,
            )
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
          return reply.code(status).send({ error: { message: errText, type: 'upstream_error' } });
        }

        const upstream = endpointResult.upstream;
        const successfulUpstreamPath = endpointResult.upstreamPath;

        if (isStream) {
          reply.raw.statusCode = 200;
          reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
          reply.raw.setHeader('Connection', 'keep-alive');
          reply.raw.setHeader('X-Accel-Buffering', 'no');

          const reader = upstream.body?.getReader();
          if (!reader) {
            reply.raw.end();
            return;
          }

          const decoder = new TextDecoder();
          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          let sseBuffer = '';

          const passthroughResponsesStream = successfulUpstreamPath === '/v1/responses';
          const streamContext = openAiResponsesTransformer.createStreamContext(modelName);
          const responsesState = openAiResponsesTransformer.aggregator.createState(modelName);

          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };

          const consumeSseBuffer = (incoming: string): string => {
             const pulled = openAiResponsesTransformer.pullSseEvents(incoming);
            for (const eventBlock of pulled.events) {
              if (eventBlock.data === '[DONE]') {
                if (passthroughResponsesStream) {
                  reply.raw.write('data: [DONE]\n\n');
                } else if (!responsesState.completed) {
                  writeLines(openAiResponsesTransformer.aggregator.complete(responsesState, streamContext, parsedUsage));
                }
                continue;
              }

              let parsedPayload: unknown = null;
              try {
                parsedPayload = JSON.parse(eventBlock.data);
              } catch {
                parsedPayload = null;
              }

              if (parsedPayload && typeof parsedPayload === 'object') {
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(parsedPayload));
              }

              if (passthroughResponsesStream) {
                const eventName = eventBlock.event ? `event: ${eventBlock.event}\n` : '';
                reply.raw.write(`${eventName}data: ${eventBlock.data}\n\n`);
                continue;
              }

              const payloadType = (isRecord(parsedPayload) && typeof parsedPayload.type === 'string')
                ? parsedPayload.type
                : '';
              const isFailureEvent = (
                eventBlock.event === 'error'
                || eventBlock.event === 'response.failed'
                || payloadType === 'error'
                || payloadType === 'response.failed'
              );
              if (isFailureEvent) {
                writeLines(openAiResponsesTransformer.aggregator.fail(responsesState, streamContext, parsedUsage, parsedPayload));
                continue;
              }

              if (parsedPayload && typeof parsedPayload === 'object') {
                const normalizedEvent = openAiResponsesTransformer.transformStreamEvent(parsedPayload, streamContext, modelName);
                writeLines(openAiResponsesTransformer.aggregator.serialize({
                  state: responsesState,
                  streamContext,
                  event: normalizedEvent,
                  usage: parsedUsage,
                }));
                continue;
              }

              writeLines(openAiResponsesTransformer.aggregator.serialize({
                state: responsesState,
                streamContext,
                event: { contentDelta: eventBlock.data },
                usage: parsedUsage,
              }));
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
            }

            sseBuffer += decoder.decode();
            if (sseBuffer.trim().length > 0) {
              sseBuffer = consumeSseBuffer(`${sseBuffer}\n\n`);
            }
          } finally {
            reader.releaseLock();
            if (!passthroughResponsesStream && !responsesState.completed) {
              writeLines(openAiResponsesTransformer.aggregator.complete(responsesState, streamContext, parsedUsage));
            }
            reply.raw.end();
          }

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName: selected.actualModel || requestedModel,
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
            modelName: selected.actualModel || requestedModel,
            parsedUsage,
            resolvedUsage,
          });
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected, requestedModel, 'success', 200, latency, null, retryCount, downstreamPath,
            resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost, billingDetails,
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
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
        });
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
          tokenName: selected.tokenName,
          modelName: selected.actualModel || requestedModel,
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
          modelName: selected.actualModel || requestedModel,
          parsedUsage,
          resolvedUsage,
        });

        tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected, requestedModel, 'success', 200, latency, null, retryCount, downstreamPath,
          resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost, billingDetails,
          successfulUpstreamPath,
        );
        return reply.send(downstreamData);
      } catch (err: any) {
        tokenRouter.recordFailure(selected.channel.id);
        logProxy(selected, requestedModel, 'failed', 0, Date.now() - startTime, err.message, retryCount, downstreamPath);
        if (retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: err.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: `Upstream error: ${err.message}`, type: 'upstream_error' },
        });
      }
    }
  };

  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) =>
    handleResponsesRequest(request, reply, '/v1/responses'));
  app.post('/v1/responses/compact', async (request: FastifyRequest, reply: FastifyReply) =>
    handleResponsesRequest(request, reply, '/v1/responses/compact'));
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
    console.warn('[proxy/responses] failed to write proxy log', error);
  }
}
