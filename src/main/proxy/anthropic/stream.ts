/**
 * Anthropic SSE Stream Converter
 * Transforms OpenAI SSE stream format to Anthropic Messages API SSE format
 */

import { Transform, PassThrough } from 'stream'
import type { AnthropicResponse, AnthropicStreamEvent } from './types'
import { estimateInputTokens } from './converter'

/**
 * Format an Anthropic SSE event
 */
function formatSSE(eventType: string, data: any): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Interface for the state of the Anthropic stream converter
 */
interface StreamState {
  messageId: string
  model: string
  createdTime: number
  blockIndex: number
  hasStartedMessage: boolean
  currentBlockType: 'thinking' | 'text' | 'tool_use' | null
  currentBlockIndex: number
  toolCallBuffers: Map<number, { id: string; name: string; arguments: string }>
  totalOutputTokens: number
  inputTokens: number
  isFinished: boolean
  hasReasoning: boolean
  accumulatedText: string
}

/**
 * Anthropic Stream Transform
 * Converts OpenAI SSE stream chunks to Anthropic Messages API SSE format
 */
export class AnthropicStreamTransform extends Transform {
  private state: StreamState
  private buffer: string = ''
  private sseParser: { parse: (data: string) => Array<{ event?: string; data: string }> }

  constructor(
    messageId: string,
    model: string,
    inputTokens: number = 0
  ) {
    super({ objectMode: true })

    this.state = {
      messageId,
      model,
      createdTime: Math.floor(Date.now() / 1000),
      blockIndex: 0,
      hasStartedMessage: false,
      currentBlockType: null,
      currentBlockIndex: -1,
      toolCallBuffers: new Map(),
      totalOutputTokens: 0,
      inputTokens,
      isFinished: false,
      hasReasoning: false,
      accumulatedText: '',
    }

    // SSE parser: incoming data has already been line-buffered by _transform
    this.sseParser = {
      parse: (data: string) => {
        const events: Array<{ event?: string; data: string }> = []
        const lines = data.split('\n')
        let currentEvent: { event?: string; data: string } = { data: '' }

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const value = line.slice(6)
            if (value === '[DONE]') {
              if (currentEvent.data) {
                events.push(currentEvent)
                currentEvent = { data: '' }
              }
              continue
            }
            currentEvent.data = value
          } else if (line === '') {
            if (currentEvent.data) {
              events.push(currentEvent)
              currentEvent = { data: '' }
            }
          }
        }
        // Push final event if data exists (no trailing newline)
        if (currentEvent.data) {
          events.push(currentEvent)
        }
        return events
      },
    }
  }

  /**
   * Start the message by emitting message_start event
   */
  private startMessage(): void {
    if (this.state.hasStartedMessage) return
    this.state.hasStartedMessage = true

    const initialContent: any[] = []

    // Pre-declare content blocks if we know the types
    // We'll know after first reasoning_content or content appears
    const msg: any = {
      id: this.state.messageId,
      type: 'message',
      role: 'assistant',
      content: initialContent,
      model: this.state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: this.state.inputTokens,
        output_tokens: 1,
      },
    }

    this.push(formatSSE('message_start', { type: 'message_start', message: msg }))
  }

  /**
   * Start a new content block
   */
  private startContentBlock(type: 'thinking' | 'text' | 'tool_use', data?: any): void {
    // Close any existing block first
    this.closeCurrentBlock()

    this.state.currentBlockType = type
    this.state.currentBlockIndex = this.state.blockIndex++

    let contentBlock: any

    switch (type) {
      case 'thinking':
        contentBlock = { type: 'thinking', thinking: '' }
        break
      case 'text':
        contentBlock = { type: 'text', text: '' }
        break
      case 'tool_use':
        contentBlock = {
          type: 'tool_use',
          id: data?.id || `toolu_${Date.now().toString(36)}`,
          name: data?.name || '',
          input: data?.input || {},
        }
        break
    }

    this.push(
      formatSSE('content_block_start', {
        type: 'content_block_start',
        index: this.state.currentBlockIndex,
        content_block: contentBlock,
      })
    )
  }

  /**
   * Close the currently open content block
   */
  private closeCurrentBlock(): void {
    if (this.state.currentBlockType === null) return

    this.push(
      formatSSE('content_block_stop', {
        type: 'content_block_stop',
        index: this.state.currentBlockIndex,
      })
    )

    this.state.currentBlockType = null
    this.state.currentBlockIndex = -1
  }

  /**
   * Handle text delta
   */
  private handleTextDelta(text: string): void {
    if (this.state.currentBlockType !== 'text') {
      this.startContentBlock('text')
    }
    this.push(
      formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.state.currentBlockIndex,
        delta: { type: 'text_delta', text },
      })
    )
    this.state.totalOutputTokens += estimateTokenCount(text)
  }

  /**
   * Handle reasoning_content delta → thinking block
   */
  private handleReasoningDelta(thinking: string): void {
    this.state.hasReasoning = true
    if (this.state.currentBlockType !== 'thinking') {
      this.startContentBlock('thinking')
    }
    this.push(
      formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.state.currentBlockIndex,
        delta: { type: 'thinking_delta', thinking },
      })
    )
    this.state.totalOutputTokens += estimateTokenCount(thinking)
  }

  /**
   * Handle tool_calls delta
   */
  private handleToolCallsDelta(toolCalls: any[]): void {
    for (const tc of toolCalls) {
      const index = tc.index ?? 0

      if (!this.state.toolCallBuffers.has(index)) {
        // New tool call - start a content block
        // Close text block if open, but keep thinking block
        if (this.state.currentBlockType === 'text') {
          this.closeCurrentBlock()
        }

        this.state.toolCallBuffers.set(index, {
          id: tc.id || `toolu_${Date.now().toString(36)}_${index}`,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '',
        })

        this.startContentBlock('tool_use', {
          id: tc.id,
          name: tc.function?.name,
        })
      } else {
        // Update existing tool call buffer
        const buf = this.state.toolCallBuffers.get(index)!
        if (tc.id) buf.id = tc.id
        if (tc.function?.name) buf.name = tc.function.name
        if (tc.function?.arguments) {
          buf.arguments += tc.function.arguments
        }

        // For subsequent deltas, ensure we're in tool_use mode
        if (this.state.currentBlockType !== 'tool_use') {
          this.startContentBlock('tool_use', {
            id: buf.id,
            name: buf.name,
          })
        }

        // Emit the argument delta
        if (tc.function?.arguments) {
          this.push(
            formatSSE('content_block_delta', {
              type: 'content_block_delta',
              index: this.state.currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            })
          )
        }
      }
    }
  }

  /**
   * Handle finish (message_delta + message_stop)
   */
  private handleFinish(finishReason: string | null): void {
    if (this.state.isFinished) return
    this.state.isFinished = true

    // Close all open content blocks
    this.closeCurrentBlock()

    // Close any remaining tool call blocks
    if (this.state.toolCallBuffers.size > 0) {
      // All tool blocks should already be closed by closeCurrentBlock
      this.state.toolCallBuffers.clear()
    }

    // Map finish reason
    let stopReason: string | null = null
    switch (finishReason) {
      case 'stop':
        stopReason = 'end_turn'
        break
      case 'tool_calls':
        stopReason = 'tool_use'
        break
      case 'length':
        stopReason = 'max_tokens'
        break
      default:
        stopReason = finishReason || 'end_turn'
    }

    this.push(
      formatSSE('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.state.totalOutputTokens || 1,
        },
      })
    )

    this.push(
      formatSSE('message_stop', { type: 'message_stop' })
    )
  }

  _transform(chunk: Buffer, encoding: string, callback: Function): void {
    try {
      this.buffer += chunk.toString()
      // Split into lines, keeping the last partial line in buffer
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || ''
      const completeData = lines.join('\n')

      const events = this.sseParser.parse(completeData)

      for (const event of events) {
        if (!event.data) continue

        let parsed: any
        try {
          parsed = JSON.parse(event.data)
        } catch {
          continue
        }

        const choice = parsed.choices?.[0]
        if (!choice) continue

        const delta = choice.delta || {}

        // Emit message_start on first meaningful chunk
        if (!this.state.hasStartedMessage) {
          this.startMessage()
        }

        // Handle reasoning_content
        if (delta.reasoning_content) {
          this.handleReasoningDelta(delta.reasoning_content)
        }

        // Handle regular content
        if (delta.content) {
          this.handleTextDelta(delta.content)
        }

        // Handle tool_calls
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          this.handleToolCallsDelta(delta.tool_calls)
        }

        // Handle finish_reason
        if (choice.finish_reason) {
          this.handleFinish(choice.finish_reason)
        }
      }

      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback: Function): void {
    // If we haven't finished yet, close gracefully
    if (!this.state.isFinished) {
      if (!this.state.hasStartedMessage) {
        this.startMessage()
      }
      this.handleFinish('stop')
    }
    callback()
  }
}

/**
 * Estimate token count from text
 */
function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Create a PassThrough stream that emits Anthropic-formatted SSE for error responses
 */
export function createAnthropicErrorStream(
  messageId: string,
  model: string,
  errorMessage: string
): PassThrough {
  const stream = new PassThrough()

  const errorEvent = {
    type: 'error',
    error: {
      type: 'api_error',
      message: errorMessage,
    },
  }

  stream.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
  stream.end()

  return stream
}
