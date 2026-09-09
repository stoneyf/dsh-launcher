/**
 * 模型测试：把客户端对话流式代理到本地 llama-server 的
 * OpenAI 兼容接口（/v1/chat/completions），并转为 SSE 输出。
 */
import { readConfig, llmBaseUrl } from './core.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 执行一次流式对话。
 * @param {{messages: Array<{role: string, content: string}>, model?: string, maxTokens?: number}} body
 * @param {(event: {type: string, data: any}) => void} emit - SSE 事件回调
 */
export async function chatTest(body, emit) {
  const cfg = readConfig()
  const model = body.model || undefined
  const request = {
    messages: body.messages ?? [],
    max_tokens: Number(body.maxTokens) || 1024,
    temperature: Number(body.temperature ?? 0.7),
    stream: true,
    stream_options: { include_usage: true },
    ...(model ? { model } : {}),
  }
  const started = Date.now()
  let res
  try {
    res = await fetch(`${llmBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.LLM_API_KEY}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    })
  } catch (error) {
    const e = new Error(`无法连接本地大模型（${llmBaseUrl()}）：${error.message}`)
    e.status = 503
    throw e
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const e = new Error(`本地大模型返回 HTTP ${res.status}：${text.slice(0, 300)}`)
    e.status = 502
    throw e
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let usage = null
  let finish = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(payload) } catch { continue }
      const choice = chunk.choices?.[0]
      if (chunk.usage) usage = chunk.usage
      if (choice?.delta?.content) {
        content += choice.delta.content
        emit({ type: 'delta', data: { text: choice.delta.content } })
      }
      if (choice?.delta?.reasoning_content) {
        reasoning += choice.delta.reasoning_content
        emit({ type: 'reasoning', data: { text: choice.delta.reasoning_content } })
      }
      if (choice?.finish_reason) finish = choice.finish_reason
    }
  }
  const elapsedSec = (Date.now() - started) / 1000
  const completionTokens = usage?.completion_tokens ?? null
  emit({
    type: 'done',
    data: {
      content,
      reasoning,
      finish,
      usage,
      elapsedSec: Math.round(elapsedSec * 10) / 10,
      tokensPerSec: completionTokens && elapsedSec > 0 ? Math.round(completionTokens / elapsedSec) : null,
    },
  })
  await sleep(0)
  return { content, reasoning, usage }
}
