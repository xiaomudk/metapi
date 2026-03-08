import { describe, expect, it } from 'vitest';

import { createStreamTransformContext } from '../../shared/normalized.js';
import {
  createOpenAiResponsesAggregateState,
  serializeConvertedResponsesEvents,
} from './aggregator.js';

function parseSsePayloads(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .flatMap((line) => line.split('\n\n').filter((block) => block.trim().length > 0))
    .map((block) => {
      const dataLine = block
        .split('\n')
        .find((line) => line.startsWith('data: '));
      if (!dataLine) return null;
      try {
        return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => !!item);
}

describe('serializeConvertedResponsesEvents', () => {
  it('aggregates reasoning summary events into the completed response payload', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');
    const streamContext = createStreamTransformContext('gpt-5');
    const usage = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    };

    serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.reasoning_summary_part.added',
        responsesPayload: {
          type: 'response.reasoning_summary_part.added',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          part: {
            type: 'summary_text',
            text: '',
          },
        },
      },
    });

    serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.reasoning_summary_text.delta',
        responsesPayload: {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          delta: 'Think ',
        },
      },
    });

    const completedLines = serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.completed',
        responsesPayload: {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            model: 'gpt-5',
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              total_tokens: 3,
            },
          },
        },
      },
    });

    const payloads = parseSsePayloads(completedLines);
    const completed = payloads.find((item) => item.type === 'response.completed');
    expect(completed).toBeTruthy();
    expect(completed?.response).toMatchObject({
      id: 'resp_1',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [
            {
              type: 'summary_text',
              text: 'Think ',
            },
          ],
        },
      ],
    });
  });

  it('keeps encrypted-only reasoning output items during stream aggregation', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');
    const streamContext = createStreamTransformContext('gpt-5');
    const usage = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    };

    serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.output_item.added',
        responsesPayload: {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'reasoning',
            encrypted_content: 'enc-only',
          },
        },
      },
    });

    const completedLines = serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.completed',
        responsesPayload: {
          type: 'response.completed',
          response: {
            id: 'resp_enc_only',
            model: 'gpt-5',
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              total_tokens: 3,
            },
          },
        },
      },
    });

    const payloads = parseSsePayloads(completedLines);
    const completed = payloads.find((item) => item.type === 'response.completed');
    expect(completed).toBeTruthy();
    expect(completed?.response?.output?.[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'enc-only',
    });
    expect((completed?.response?.output?.[0] as any)?.id).toMatch(/^rs_/);
  });

  it('starts a synthetic reasoning item when fallback streams only carry encrypted reasoning signatures', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');
    const streamContext = createStreamTransformContext('gpt-5');
    const usage = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    };

    const signatureLines = serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        reasoningSignature: 'enc-stream-only',
      } as any,
    });

    const signaturePayloads = parseSsePayloads(signatureLines);
    expect(signaturePayloads).toEqual([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'rs_0',
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
          encrypted_content: 'enc-stream-only',
        },
      },
    ]);

    const completedLines = serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.completed',
        responsesPayload: {
          type: 'response.completed',
          response: {
            id: 'resp_enc_stream_only',
            model: 'gpt-5',
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              total_tokens: 3,
            },
          },
        },
      },
    });

    const payloads = parseSsePayloads(completedLines);
    const completed = payloads.find((item) => item.type === 'response.completed');
    expect(completed?.response?.output).toEqual([
      {
        id: 'rs_0',
        type: 'reasoning',
        status: 'completed',
        summary: [],
        encrypted_content: 'enc-stream-only',
      },
    ]);
  });

  it('preserves richer image_generation_call fields while aggregating progress events', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');
    const streamContext = createStreamTransformContext('gpt-5');
    const usage = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    };

    serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.image_generation_call.partial_image',
        responsesPayload: {
          type: 'response.image_generation_call.partial_image',
          item_id: 'img_1',
          output_index: 0,
          partial_image_index: 0,
          partial_image_b64: 'partial',
          background: 'transparent',
          output_format: 'png',
          quality: 'high',
          size: '1024x1024',
        },
      },
    });

    const completedLines = serializeConvertedResponsesEvents({
      state,
      streamContext,
      usage,
      event: {
        responsesEventType: 'response.image_generation_call.completed',
        responsesPayload: {
          type: 'response.image_generation_call.completed',
          item_id: 'img_1',
          output_index: 0,
          result: 'final-image',
          background: 'transparent',
          output_format: 'png',
          quality: 'high',
          size: '1024x1024',
        },
      },
    });

    const payloads = parseSsePayloads(completedLines);
    const imageEvent = payloads.find((item) => item.type === 'response.image_generation_call.completed');
    expect(imageEvent).toBeTruthy();
    expect(state.outputItems[0]).toMatchObject({
      id: 'img_1',
      type: 'image_generation_call',
      status: 'completed',
      result: 'final-image',
      background: 'transparent',
      output_format: 'png',
      quality: 'high',
      size: '1024x1024',
      partial_images: [
        {
          partial_image_index: 0,
          partial_image_b64: 'partial',
        },
      ],
    });
  });
});
