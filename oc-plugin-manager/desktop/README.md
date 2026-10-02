# Desktop 设置面板开关注入

`oc-plugin-manager-inject.js` 在 OpenCode Desktop「偏好设置 → 扩展 → 插件」列表中为每个插件追加**原生样式开关**（与 MCP 列表完全一致的 `[data-component="switch"]` 结构，直接复用应用自带 CSS）：

- 开关 = 应用原生开关：24×16 圆角控件 + 滑块，蓝色渐变选中态，`data-checked` 属性驱动。
- 打开 → 点击禁用；关闭 → 点击启用。
- 被禁用的插件从应用列表中消失后，会以灰显合成行形式补在列表尾部，保证**始终可重新启用**。
- 管理器自身（`oc-plugin-manager`）不显示开关。

## 目标 DOM（实测 2.0.22）

```
button[role="tab"][data-key="plugins"][aria-selected="true"]   ← 插件子标签页
  └─ aria-controls → #…-content-plugins（面板）
       └─ [data-component="settings-list"]
            └─ .settings-extension-row
                 ├─ .settings-extension-lead > .settings-extension-name   ← 插件名
                 └─ [data-oc-plugin-manager]（本插件注入的开关）
```

## 数据通道

- `POST {base}/api/rpc/plugin.manager/list` → `{ entries: [...] }`
- `POST {base}/api/rpc/plugin.manager/set` → `{ ok, error?, entry? }`（`input: { name, scope, kind, enabled }`）
- 服务地址自动探测（`/api/info`；401/403 视为找到；失败不缓存，随轮询重试）。

## 可用 API（注入后）

```js
ocPluginManager.refresh()
ocPluginManager.state.entries
ocPluginManager.setServerBase("http://127.0.0.1:49374")
ocPluginManager.destroy()
```
