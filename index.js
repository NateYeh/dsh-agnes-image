/**
 * agnes-image — Host 半邊。
 *
 * 提供兩件事：
 *   1. `agnes_generate_image` Agent 工具（經 ctx.tools 註冊）。
 *   2. Web 面板用的兩個 JSON 路由（由 client.js fetch）：
 *        GET  /local/agnes-image/status   → 這個 profile 是否已備妥 API key
 *        POST /local/agnes-image/generate → 依 prompt／參考圖呼叫 Agnes API，回傳圖片 URL
 *
 * 路由刻意用 `/local/agnes-image` 前綴：profile 裡若另有 `dsh-plugin-agnes-image`
 * （會用 `/agnes-image/generate`），避免 `webServer.register` 的 duplicate 例外。
 *
 * API 契約（Agnes 官方文件）：POST {baseURL}/v1/images/generations
 *   Authorization: Bearer <key>、Content-Type: application/json
 *   body { model, prompt, size, ratio?, extra_body: { response_format: 'url', image? } }
 *   回應 { created, data: [{ url, b64_json, revised_prompt }] }
 *
 * @module @local/agnes-image
 */

/** tools 是硬依賴：沒有它就沒有工具可註冊（屬性存取需要 inject 才會接上）。 */
export const inject = ['tools']

/** 面板用的路由前綴。 */
const ROUTE_PREFIX = '/local/agnes-image'

/** Agnes 生圖端點與模型。 */
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com'
const DEFAULT_MODEL = 'agnes-image-2.5-flash'
const MODELS = ['agnes-image-2.5-flash', 'agnes-image-2.1-flash']
const SIZES = ['1K', '2K', '3K', '4K']
const RATIOS = ['1:1', '4:3', '3:2', '16:9', '21:9', '3:4', '2:3', '9:16']

/** 工具與面板共用的上限（官方建議客戶端 60s–360s）。 */
const DEFAULT_TIMEOUT_MS = 240000
const MAX_TIMEOUT_MS = 360000

/** 圖生圖：參考圖格式與數量。官方只收公開 https URL 或 data:image base64。 */
const MAX_IMAGES = 8
const IMAGE_URL_RE = /^https?:\/\/\S+$/i
const IMAGE_DATA_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i

/** 請求內容上限：參考圖 base64 會撐大 body。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 讀 config 並套預設值；config 來自 bundle patch 或 profile 覆寫。 */function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const timeout = Number(raw.timeoutMs)
  return {
    baseURL: String(raw.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: MODELS.includes(raw.model) ? raw.model : DEFAULT_MODEL,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
  }
}

/** 這個 Host 目前能用的 key：config 優先，其次環境變數。 */
function configuredKey(cfg) {
  return cfg.apiKey || String(process.env.AGNES_API_KEY || '').trim()
}

/**
 * 面板填過、只留在 Host 記憶體的 key（重啟即消失）。
 * 讓「面板生過一次圖」之後 Agent 工具也能用同一個 key，不必另外設環境變數。
 */
let panelKey = ''

/** 面板填過、只留在 Host 記憶體的上游地址（重啟即消失）。 */
let panelBaseURL = ''

/**
 * 正規化上游地址：只收 http(s)、去掉尾斜線、拒絕帳密。
 * @param {unknown} candidate 使用者輸入；空字串代表用 fallback。
 * @param {string} fallback 沒填時採用的預設地址。
 * @returns {string} 例如 `https://apihub.agnes-ai.com`（不含結尾斜線）。
 */
function normalizeBaseURL(candidate, fallback) {
  const value = typeof candidate === 'string' ? candidate.trim() : ''
  if (!value) return fallback
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`上游地址不是合法 URL：${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('上游地址只接受 http(s)')
  if (url.username || url.password) throw new Error('上游地址不可包含帳號密碼，請改填在 API key 欄位')
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '/' ? '' : path}`
}

/**
 * 把上游地址接成生圖端點；結尾已經是 /v1 就只補 /images/generations，
 * 讓自架的 OpenAI 相容 gateway（常見結尾 /v1）也能直接填。
 */
function generationEndpoint(baseURL) {
  return /\/v1$/i.test(baseURL) ? `${baseURL}/images/generations` : `${baseURL}/v1/images/generations`
}

/** 只接受白名單值；不合法就回退，避免把奇怪字串送到 API。 */
function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 驗證參考圖清單（圖生圖／多圖合成）。
 * @param {unknown} input 面板的 `images` 或工具參數的 `image`。
 * @returns {string[]} 合法的圖片 URL／data URI。
 */
function normalizeImages(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('參考圖必須是陣列')
  if (input.length > MAX_IMAGES) throw new Error(`參考圖最多 ${MAX_IMAGES} 張`)
  const images = []
  for (const entry of input) {
    if (typeof entry !== 'string') throw new Error('參考圖每一項都必須是字串')
    const value = entry.trim()
    if (!value) continue
    if (!IMAGE_URL_RE.test(value) && !IMAGE_DATA_RE.test(value)) {
      throw new Error('參考圖必須是公開的 http(s) 圖片 URL，或 data:image/... base64')
    }
    images.push(value)
  }
  return images
}

/**
 * 呼叫 Agnes 生圖 API。
 * @param {ReturnType<typeof resolveConfig>} cfg 解析後的設定。
 * @param {{ prompt?: string, model?: string, size?: string, ratio?: string, apiKey?: string, baseURL?: string, images?: string[], image?: string[] }} input 這次請求。
 * @returns {Promise<{ url: string, model: string, size: string, ratio: string, mode: string, created: number, endpoint: string }>}
 */
async function generateImage(cfg, input) {
  const request = input && typeof input === 'object' ? input : {}
  const prompt = String(request.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不可為空')
  const apiKey = String(request.apiKey || '').trim() || configuredKey(cfg) || panelKey
  if (!apiKey) throw new Error('尚未設定 Agnes API key：在面板填入，或設定 AGNES_API_KEY 環境變數／插件 config 的 apiKey')

  const requestedBase = typeof request.baseURL === 'string' ? request.baseURL.trim() : ''
  const baseURL = normalizeBaseURL(requestedBase, panelBaseURL || cfg.baseURL)
  if (requestedBase) panelBaseURL = baseURL
  const endpoint = generationEndpoint(baseURL)

  const model = pick(request.model, MODELS, cfg.model)
  const size = pick(request.size, SIZES, '1K')
  const ratio = pick(request.ratio, RATIOS, '1:1')
  const images = normalizeImages(request.images === undefined ? request.image : request.images)
  // response_format 只能放 extra_body；有參考圖時 image 也放 extra_body。
  const extraBody = { response_format: 'url' }
  if (images.length > 0) extraBody.image = images
  const body = { model, prompt, size, extra_body: extraBody }
  if (ratio !== '1:1') body.ratio = ratio

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(`Agnes API 逾時（${Math.round(cfg.timeoutMs / 1000)}s）`)
      throw new Error(`無法連線到 Agnes API：${error && error.message ? error.message : error}`)
    }

    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail = (payload && ((payload.error && payload.error.message) || payload.message)) || text.slice(0, 300)
      throw new Error(`Agnes API ${response.status}：${detail || '沒有錯誤訊息'}`)
    }
    const item = payload && Array.isArray(payload.data) ? payload.data[0] : undefined
    if (!item) throw new Error('Agnes API 回應缺少 data[0]')
    const url = typeof item.url === 'string' && item.url ? item.url : item.b64_json ? `data:image/png;base64,${item.b64_json}` : ''
    if (!url) throw new Error('Agnes API 既沒有回傳 url 也沒有 b64_json')
    return {
      url,
      model,
      size,
      ratio,
      mode: images.length > 1 ? 'multi-image' : images.length === 1 ? 'image-to-image' : 'text-to-image',
      endpoint,
      created: Number(payload.created) || 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 在 Cordis effect 裡註冊，卸載時自動解除；環境沒有 ctx.effect 就直接註冊。
 * @param {import('cordis').Context} ctx Cordis context。
 * @param {() => (() => void) | void} factory 回傳 disposer 的註冊動作。
 * @param {string} label effect 標籤（錯誤訊息用）。
 */
function registerEffect(ctx, factory, label) {
  if (typeof ctx.effect === 'function') return ctx.effect(factory, label)
  return factory()
}

/** 註冊 Agent 工具（與面板走同一個 generateImage）。 */
function registerTool(ctx, tools, cfg) {
  const definition = {
    name: 'agnes_generate_image',
    description: '使用 Agnes AI 生成或改圖（agnes-image-2.5-flash）：給文字提示就文生圖，附參考圖就圖生圖／多圖合成，回傳可公開存取的圖片 URL。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '圖片描述；改圖時寫「要改什麼＋要保留什麼」。建議依序寫：主體、場景、風格、光線、構圖、品質要求。' },
        size: { type: 'string', enum: SIZES, description: '輸出解析度等級（1K/2K/3K/4K），預設 1K。' },
        ratio: { type: 'string', enum: RATIOS, description: '長寬比，預設 1:1。' },
        image: {
          type: 'array',
          items: { type: 'string' },
          description: '參考圖（圖生圖／多圖合成）：公開 https 圖片 URL 或 data:image/... base64，最多 8 張；多張即多圖合成。',
        },
        baseURL: {
          type: 'string',
          description: '選填：自訂上游地址（OpenAI 相容 gateway，可含 /v1）。留空則用插件設定的預設（https://apihub.agnes-ai.com）。',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          model: { type: 'string' },
          size: { type: 'string' },
          ratio: { type: 'string' },
        },
        required: ['url'],
      },
      render: (_args, value) => [
        { type: 'text', text: `圖片已生成（${value.model} ${value.size} ${value.ratio}）：\n${value.url}` },
      ],
    },
    timeoutMs: cfg.timeoutMs + 15000,
    async execute(args) {
      const result = await generateImage(cfg, args)
      return { url: result.url, model: result.model, size: result.size, ratio: result.ratio, mode: result.mode }
    },
  }
  registerEffect(ctx, () => tools.register(definition), 'agnes-image: agnes_generate_image')
}

/** 以 Host 的連線政策檢查瀏覽器請求（沿用 DSH 的 cookie／Host／Origin 判定）。 */
function requestRejection(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (!connection || typeof connection.requestRejection !== 'function') return 503
    return connection.requestRejection({ headers: req.headers })
  } catch {
    return 503
  }
}

/**
 * 讀 JSON body（上限 32 MB，容得下參考圖 base64）。
 * @returns {Promise<{ ok: boolean, tooLarge: boolean, value: Record<string, unknown> }>}
 *   格式錯誤時 value 為空物件，由呼叫端回 400；超過上限時 tooLarge 為 true。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = ''
    let tooLarge = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true
        body = ''
        finish({ ok: false, tooLarge: true, value: {} })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        finish({ ok: true, tooLarge: false, value: JSON.parse(body || '{}') })
      } catch {
        finish({ ok: true, tooLarge: false, value: {} })
      }
    })
    req.on('error', () => finish({ ok: !tooLarge, tooLarge, value: {} }))
    req.on('close', () => finish({ ok: !tooLarge, tooLarge, value: {} }))
  })
}

/** 註冊面板用的兩個路由。 */
function registerRoutes(ctx, webServer, cfg) {
  const send = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const guard = (handler) => (req, res) => {
    const rejection = requestRejection(ctx, req)
    if (rejection !== undefined) {
      send(res, rejection, { ok: false, error: rejection === 503 ? 'authentication unavailable' : 'request rejected' })
      return
    }
    try {
      const outcome = handler(req, res)
      if (outcome && typeof outcome.catch === 'function') {
        outcome.catch((error) => {
          ctx.logger.warn(`[agnes-image] 路由處理失敗: ${error && error.stack ? error.stack : error}`)
          if (!res.headersSent) send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
        })
      }
    } catch (error) {
      ctx.logger.warn(`[agnes-image] 路由處理失敗: ${error && error.stack ? error.stack : error}`)
      if (!res.headersSent) send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  registerEffect(ctx, () => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: guard((req, res) => {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })
      return send(res, 200, {
        ok: true,
        hasKey: Boolean(configuredKey(cfg) || panelKey),
        model: cfg.model,
        baseURL: panelBaseURL || cfg.baseURL,
        defaultBaseURL: cfg.baseURL,
      })
    }),
  }), 'agnes-image: status route')

  registerEffect(ctx, () => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/generate`,
    handler: guard(async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const parsed = await readJsonBody(req)
      if (parsed.tooLarge) {
        return send(res, 413, { ok: false, error: '請求內容過大（上限 32 MB）：請縮小參考圖，或改用圖片 URL' })
      }
      const input = parsed.value
      if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return send(res, 400, { ok: false, error: 'prompt 不可為空' })
      }
      if (typeof input.apiKey === 'string' && input.apiKey.trim()) panelKey = input.apiKey.trim()
      try {
        const result = await generateImage(cfg, input)
        return send(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        const upstream = /^Agnes API \d{3}/.test(message)
        return send(res, upstream ? 502 : 400, { ok: false, error: message })
      }
    }),
  }), 'agnes-image: generate route')
}

/**
 * 插件進入點。
 * @param {import('cordis').Context} ctx Cordis context。
 * @param {Record<string, unknown>} [config] bundle patch／profile 覆寫的設定。
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined)

  if (!tools) {
    ctx.logger.warn('[agnes-image] tools 服務不可用，略過工具註冊')
  } else {
    try {
      registerTool(ctx, tools, cfg)
    } catch (error) {
      // 工具註冊失敗不該拖垮路由：面板仍要能用。
      ctx.logger.warn(`[agnes-image] 工具註冊失敗: ${error && error.message ? error.message : error}`)
    }
  }

  let routesRegistered = false
  const tryRegisterRoutes = () => {
    if (routesRegistered) return
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (!webServer) return
    try {
      registerRoutes(ctx, webServer, cfg)
      routesRegistered = true
    } catch (error) {
      ctx.logger.warn(`[agnes-image] 路由註冊失敗: ${error && error.message ? error.message : error}`)
    }
  }
  tryRegisterRoutes()
  const retry = setInterval(tryRegisterRoutes, 1000)
  retry.unref?.()
  ctx.effect?.(() => () => clearInterval(retry), 'agnes-image: retry timer')
}
