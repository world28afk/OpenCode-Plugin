// 网段白名单（Own servers）— 逐字移植上游 lib/net-scope.js 的入口校验与规范化。
//
// 上游把「自己的服务器」写进 $DSH_HOME/net-scope-allow.txt；本移植存进插件私有
// ctx.storage。校验规则保持一致: 只接受**一个 IP 或一个完整主机名**，可写 user@host；
// 密钥、口令、网段、通配符一律丢弃。

const FILE_SUFFIX = new Set([
  "md","txt","json","js","mjs","cjs","ts","tsx","jsx","py","rb","go","rs","java","c","h","cpp","hpp",
  "yml","yaml","toml","ini","log","png","jpg","jpeg","gif","svg","webp","ico","pdf","zip","gz","tar","7z","rar","mp3","mp4",
])

const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const V4_TEXT = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

function parseIpv6(input: string): string | null {
  const text = String(input || "").trim().toLowerCase()
  if (!text.includes(":")) return null
  if (!/^[0-9a-f:]+$/.test(text)) return null
  if ((text.match(/::/g) || []).length > 1) return null
  const groups = text.split(":")
  if (groups.length > 8) return null
  return text
}

/** 取出主机部分（去掉 user@、端口、IPv6 方括号、结尾点）。 */
function hostOf(raw: string): string {
  let host = String(raw || "").trim().toLowerCase()
  if (!host) return ""
  const at = host.lastIndexOf("@")
  if (at >= 0) host = host.slice(at + 1)
  if (host.startsWith("[")) {
    const end = host.indexOf("]")
    return end > 1 ? host.slice(1, end) : ""
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(host)) return host.replace(/:\d+$/, "")
  if (/^[a-z0-9.-]+:\d+$/.test(host)) return host.replace(/:\d+$/, "")
  return host.replace(/\.$/, "")
}

/** 只接受一个 IP 或一个完整主机名。账号可以写成 user@host。密钥、网段、通配符丢掉。 */
export function entryHost(raw: string): string {
  const text = String(raw || "").trim()
  if (!text || text.startsWith("#")) return ""
  if (text.length > 253 || /[\s/\\*]/.test(text)) return ""
  if (/BEGIN |PRIVATE KEY|ssh-(?:rsa|ed25519|dss) /i.test(text)) return ""
  let body = text
  const at = body.lastIndexOf("@")
  if (at >= 0) {
    const user = body.slice(0, at)
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) return ""
    body = body.slice(at + 1)
  }
  const host = hostOf(body)
  if (!host || host.length > 253) return ""
  if (V4_TEXT.test(host)) return host
  if (host.includes(":")) return parseIpv6(host) != null ? host : ""
  if (!HOST_NAME.test(host)) return ""
  const tail = host.slice(host.lastIndexOf(".") + 1)
  if (FILE_SUFFIX.has(tail)) return ""
  return host
}

export interface NormalizedAllow {
  readonly text: string
  readonly dropped: number
  readonly hosts: string[]
}

export function normalizeAllowText(text: string): NormalizedAllow {
  const kept: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const line of String(text || "").split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw) continue
    if (raw.startsWith("#")) {
      kept.push(raw)
      continue
    }
    const host = entryHost(raw)
    if (!host) {
      dropped += 1
      continue
    }
    if (seen.has(host)) continue
    seen.add(host)
    const at = raw.lastIndexOf("@")
    kept.push(at > 0 ? `${raw.slice(0, at)}@${host}` : host)
  }
  return { text: kept.length ? `${kept.join("\n")}\n` : "", dropped, hosts: [...seen] }
}
