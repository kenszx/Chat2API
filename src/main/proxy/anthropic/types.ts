/**
 * Anthropic Messages API Types
 * Defines types for Anthropic API format compatibility
 */

// Content blocks
export interface AnthropicTextContent {
  type: 'text'
  text: string
}

export interface AnthropicImageContent {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export interface AnthropicThinkingContent {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface AnthropicToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface AnthropicToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string | AnthropicTextContent[]
  is_error?: boolean
}

export type AnthropicContentBlock =
  | AnthropicTextContent
  | AnthropicImageContent
  | AnthropicThinkingContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent

// Messages
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

// Request
export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicTextContent[]
  max_tokens: number
  metadata?: Record<string, string>
  stop_sequences?: string[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: AnthropicToolDefinition[]
  tool_choice?: {
    type: 'auto' | 'any' | 'tool'
    name?: string
    disable_parallel_tool_use?: boolean
  }
}

export interface AnthropicToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, any>
}

// Non-streaming response
export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

// Streaming event types
export interface AnthropicMessageStartEvent {
  type: 'message_start'
  message: AnthropicResponse
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
    stop_sequence: string | null
  }
  usage: {
    output_tokens: number
  }
}

export interface AnthropicMessageStopEvent {
  type: 'message_stop'
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block: AnthropicContentBlock
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'signature_delta'; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent

// Error response
export interface AnthropicErrorResponse {
  type: 'error'
  error: {
    type: string
    message: string
  }
}
