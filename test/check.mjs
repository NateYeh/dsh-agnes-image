// 插件自檢腳本（不屬於 bundle 的 files 清單）：驗證 Host 路由／工具與 Client 元件渲染。
// 用法：node test/check.mjs
import { PassThrough } from 'node:stream'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginUrl = new URL('../index.js', import.meta.url).href
const clientUrl = new URL('../client.js', import.meta.url).href
const OUT_DIR = join(tmpdir(), 'agnes-image-selfcheck')
const ALT_DIR = join(tmpdir(), 'agnes-image-selfcheck-alt')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

// ---------- Host 半邊 ----------
const plugin = await import(pluginUrl)

const routes = new Map()
const state = { tool: null, rejection: undefined }
const tools = {
  register(definition) {
    state.tool = definition
    return () => {}
  },
}
const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => {}
  },
}
const connection = { requestRejection: () => state.rejection }
const ctx = {
  tools,
  webServer,
  connection,
  get: (name) => ({ tools, webServer, connection })[name],
  effect: (fn) => fn(),
  logger: { warn: (...a) => console.warn('[warn]', ...a), info: () => {}, debug: () => {} },
}

plugin.apply(ctx, { baseURL: 'https://apihub.agnes-ai.com', model: 'agnes-image-2.5-flash', apiKey: '', outDir: OUT_DIR, timeoutMs: 20000 })

check('註冊兩個路由', routes.has('/local/agnes-image/status') && routes.has('/local/agnes-image/generate'))
check('註冊工具', Boolean(state.tool) && state.tool.name === 'agnes_generate_image')
check('工具參數必填 prompt', state.tool.parameters.required.includes('prompt'))

const makeRes = () => ({
  headersSent: false,
  writeHead(status) { this.status = status; this.headersSent = true },
  end(text) { this.body = text; this.done?.(text) },
})
const call = (path, method, body) => new Promise((resolve) => {
  const req = new PassThrough()
  req.method = method
  req.url = path
  req.headers = {}
  const res = makeRes()
  res.done = () => resolve({ status: res.status, json: JSON.parse(res.body || '{}') })
  routes.get(path).handler(req, res)
  if (body === undefined) req.end()
  else req.end(JSON.stringify(body))
})

const status = await call('/local/agnes-image/status', 'GET')
check('status：沒有 key 時 hasKey=false', status.status === 200 && status.json.hasKey === false, JSON.stringify(status.json))

const emptyPrompt = await call('/local/agnes-image/generate', 'POST', { prompt: '   ' })
check('空 prompt 回 400', emptyPrompt.status === 400, JSON.stringify(emptyPrompt.json))

const noKey = await call('/local/agnes-image/generate', 'POST', { prompt: 'test' })
check('沒有 key 回 400 且說明', noKey.status === 400 && /API key/.test(noKey.json.error), JSON.stringify(noKey.json))

let toolError = ''
try {
  await state.tool.execute({ prompt: 'test' })
} catch (error) {
  toolError = String(error.message)
}
check('工具無 key 時拒絕', /API key/.test(toolError), toolError)

const badKey = await call('/local/agnes-image/generate', 'POST', { prompt: 'test', apiKey: 'probe-invalid-key' })
check('無效 key 轉成 502 並帶 Agnes 訊息', badKey.status === 502 && /401/.test(badKey.json.error), JSON.stringify(badKey.json))

const afterPanelKey = await call('/local/agnes-image/status', 'GET')
check('面板填過 key 後 status 回 hasKey=true（僅記憶體）', afterPanelKey.json.hasKey === true, JSON.stringify(afterPanelKey.json))

state.rejection = 403
const rejected = await call('/local/agnes-image/generate', 'POST', { prompt: 'test' })
check('連線政策拒絕時回 403', rejected.status === 403, JSON.stringify(rejected.json))
state.rejection = undefined

// 圖生圖：用假的 fetch 檢查實際送出的請求 body，不打真 API。
const realFetch = globalThis.fetch
let capturedBody = null
let capturedUrl = ''
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
globalThis.fetch = async (url, init) => {
  if (init && init.method === 'POST') {
    capturedUrl = String(url)
    capturedBody = JSON.parse(String(init.body))
    return new Response(JSON.stringify({ created: 1, data: [{ url: 'https://example.com/out.png' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
}
const img2img = await call('/local/agnes-image/generate', 'POST', {
  prompt: '改成夜景，保留構圖',
  apiKey: 'k',
  images: ['https://example.com/in.png'],
})
check('圖生圖：image 放進 extra_body', img2img.status === 200 && capturedBody.extra_body.image[0] === 'https://example.com/in.png', JSON.stringify(capturedBody))
check('圖生圖：結果標成 image-to-image', img2img.json.mode === 'image-to-image', JSON.stringify(img2img.json))

const multi = await call('/local/agnes-image/generate', 'POST', {
  prompt: '兩張角色合成一張',
  apiKey: 'k',
  images: ['https://example.com/a.png', 'https://example.com/b.png'],
})
check('多圖合成：兩張都送、模式為 multi-image', multi.json.mode === 'multi-image' && capturedBody.extra_body.image.length === 2, JSON.stringify(capturedBody.extra_body))

const b64 = await call('/local/agnes-image/generate', 'POST', {
  prompt: '改顏色',
  apiKey: 'k',
  images: ['data:image/png;base64,AAAA'],
})
check('data URI 參考圖可送出', b64.status === 200 && capturedBody.extra_body.image[0].startsWith('data:image/png;base64,'), JSON.stringify(capturedBody.extra_body))

const customBase = await call('/local/agnes-image/generate', 'POST', {
  prompt: 'x',
  apiKey: 'k',
  baseURL: 'https://gw.example.com/v1',
})
check('自訂上游：/v1 結尾只補 /images/generations', customBase.status === 200 && capturedUrl === 'https://gw.example.com/v1/images/generations', capturedUrl)

const customPath = await call('/local/agnes-image/generate', 'POST', {
  prompt: 'x',
  apiKey: 'k',
  baseURL: 'https://gw.example.com/agnes/',
})
check('自訂上游：保留路徑前綴並去掉尾斜線', capturedUrl === 'https://gw.example.com/agnes/v1/images/generations', capturedUrl)

const remembered = await call('/local/agnes-image/status', 'GET')
check('自訂上游會被記住（status 回報）', remembered.json.baseURL === 'https://gw.example.com/agnes', JSON.stringify(remembered.json))
check('status 帶預設上游位址', remembered.json.defaultBaseURL === 'https://apihub.agnes-ai.com', JSON.stringify(remembered.json))
check('status 帶輸出目錄', typeof remembered.json.defaultOutDir === 'string' && remembered.json.defaultOutDir.length > 0, JSON.stringify(remembered.json))

check('生成後會存成 PNG 並回傳路徑', Boolean(img2img.json.path) && existsSync(img2img.json.path) && img2img.json.bytes === PNG_BYTES.length, JSON.stringify({ path: img2img.json.path, bytes: img2img.json.bytes }))

const alt = await call('/local/agnes-image/generate', 'POST', { prompt: 'x', apiKey: 'k', outputDir: ALT_DIR })
check('可指定輸出目錄', alt.status === 200 && String(alt.json.path || '').startsWith(ALT_DIR), JSON.stringify(alt.json))
globalThis.fetch = realFetch

const relDir = await call('/local/agnes-image/generate', 'POST', { prompt: 'x', apiKey: 'k', outputDir: 'relative/dir' })
check('相對路徑的輸出目錄回 400', relDir.status === 400 && /絕對路徑/.test(relDir.json.error), JSON.stringify(relDir.json))

const badBase = await call('/local/agnes-image/generate', 'POST', { prompt: 'x', apiKey: 'k', baseURL: 'ftp://gw.example.com' })
check('非 http(s) 上游回 400', badBase.status === 400 && /http\(s\)/.test(badBase.json.error), JSON.stringify(badBase.json))

const badImage = await call('/local/agnes-image/generate', 'POST', { prompt: 'x', apiKey: 'k', images: ['file:///C:/secret.png'] })
check('參考圖格式錯誤回 400', badImage.status === 400 && /參考圖/.test(badImage.json.error), JSON.stringify(badImage.json))

const tooMany = await call('/local/agnes-image/generate', 'POST', {
  prompt: 'x',
  apiKey: 'k',
  images: Array.from({ length: 9 }, (_value, index) => `https://example.com/${index}.png`),
})
check('參考圖超過 8 張回 400', tooMany.status === 400 && /最多 8 張/.test(tooMany.json.error), JSON.stringify(tooMany.json))

check('工具 schema 有 image 參數', Boolean(state.tool.parameters.properties.image) && state.tool.parameters.properties.image.type === 'array')
check('工具 schema 有 baseURL 參數', Boolean(state.tool.parameters.properties.baseURL))

// ---------- Client 半邊 ----------
const loaded = []
globalThis.window = {
  __ModuleLoader__: { load: (mod) => loaded.push(mod) },
  localStorage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  head: { appendChild: () => {} },
}

await import(clientUrl)
check('client 註冊 ModuleLoader 模組', loaded.length === 1 && loaded[0].id === '@local/agnes-image')

const element = (type, props, ...children) => ({ type, props: props || {}, children })
const hookState = { index: 0 }
const preset = {}
const ReactMock = {
  createElement: element,
  useState(initial) {
    const index = hookState.index++
    return [index in preset ? preset[index] : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) { return fn },
}

const registrations = []
const slots = {
  inject(_key, callback) { callback() },
  register(options, component) { registrations.push({ options, component }); return () => {} },
}
const client = loaded[0].factory((name) => {
  if (name === 'react') return ReactMock
  throw new Error(`unexpected require: ${name}`)
})
client.apply({ get: (name) => (name === 'slots' ? slots : undefined), effect: (fn) => fn() })

const mainEntry = registrations.find((entry) => entry.options.name === 'main')
const sidebarEntry = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
check('註冊 main 面板（key=agnes-image）', Boolean(mainEntry) && mainEntry.options.key === 'agnes-image')
check('註冊 sidebar 清單圖示（id=agnes-image）', Boolean(sidebarEntry) && sidebarEntry.options.id === 'agnes-image' && sidebarEntry.options.label() === 'Agnes 生圖')

// main 註冊的是包裝元件（傳入目錄選擇器），實際面板在它的 props.type 裡。
const mainWrapper = mainEntry.component({})
const PanelComponent = mainWrapper.type
const renderPanel = () => PanelComponent(mainWrapper.props)

hookState.index = 0
const emptyState = JSON.stringify(renderPanel())
check('面板空狀態', emptyState.includes('Agnes 生圖') && emptyState.includes('生成結果會出現在這裡'))
check('面板有提示詞輸入與生成按鈕', emptyState.includes('描述你要的圖片') && emptyState.includes('生成'))

hookState.index = 0
preset[5] = false
preset[8] = { url: 'https://example.com/a.png', path: 'C:/tmp/agnes/a.png', model: 'm', size: '2K', ratio: '16:9', mode: 'image-to-image' }
preset[10] = [{ id: 'ref-1', src: 'https://example.com/ref.png' }]
preset[14] = [{ id: 'h1', url: 'https://example.com/history.png', prompt: '舊圖', model: 'm', size: '1K', ratio: '1:1', mode: 'text-to-image', createdAt: 1700000000000 }]
preset[15] = 'D:/pics/agnes'
const withResult = JSON.stringify(renderPanel())
check('有結果時顯示圖片與 key 欄位', withResult.includes('https://example.com/a.png') && withResult.includes('Agnes API key'))
check('有參考圖時顯示縮圖與改圖按鈕', withResult.includes('https://example.com/ref.png') && withResult.includes('改圖／合成'))
check('結果可以「設為參考圖」', withResult.includes('設為參考圖') && withResult.includes('image-to-image'))
check('面板有上游地址欄位（預設位址當 placeholder）', withResult.includes('上游地址') && withResult.includes('https://apihub.agnes-ai.com'))
check('歷史紀錄列表會列出過往圖片', withResult.includes('歷史紀錄（1）') && withResult.includes('https://example.com/history.png') && withResult.includes('清除全部'))
check('結果會顯示存檔路徑與「開啟資料夾」', withResult.includes('C:/tmp/agnes/a.png') && withResult.includes('開啟資料夾'))
check('面板有輸出目錄欄位', withResult.includes('輸出目錄') && withResult.includes('D:/pics/agnes'))
check('輸出目錄有「瀏覽…」選擇器', withResult.includes('瀏覽…'))
const icon = sidebarEntry.component({ size: 18, active: true })
check('側邊欄圖示渲染 svg', Boolean(icon) && icon.type === 'svg' && icon.props.width === 18 && icon.props.height === 18)

rmSync(OUT_DIR, { recursive: true, force: true })
rmSync(ALT_DIR, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
