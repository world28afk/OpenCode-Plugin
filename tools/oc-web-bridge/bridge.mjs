#!/usr/bin/env node
// oc-web-bridge —— 网页版插件注入桥
//
// 在 OpenCode 服务端 (127.0.0.1:49374) 前面挂一层本地反向代理：
//   1. 把各插件的 renderer 注入脚本合并为 /_oc-bridge/injects.js；
//   2. 对所有 text/html 响应注入 <script src="/_oc-bridge/injects.js"></script>（同源，符合 CSP script-src 'self'）；
//   3. 附带 fetch 认证垫片：把同源 /api 请求自动补上 Basic 凭据（读取网页版已保存的连接信息），
//      让桌面注入脚本在浏览器环境中也能调用服务端 RPC。
//
// 不需要重启 OpenCode：浏览器改用 http://127.0.0.1:49380 访问网页版即可；
// frp 隧道把「本地端口」从 49374 改成 49380（或新建一条隧道指向 49380）。

import http from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..", "..")

const TARGET_HOST = process.env.OC_WEB_TARGET_HOST || "127.0.0.1"
const TARGET_PORT = Number(process.env.OC_WEB_TARGET_PORT || 49374)
const LISTEN_HOST = process.env.OC_WEB_LISTEN_HOST || "127.0.0.1"
const LISTEN_PORT = Number(process.env.OC_WEB_LISTEN_PORT || 49380)

const INJECTS = [
  ["oc-plugin-manager", join(repo, "oc-plugin-manager", "desktop", "oc-plugin-manager-inject.js")],
  ["oc-deepseek-banlance", join(repo, "oc-deepseek-banlance", "desktop", "oc-balance-inject.js")],
  ["oc-infinite-gen-4", join(repo, "oc-infinite-gen-4", "desktop", "oc-infinite-gen-4-inject.js")],
  ["oc-cyberbot", join(repo, "oc-cyberbot", "desktop", "oc-cyberbot-inject.js")],
]

const AUTH_SHIM = `/* oc-web-bridge auth shim：同源 /api 请求自动补 Basic 凭据（从网页版保存的连接信息读取） */
;(() => {
  if (window.__ocWebAuthShim) return
  window.__ocWebAuthShim = true
  const originalFetch = window.fetch.bind(window)
  const basic = () => {
    try {
      const raw = localStorage.getItem("opencode.global.dat:server")
      if (!raw) return null
      const parsed = JSON.parse(raw)
      const list = parsed && Array.isArray(parsed.list) ? parsed.list : []
      const entry = list.find((item) => item && item.http && typeof item.http.url === "string")
      const password = entry && typeof entry.http.password === "string" ? entry.http.password : ""
      if (!password) return null
      return "Basic " + btoa("opencode:" + password)
    } catch {
      return null
    }
  }
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : ""
      const sameOrigin = url.startsWith("/") || url.startsWith(location.origin)
      const isApi = sameOrigin && url.includes("/api/")
      if (isApi) {
        const nextInit = Object.assign({}, init || {})
        const headers = new Headers(nextInit.headers || undefined)
        if (!headers.has("authorization")) {
          const auth = basic()
          if (auth) headers.set("Authorization", auth)
        }
        nextInit.headers = headers
        return originalFetch(input, nextInit)
      }
    } catch {}
    return originalFetch(input, init)
  }
})()`

function buildBundle() {
  const parts = [AUTH_SHIM]
  for (const [name, file] of INJECTS) {
    if (!existsSync(file)) {
      parts.push(`console.warn("[oc-web-bridge] 跳过缺失注入: ${name}")`)
      continue
    }
    parts.push(`/* ==== ${name} ==== */\n` + readFileSync(file, "utf8"))
  }
  return parts.join("\n;\n")
}

let bundle = buildBundle()

const server = http.createServer((req, res) => {
  if (req.url === "/_oc-bridge/injects.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
    res.end(bundle)
    return
  }
  if (req.url === "/_oc-bridge/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        ok: true,
        target: `${TARGET_HOST}:${TARGET_PORT}`,
        listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
        injects: INJECTS.filter(([, file]) => existsSync(file)).map(([name]) => name),
        bundleBytes: Buffer.byteLength(bundle),
      }),
    )
    return
  }

  const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` }
  delete headers["accept-encoding"] // HTML 不压缩，便于注入
  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers },
    (pres) => {
      const type = String(pres.headers["content-type"] || "")
      if (type.includes("text/html")) {
        const chunks = []
        pres.on("data", (chunk) => chunks.push(chunk))
        pres.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8")
          if (!html.includes("/_oc-bridge/injects.js")) {
            const tag = `  <script src="/_oc-bridge/injects.js"></script>\n`
            html = html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html.replace("</head>", `${tag}</head>`)
          }
          const out = Buffer.from(html, "utf8")
          const outHeaders = { ...pres.headers }
          delete outHeaders["content-length"]
          delete outHeaders["transfer-encoding"]
          res.writeHead(pres.statusCode || 200, outHeaders)
          res.end(out)
        })
      } else {
        res.writeHead(pres.statusCode || 200, pres.headers)
        pres.pipe(res)
      }
    },
  )
  upstream.on("error", (error) => {
    try {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      res.end("oc-web-bridge upstream error: " + error.message)
    } catch {}
  })
  req.pipe(upstream)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const names = INJECTS.filter(([, file]) => existsSync(file)).map(([name]) => name)
  console.log(`[oc-web-bridge] listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`)
  console.log(`[oc-web-bridge] injects: ${names.join(", ")}`)
})
