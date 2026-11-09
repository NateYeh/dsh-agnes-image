/**
 * agnes-image — Web Client 半邊。
 *
 * 左側 sidebar 的「Agnes 生圖」面板圖示，點下去由 `main` slot 的 `agnes-image`
 * 面板接手中央區域：文生圖、圖生圖（上傳參考圖或貼 URL）、多圖合成。
 *
 * 請求走 Host 註冊的 POST /agnes-image/generate；參考圖以 data URI base64
 * 或公開 https URL 傳給 Host，再由 Host 呼叫 Agnes API（key 只留在瀏覽器
 * localStorage 與 Host 記憶體）。
 *
 * @module @local/agnes-image/client
 */
window.__ModuleLoader__.load({
  id: '@local/agnes-image',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const KEY_STORAGE = 'dsh.agnes-image.apiKey'
    const BASE_STORAGE = 'dsh.agnes-image.baseURL'
    const OUT_STORAGE = 'dsh.agnes-image.outDir'
    const HISTORY_STORAGE = 'dsh.agnes-image.history'
    const HISTORY_LIMIT = 40
    const PANEL_ID = 'agnes-image'
    const MAX_IMAGES = 8
    /** 參考圖上傳後縮到這個長邊（px）與 payload 上限，避免 base64 塞爆請求。 */
    const MAX_EDGE = 1600
    const MAX_DATA_URL = 1500000
    const MODELS = [
      { id: 'agnes-image-2.5-flash', label: 'Agnes Image 2.5 Flash' },
      { id: 'agnes-image-2.1-flash', label: 'Agnes Image 2.1 Flash' },
    ]
    const SIZES = ['1K', '2K', '3K', '4K']
    const RATIOS = ['1:1', '4:3', '3:2', '16:9', '21:9', '3:4', '2:3', '9:16']

    let refSeq = 0
    const nextRefId = () => {
      refSeq += 1
      return `ref-${refSeq}`
    }

    const CSS = [
      '.agp{height:100%;overflow-y:auto;padding:24px 32px 48px;box-sizing:border-box;}',
      '.agp-inner{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:16px;}',
      '.agp-head{display:flex;flex-direction:column;gap:4px;}',
      '.agp-title{margin:0;font-size:18px;font-weight:650;color:var(--dsw-alias-label-primary);}',
      '.agp-sub{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.agp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);',
      'padding:16px;display:flex;flex-direction:column;gap:12px;}',
      '.agp-prompt{width:100%;box-sizing:border-box;min-height:96px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:10px 12px;',
      'font-family:inherit;font-size:13px;line-height:1.6;}',
      '.agp-prompt:focus{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:0;}',
      '.agp-refs{display:flex;flex-direction:column;gap:8px;}',
      '.agp-refs-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;',
      'color:var(--dsw-alias-label-secondary);}',
      '.agp-upload{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;',
      'font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;}',
      '.agp-upload:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.agp-url{flex:1;min-width:200px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;font-family:inherit;}',
      '.agp-thumbs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.agp-thumb{position:relative;width:88px;height:88px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'overflow:hidden;background:var(--dsw-alias-bg-layer-2);}',
      '.agp-thumb img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.agp-thumb-x{position:absolute;top:2px;right:2px;width:20px;height:20px;line-height:1;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
      'font-size:13px;cursor:pointer;padding:0;font-family:inherit;}',
      '.agp-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;}',
      '.agp-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.agp-select{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);font-size:12px;padding:6px 8px;font-family:inherit;}',
      '.agp-spacer{flex:1;}',
      '.agp-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
      'border-radius:8px;padding:6px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;}',
      '.agp-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}',
      '.agp-btn:disabled{opacity:.55;cursor:default;}',
      '.agp-key{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.agp-key input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;padding:7px 9px;font-family:inherit;}',
      '.agp-settings{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;}',
      '.agp-settings .agp-key{flex:1;min-width:260px;}',
      '.agp-path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
      '.agp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;}',
      '.agp-note{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.agp-result{border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;padding:16px;display:flex;',
      'flex-direction:column;gap:10px;align-items:flex-start;min-height:120px;justify-content:center;',
      'background:var(--dsw-alias-bg-layer-1);}',
      '.agp-empty{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.agp-img{max-width:100%;max-height:520px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);}',
      '.agp-meta{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.agp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.agp-link{border:none;background:none;color:var(--dsw-alias-brand-primary);font-size:12px;cursor:pointer;',
      'padding:4px 6px;border-radius:6px;font-family:inherit;text-decoration:none;}',
      '.agp-link:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}',
      '.agp-history{display:flex;flex-direction:column;gap:10px;}',
      '.agp-hist-head{display:flex;align-items:center;gap:8px;}',
      '.agp-hist-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary);}',
      '.agp-hist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;}',
      '.agp-hist-item{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-1);}',
      '.agp-hist-open{display:block;width:100%;padding:0;border:none;background:none;cursor:pointer;font-family:inherit;}',
      '.agp-hist-open img{width:100%;height:120px;object-fit:cover;display:block;}',
      '.agp-hist-meta{font-size:10px;color:var(--dsw-alias-label-secondary);padding:4px 6px;}',
      '.agp-hist-del{position:absolute;top:3px;right:3px;width:20px;height:20px;line-height:1;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
      'font-size:12px;cursor:pointer;padding:0;font-family:inherit;}',
    ].join('')

    /** 插入樣式表，回傳移除函式（卸載時清掉）。 */
    function ensureCss() {
      if (typeof document === 'undefined') return function () {}
      const existing = document.querySelector('style[data-plugin-css="agnes-image"]')
      if (existing) return function () {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'agnes-image'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return function () {
        tag.remove()
      }
    }

    /** 讀面板上次輸入的 key（只存在本機瀏覽器）。 */
    function readStoredKey() {
      return readStored(KEY_STORAGE)
    }

    /** 記住面板輸入的 key；空字串代表清除。 */
    function writeStoredKey(value) {
      writeStored(KEY_STORAGE, value)
    }

    /** 讀／寫本機瀏覽器的一個字串值，存取失敗只記錄不中斷。 */
    function readStored(storageKey) {
      try {
        return window.localStorage.getItem(storageKey) || ''
      } catch (error) {
        console.log('[agnes-image] 無法讀取 localStorage', error)
        return ''
      }
    }

    function writeStored(storageKey, value) {
      try {
        if (value) window.localStorage.setItem(storageKey, value)
        else window.localStorage.removeItem(storageKey)
      } catch (error) {
        console.log('[agnes-image] 無法寫入 localStorage', error)
      }
    }

    /** 讀本機的生成紀錄（新到舊）；壞資料就當作沒有紀錄。 */
    function readHistory() {
      try {
        const raw = window.localStorage.getItem(HISTORY_STORAGE)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item) => item && typeof item.url === 'string' && item.url)
      } catch (error) {
        console.log('[agnes-image] 讀取歷史紀錄失敗', error)
        return []
      }
    }

    /** 寫回本機的生成紀錄。 */
    function writeHistory(entries) {
      try {
        window.localStorage.setItem(HISTORY_STORAGE, JSON.stringify(entries))
      } catch (error) {
        console.log('[agnes-image] 寫入歷史紀錄失敗', error)
      }
    }

    /** 紀錄時間顯示成 MM/DD HH:mm。 */
    function formatWhen(timestamp) {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    /**
     * 把本機檔案讀成 data URI；太大或太長邊就縮圖（白底 JPEG），
     * 避免 base64 請求超過 Host 的 32 MB 上限。
     * @param {File} file 使用者選的圖片檔。
     * @returns {Promise<string>} data:image/... base64。
     */
    function readImageFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('讀取圖片失敗'))
        reader.onload = () => {
          const dataUrl = String(reader.result || '')
          if (!dataUrl) {
            reject(new Error('讀取圖片失敗'))
            return
          }
          const image = new window.Image()
          image.onload = () => {
            const longest = Math.max(image.width, image.height)
            const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1
            if (scale === 1 && dataUrl.length <= MAX_DATA_URL) {
              resolve(dataUrl)
              return
            }
            try {
              const canvas = document.createElement('canvas')
              canvas.width = Math.max(1, Math.round(image.width * scale))
              canvas.height = Math.max(1, Math.round(image.height * scale))
              const context = canvas.getContext('2d')
              if (!context) {
                resolve(dataUrl)
                return
              }
              // JPEG 沒有透明通道，先鋪白底避免透明區域變黑。
              context.fillStyle = '#ffffff'
              context.fillRect(0, 0, canvas.width, canvas.height)
              context.drawImage(image, 0, 0, canvas.width, canvas.height)
              resolve(canvas.toDataURL('image/jpeg', 0.9))
            } catch (error) {
              console.log('[agnes-image] 縮圖失敗，改用原圖', error)
              resolve(dataUrl)
            }
          }
          image.onerror = () => resolve(dataUrl)
          image.src = dataUrl
        }
        reader.readAsDataURL(file)
      })
    }

    /** 下拉選單：標籤在上、選單在下。 */
    function field(title, value, options, onChange) {
      return h('label', { className: 'agp-field', key: title },
        h('span', null, title),
        h('select', { className: 'agp-select', value, onChange: (event) => onChange(event.target.value) },
          options.map((option) => {
            const id = typeof option === 'string' ? option : option.id
            const label = typeof option === 'string' ? option : option.label
            return h('option', { value: id, key: id }, label)
          })))
    }

    /** 側邊欄圖示：圖片框＋星芒，跟隨主題色。 */
    function AgnesIcon(props) {
      const size = typeof props === 'object' && typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 3.2, y: 4.6, width: 14.4, height: 12.2, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 8.1, cy: 9.2, r: 1.5, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M4.4 15.2l4.4-4.1 3.3 3 2.2-2 3.4 3.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M19.1 3.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z', fill: 'currentColor' }))
    }

    /** 中央面板：提示詞、參考圖、參數、生成、結果。 */
    function AgnesPanel() {
      const prompt = useState('')
      const setPrompt = prompt[1]
      const model = useState(MODELS[0].id)
      const setModel = model[1]
      const size = useState('1K')
      const setSize = size[1]
      const ratio = useState('1:1')
      const setRatio = ratio[1]
      const apiKey = useState(readStoredKey)
      const setApiKey = apiKey[1]
      const [hostHasKey, setHostHasKey] = useState(null)
      const busy = useState(false)
      const setBusy = busy[1]
      const error = useState('')
      const setError = error[1]
      const result = useState(null)
      const setResult = result[1]
      const [copied, setCopied] = useState(false)
      const refs = useState([])
      const setRefs = refs[1]
      const urlDraft = useState('')
      const setUrlDraft = urlDraft[1]
      const baseURL = useState(() => readStored(BASE_STORAGE))
      const setBaseURL = baseURL[1]
      const [defaultBase, setDefaultBase] = useState('')
      const history = useState(() => readHistory())
      const setHistory = history[1]
      const outDir = useState(() => readStored(OUT_STORAGE))
      const setOutDir = outDir[1]
      const [defaultOut, setDefaultOut] = useState('')

      // Host 端是否已備妥 key（config 或環境變數）；失敗就當作沒有，顯示 key 欄位。
      useEffect(() => {
        let alive = true
        fetch('/local/agnes-image/status', { credentials: 'same-origin' })
          .then((response) => response.json())
          .then((data) => {
            if (!alive || !data || !data.ok) return
            setHostHasKey(Boolean(data.hasKey))
            if (typeof data.defaultBaseURL === 'string') setDefaultBase(data.defaultBaseURL)
            if (typeof data.baseURL === 'string') setBaseURL((current) => current || data.baseURL)
            if (typeof data.defaultOutDir === 'string') setDefaultOut(data.defaultOutDir)
            if (typeof data.outDir === 'string') setOutDir((current) => current || data.outDir)
          })
          .catch(() => {
            if (alive) setHostHasKey(false)
          })
        return () => {
          alive = false
        }
      }, [setHostHasKey])

      const addRef = useCallback((src) => {
        setRefs((current) => (current.length >= MAX_IMAGES ? current : current.concat([{ id: nextRefId(), src }])))
      }, [setRefs])

      const removeRef = useCallback((id) => {
        setRefs((current) => current.filter((item) => item.id !== id))
      }, [setRefs])

      /** 選檔 → 縮圖 → 加入參考圖；超過張數或讀不到就顯示原因。 */
      const pickFiles = useCallback((event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (files.length === 0) return
        const room = MAX_IMAGES - refs[0].length
        if (room <= 0) {
          setError(`參考圖最多 ${MAX_IMAGES} 張`)
          return
        }
        const targets = files.slice(0, room)
        Promise.all(targets.map((file) => readImageFile(file).catch((failure) => {
          setError(String(failure && failure.message ? failure.message : failure))
          return ''
        }))).then((values) => {
          const usable = values.filter(Boolean)
          if (usable.length > 0) setRefs((current) => current.concat(usable.map((src) => ({ id: nextRefId(), src }))))
        })
      }, [refs, setRefs, setError])

      const addUrl = useCallback(() => {
        const value = urlDraft[0].trim()
        if (!value) return
        if (!/^https?:\/\//i.test(value)) {
          setError('參考圖 URL 必須是 http(s) 開頭')
          return
        }
        if (refs[0].length >= MAX_IMAGES) {
          setError(`參考圖最多 ${MAX_IMAGES} 張`)
          return
        }
        setError('')
        addRef(value)
        setUrlDraft('')
      }, [urlDraft, refs, addRef, setUrlDraft, setError])

      const run = useCallback(async () => {
        const text = prompt[0].trim()
        if (!text) {
          setError('請先輸入提示詞')
          return
        }
        setBusy(true)
        setError('')
        try {
          const response = await fetch('/local/agnes-image/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              prompt: text,
              model: model[0],
              size: size[0],
              ratio: ratio[0],
              apiKey: apiKey[0].trim(),
              baseURL: baseURL[0].trim(),
              outputDir: outDir[0].trim(),
              images: refs[0].map((item) => item.src),
            }),
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || data.ok === false) {
            throw new Error((data && data.error) || `請求失敗（HTTP ${response.status}）`)
          }
          setResult(data)
          const entry = {
            id: `hist-${Date.now()}`,
            url: String(data.url),
            prompt: text.slice(0, 300),
            model: data.model,
            size: data.size,
            ratio: data.ratio,
            mode: data.mode,
            path: typeof data.path === 'string' ? data.path : '',
            createdAt: Date.now(),
          }
          const nextHistory = [entry, ...history[0].filter((item) => item.url !== entry.url)].slice(0, HISTORY_LIMIT)
          setHistory(nextHistory)
          writeHistory(nextHistory)
          if (outDir[0].trim()) writeStored(OUT_STORAGE, outDir[0].trim())
          if (baseURL[0].trim()) writeStored(BASE_STORAGE, baseURL[0].trim())
          if (apiKey[0].trim()) {
            writeStoredKey(apiKey[0].trim())
            setHostHasKey(true)
          }
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusy(false)
        }
      }, [prompt, model, size, ratio, apiKey, baseURL, outDir, refs, history, setHistory, setBusy, setError, setResult, setHostHasKey])

      const copyLink = useCallback(() => {
        if (!result[0] || !result[0].url) return
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(result[0].url).then(done).catch(() => setError('複製失敗，請手動開啟原圖'))
        } else {
          setError('這個瀏覽器不支援剪貼簿')
        }
      }, [result, setCopied, setError])

      /** 把這次結果丟回參考圖，接著改圖（圖生圖迭代）。 */
      const reuseAsRef = useCallback(() => {
        if (!result[0] || !result[0].url) return
        if (refs[0].length >= MAX_IMAGES) {
          setError(`參考圖最多 ${MAX_IMAGES} 張`)
          return
        }
        addRef(result[0].url)
      }, [result, refs, addRef, setError])

      /** 點歷史縮圖 → 放回結果區預覽。 */
      const showHistory = useCallback((entry) => {
        setResult({
          ok: true,
          url: entry.url,
          path: entry.path || '',
          model: entry.model,
          size: entry.size,
          ratio: entry.ratio,
          mode: entry.mode,
        })
      }, [setResult])

      /** 從紀錄移除一張（只清本機清單）。 */
      const removeHistory = useCallback((id) => {
        const next = history[0].filter((item) => item.id !== id)
        setHistory(next)
        writeHistory(next)
      }, [history, setHistory])

      /** 清空紀錄（只清本機清單，不動上游檔案）。 */
      const clearHistory = useCallback(() => {
        setHistory([])
        writeHistory([])
      }, [setHistory])

      /** 在檔案總管打開輸出目錄（並選取這張圖）。 */
      const revealPath = useCallback(async () => {
        if (!result[0]) return
        try {
          const response = await fetch('/local/agnes-image/reveal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ path: result[0].path || '' }),
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || data.ok === false) {
            throw new Error((data && data.error) || `開啟失敗（HTTP ${response.status}）`)
          }
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        }
      }, [result, setError])

      const modeHint = refs[0].length > 0
        ? `圖生圖（${refs[0].length} 張參考圖${refs[0].length > 1 ? '，多圖合成' : ''}）：提示詞寫「要改什麼＋要保留什麼」。`
        : '文生圖：提示詞建議寫 主體＋場景＋風格＋光線＋構圖；要改圖就先加參考圖。'

      return h('div', { className: 'agp' },
        h('div', { className: 'agp-inner' },
          h('header', { className: 'agp-head' },
            h('h1', { className: 'agp-title' }, 'Agnes 生圖'),
            h('p', { className: 'agp-sub' }, 'Agnes AI 文生圖／圖生圖（agnes-image-2.5-flash）。加參考圖就是改圖；加多張就是多圖合成。')),
          h('section', { className: 'agp-card' },
            h('textarea', {
              className: 'agp-prompt',
              placeholder: refs[0].length > 0
                ? '描述要改什麼、要保留什麼：改成 cyberpunk 夜景、加霓虹反光，保留原構圖與鏡位…'
                : '描述你要的圖片：主體＋場景＋風格＋光線＋構圖…',
              value: prompt[0],
              onChange: (event) => setPrompt(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  run()
                }
              },
            }),
            h('div', { className: 'agp-refs' },
              h('div', { className: 'agp-refs-head' },
                h('label', { className: 'agp-upload' },
                  '＋ 選擇參考圖',
                  h('input', {
                    type: 'file',
                    accept: 'image/*',
                    multiple: true,
                    style: { display: 'none' },
                    onChange: pickFiles,
                  })),
                h('input', {
                  className: 'agp-url',
                  placeholder: '或貼圖片 URL（https://…）後按 Enter',
                  value: urlDraft[0],
                  onChange: (event) => setUrlDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addUrl()
                    }
                  },
                }),
                h('button', { className: 'agp-btn', onClick: addUrl, disabled: !urlDraft[0].trim() }, '加入'),
                h('span', { className: 'agp-note' }, `參考圖 ${refs[0].length}/${MAX_IMAGES}`)),
              refs[0].length > 0
                ? h('div', { className: 'agp-thumbs' },
                    refs[0].map((item) => h('div', { className: 'agp-thumb', key: item.id },
                      h('img', { src: item.src, alt: '參考圖' }),
                      h('button', {
                        className: 'agp-thumb-x',
                        title: '移除這張參考圖',
                        onClick: () => removeRef(item.id),
                      }, '×'))))
                : null),
            h('div', { className: 'agp-controls' },
              field('模型', model[0], MODELS, setModel),
              field('解析度', size[0], SIZES, setSize),
              field('比例', ratio[0], RATIOS, setRatio),
              h('span', { className: 'agp-spacer' }),
              h('button', { className: 'agp-btn primary', disabled: busy[0], onClick: run },
                busy[0] ? '生成中…' : refs[0].length > 0 ? '改圖／合成' : '生成')),
            h('div', { className: 'agp-settings' },
              h('label', { className: 'agp-key' },
                h('span', null, '上游地址（OpenAI 相容 gateway，可含 /v1；留空用預設）'),
                h('input', {
                  type: 'text',
                  value: baseURL[0],
                  placeholder: defaultBase || 'https://apihub.agnes-ai.com',
                  onChange: (event) => setBaseURL(event.target.value),
                })),
              h('label', { className: 'agp-key' },
                h('span', null, '輸出目錄（絕對路徑；留空用預設）'),
                h('input', {
                  type: 'text',
                  value: outDir[0],
                  placeholder: defaultOut || '~/Pictures/agnes',
                  onChange: (event) => setOutDir(event.target.value),
                })),
              hostHasKey === false
                ? h('label', { className: 'agp-key' },
                    h('span', null, 'Agnes API key（只存在這台瀏覽器；Host 僅在記憶體中使用）'),
                    h('input', {
                      type: 'password',
                      value: apiKey[0],
                      placeholder: '貼上 API key…',
                      onChange: (event) => setApiKey(event.target.value),
                    }))
                : null),
            error[0] ? h('div', { className: 'agp-err' }, error[0]) : null,
            h('div', { className: 'agp-note' }, `${modeHint} Ctrl＋Enter 送出；上游地址只收 http(s)，結尾是 /v1 就只補 /images/generations。圖片由上游託管，URL 可能隨時間失效。`)),
          h('section', { className: 'agp-result' },
            result[0] && result[0].url
              ? [
                  h('img', { key: 'img', className: 'agp-img', src: result[0].url, alt: prompt[0] || 'Agnes 生成圖片' }),
                  h('div', { key: 'meta', className: 'agp-meta' },
                    `${result[0].model} · ${result[0].size} · ${result[0].ratio} · ${result[0].mode || 'text-to-image'}`),
                  result[0].path ? h('div', { key: 'path', className: 'agp-path' }, result[0].path) : null,
                  result[0].saveError
                    ? h('div', { key: 'saveerr', className: 'agp-err' }, `存檔失敗：${result[0].saveError}`)
                    : null,
                  h('div', { key: 'act', className: 'agp-actions' },
                    h('a', { className: 'agp-link', href: result[0].url, target: '_blank', rel: 'noreferrer' }, '開啟原圖'),
                    h('button', { className: 'agp-link', onClick: copyLink }, copied ? '已複製' : '複製連結'),
                    result[0].path
                      ? h('button', { className: 'agp-link', onClick: revealPath }, '開啟資料夾')
                      : null,
                    h('button', { className: 'agp-link', onClick: reuseAsRef }, '設為參考圖')),
                ]
              : h('div', { className: 'agp-empty' }, '生成結果會出現在這裡；「設為參考圖」可以直接接著改圖。')),
          h('section', { className: 'agp-history' },
            h('div', { className: 'agp-hist-head' },
              h('span', { className: 'agp-hist-title' }, `歷史紀錄（${history[0].length}）`),
              h('span', { className: 'agp-spacer' }),
              history[0].length > 0
                ? h('button', { className: 'agp-link', onClick: clearHistory }, '清除全部')
                : null),
            history[0].length === 0
              ? h('div', { className: 'agp-empty' }, '還沒有生成紀錄；生成過的圖會列在這裡。')
              : h('div', { className: 'agp-hist-grid' },
                  history[0].map((item) => h('div', { className: 'agp-hist-item', key: item.id },
                    h('button', {
                      className: 'agp-hist-open',
                      title: item.prompt || '檢視這張圖',
                      onClick: () => showHistory(item),
                    }, h('img', { src: item.url, alt: item.prompt || 'Agnes 生成圖片', loading: 'lazy' })),
                    h('div', { className: 'agp-hist-meta' }, `${item.size} · ${item.ratio} · ${formatWhen(item.createdAt)}`),
                    h('button', {
                      className: 'agp-hist-del',
                      title: '從紀錄移除',
                      onClick: () => removeHistory(item.id),
                    }, '×')))))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
        if (!slots) return
        ctx.effect(() => ensureCss(), 'agnes-image: styles')
        const disposers = [
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, AgnesPanel)),
          slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => 'Agnes 生圖',
          }, AgnesIcon)),
        ]
        ctx.effect(() => () => {
          for (const dispose of disposers) dispose()
        }, 'agnes-image: slots')
      },
    }
  },
})
