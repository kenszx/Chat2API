/**
 * Anthropic ↔ OpenAI Format Converter
 * Converts between Anthropic Messages API and OpenAI Chat Completions API formats
 */

import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTextContent,
  AnthropicToolUseContent,
  AnthropicToolResultContent,
  AnthropicImageContent,
} from './types'
import type { ChatCompletionTool, ChatCompletionToolChoice } from '../types'

/**
 * Extract text content from a content block array or string
 */
function extractText(content: string | any[] | undefined | null): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text || '')
      .join('\n')
  }
  return ''
}

/**
 * Convert Anthropic image content block to OpenAI image_url format
 */
function anthropicImageToOpenAI(image: AnthropicImageContent): any {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${image.source.media_type};base64,${image.source.data}`,
    },
  }
}

/**
 * Convert Anthropic tool_use block to OpenAI tool_calls format
 */
function anthropicToolUseToOpenAI(toolUse: AnthropicToolUseContent): any {
  return {
    id: toolUse.id,
    type: 'function',
    function: {
      name: toolUse.name,
      arguments: JSON.stringify(toolUse.input),
    },
  }
}

/**
 * Convert Anthropic message content to OpenAI message content (string or array)
 */
function convertContentToOpenAI(
  content: string | AnthropicContentBlock[] | undefined | null
): string | any[] | null {
  if (!content) return null
  if (typeof content === 'string') return content

  const parts: any[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        parts.push(anthropicImageToOpenAI(block))
        break
      case 'tool_result': {
        const text = typeof block.content === 'string'
          ? block.content
          : block.content.map(c => c.text).join('\n')
        parts.push({ type: 'text', text: `[Tool Result: ${block.tool_use_id}]\n${text}` })
        break
      }
      case 'thinking':
        // Map thinking blocks as regular text content
        parts.push({ type: 'text', text: block.thinking })
        break
      case 'tool_use':
        // Tool use blocks are handled separately as tool_calls
        break
    }
  }
  return parts.length > 0 ? parts : null
}

/**
 * Convert Anthropic tool definition to OpenAI tool definition
 */
function convertToolToOpenAI(tool: {
  name: string
  description?: string
  input_schema: Record<string, any>
}): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema,
    },
  }
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice
 */
function convertToolChoiceToOpenAI(
  toolChoice?: AnthropicRequest['tool_choice']
): ChatCompletionToolChoice | undefined {
  if (!toolChoice) return undefined

  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      if (toolChoice.name) {
        return {
          type: 'function',
          function: { name: toolChoice.name },
        }
      }
      return 'auto'
    default:
      return undefined
  }
}

/**
 * Convert Anthropic Messages API request to OpenAI Chat Completions request
 */
export function convertAnthropicRequestToOpenAI(anthropicReq: AnthropicRequest): {
  model: string
  messages: any[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tools?: ChatCompletionTool[]
  tool_choice?: ChatCompletionToolChoice
  tool_format?: string
} {
  const openAIMessages: any[] = []

  // Handle system prompt
  if (anthropicReq.system) {
    const systemText = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : anthropicReq.system.map(b => b.text).join('\n')
    openAIMessages.push({ role: 'system', content: systemText })
  }

  // Convert messages
  for (const msg of anthropicReq.messages) {
    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : extractText(msg.content as AnthropicContentBlock[])

      // Extract tool_use blocks for tool_calls
      const toolCalls = Array.isArray(msg.content)
        ? msg.content
            .filter((b): b is AnthropicToolUseContent => b.type === 'tool_use')
            .map(anthropicToolUseToOpenAI)
        : undefined

      const assistantMsg: any = { role: 'assistant', content: content || null }
      if (toolCalls && toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      openAIMessages.push(assistantMsg)
    } else if (msg.role === 'user') {
      // User messages: convert content blocks to OpenAI format
      if (typeof msg.content === 'string') {
        openAIMessages.push({ role: 'user', content: msg.content })
      } else {
        // Check for tool_result blocks (shouldn't be in user messages, but handle gracefully)
        const hasImages = msg.content.some(b => b.type === 'image')
        if (hasImages) {
          const parts = msg.content.map(block => {
            if (block.type === 'image') return anthropicImageToOpenAI(block)
            if (block.type === 'text') return { type: 'text', text: block.text }
            if (block.type === 'tool_result') {
              const text = typeof block.content === 'string'
                ? block.content
                : block.content.map(c => c.text).join('\n')
              return { type: 'text', text: `[Tool Result: ${block.tool_use_id}]\n${text}` }
            }
            return { type: 'text', text: '' }
          }).filter(p => p.text !== '' || p.type === 'image_url')
          openAIMessages.push({ role: 'user', content: parts })
        } else {
          const text = extractText(msg.content)
          openAIMessages.push({ role: 'user', content: text || '' })
        }
      }
    }
  }

  // Convert tools
  const tools = anthropicReq.tools?.map(convertToolToOpenAI)
  const toolChoice = convertToolChoiceToOpenAI(anthropicReq.tool_choice)

  return {
    model: anthropicReq.model,
    messages: openAIMessages,
    max_tokens: anthropicReq.max_tokens,
    stream: anthropicReq.stream,
    temperature: anthropicReq.temperature,
    top_p: anthropicReq.top_p,
    stop: anthropicReq.stop_sequences,
    tools,
    tool_choice: toolChoice,
    tool_format: tools && tools.length > 0 ? 'native' : undefined,
  }
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
function mapFinishReason(finishReason: string | null): AnthropicResponse['stop_reason'] {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return null
    default:
      return null
  }
}

/**
 * Convert OpenAI chat completion response content to Anthropic content blocks
 */
function convertOpenAIContentToAnthropicBlocks(
  message: any
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []

  // Add thinking block if reasoning_content exists
  if (message.reasoning_content) {
    blocks.push({
      type: 'thinking',
      thinking: message.reasoning_content,
    })
  }

  // Add text block if content exists
  if (message.content) {
    blocks.push({
      type: 'text',
      text: message.content,
    })
  }

  // Add tool_use blocks if tool_calls exist
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input: Record<string, any> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = { _raw: tc.function.arguments }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

/**
 * Convert OpenAI Chat Completions response to Anthropic Messages API response
 */
export function convertOpenAIResponseToAnthropic(
  response: any,
  model: string
): AnthropicResponse {
  const choice = response.choices?.[0]
  const message = choice?.message || {}

  const content = convertOpenAIContentToAnthropicBlocks(message)

  return {
    id: response.id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model || model,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    },
  }
}

/**
 * Estimate token count from text (rough approximation)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimate input tokens from OpenAI request messages for Anthropic usage field
 */
export function estimateInputTokens(messages: any[]): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          total += estimateTokens(part.text)
        } else if (part.type === 'image_url') {
          total += 100 // rough estimate per image
        }
      }
    }
    total += 4 // overhead per message
  }
  return total
}
