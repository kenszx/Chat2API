/**
 * Proxy Service Module - Anthropic Messages Route
 * Implements /v1/messages endpoint (Anthropic Messages API format)
 * Converts incoming Anthropic requests to internal OpenAI format and forwards
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import type { AnthropicRequest, AnthropicResponse, AnthropicErrorResponse } from '../anthropic/types'
import { convertAnthropicRequestToOpenAI, convertOpenAIResponseToAnthropic, estimateInputTokens } from '../anthropic/converter'
import { AnthropicStreamTransform, createAnthropicErrorStream } from '../anthropic/stream'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { streamHandler } from '../stream'
import { storeManager } from '../../store/store'

const router = new Router({ prefix: '/v1' })

/**
 * Generate Anthropic-style message ID
 */
function generateMessageId(): string {
  const random = Math.random().toString(36).slice(2, 15)
  return `msg_${random}${Date.now().toString(36)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return (ctx.headers['x-real-ip'] as string) ||
    (ctx.headers['x-forwarded-for'] as string) ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages for logging
 */
function extractUserInput(messages: AnthropicRequest['messages']): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find(b => b.type === 'text')
        if (textBlock && 'text' in textBlock) return (textBlock as any).text
      }
    }
  }
  return undefined
}

/**
 * POST /v1/messages - Anthropic Messages API compatible endpoint
 */
router.post('/messages', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateMessageId()
  const clientIP = getClientIP(ctx)

  let anthropicReq: AnthropicRequest
  try {
    anthropicReq = ctx.request.body as AnthropicRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Invalid request body',
      },
    } satisfies AnthropicErrorResponse
    return
  }

  // Validate required fields
  if (!anthropicReq.model) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Missing required field: model',
      },
    } satisfies AnthropicErrorResponse
    return
  }

  if (!anthropicReq.messages || !Array.isArray(anthropicReq.messages) || anthropicReq.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Missing required field: messages',
      },
    } satisfies AnthropicErrorResponse
    return
  }

  if (!anthropicReq.max_tokens) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Missing required field: max_tokens',
      },
    } satisfies AnthropicErrorResponse
    return
  }

  // Convert Anthropic request to OpenAI format
  const openAIReq = convertAnthropicRequestToOpenAI(anthropicReq)

  // Get provider selection
  const preferredProviderId = modelMapper.getPreferredProvider(anthropicReq.model)
  const preferredAccountId = modelMapper.getPreferredAccount(anthropicReq.model)

  const selection = loadBalancer.selectAccount(
    anthropicReq.model,
    storeManager.getConfig().loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      type: 'error',
      error: {
        type: 'service_unavailable_error',
        message: `No available account for model: ${anthropicReq.model}`,
      },
    } satisfies AnthropicErrorResponse
    return
  }

  const { account, provider, actualModel } = selection

  const inputTokens = estimateInputTokens(openAIReq.messages)

  proxyStatusManager.recordRequestStart(anthropicReq.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      openAIReq,
      account,
      provider,
      actualModel,
      {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: anthropicReq.model,
        actualModel,
        startTime,
        isStream: anthropicReq.stream || false,
        clientIP,
      }
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      if (result.status && result.status >= 400 && result.status !== 429) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      ctx.body = {
        type: 'error',
        error: {
          type: 'api_error',
          message: result.error || 'Request failed',
        },
      } satisfies AnthropicErrorResponse

      storeManager.addLog('error', `Anthropic request failed: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: anthropicReq.model,
        latency,
      })
      return
    }

    loadBalancer.clearAccountFailure(account.id)
    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    // Handle streaming response
    if (anthropicReq.stream && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const anthropicStream = new AnthropicStreamTransform(
        requestId,
        anthropicReq.model,
        inputTokens
      )

      // Collect log content
      let collectedContent = ''

      if (result.skipTransform) {
        // Stream already in OpenAI SSE format, pipe through Anthropic transform
        result.stream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })
        result.stream.pipe(anthropicStream)
        result.stream.once('end', () => {
          // Log the transformed content summary
          storeManager.addLog('debug', `Anthropic stream completed`, { requestId })
        })
      } else {
        // Need standard transform first, then Anthropic transform
        const transformStream = streamHandler.createTransformStream(
          actualModel,
          requestId
        )
        transformStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })
        result.stream.pipe(transformStream)
        transformStream.pipe(anthropicStream)
      }

      ctx.body = anthropicStream

      // Handle stream errors
      result.stream.once('error', (err: Error) => {
        console.error('[Messages] Stream error:', err.message)
        const errorStream = createAnthropicErrorStream(requestId, anthropicReq.model, err.message)
        anthropicStream.unpipe()
        errorStream.pipe(ctx.res as any)
      })
    } else {
      // Non-streaming response
      ctx.set('Content-Type', 'application/json')

      if (result.body) {
        const anthropicResponse = convertOpenAIResponseToAnthropic(
          result.body,
          anthropicReq.model
        )

        // Override ID with our generated request ID for consistency
        anthropicResponse.id = requestId

        ctx.body = anthropicResponse
      } else {
        // Empty response - return minimal response
        ctx.body = {
          id: requestId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: anthropicReq.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        } satisfies AnthropicResponse
      }
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    ctx.status = 500
    ctx.body = {
      type: 'error',
      error: {
        type: 'internal_error',
        message: errorMessage,
      },
    } satisfies AnthropicErrorResponse

    storeManager.addLog('error', `Anthropic request exception: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: anthropicReq.model,
      latency,
    })
  }
})

export default router
