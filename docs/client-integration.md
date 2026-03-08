# 🔌 客户端接入

本文档说明如何将下游客户端连接到 Metapi 代理网关。

[返回文档中心](./README.md)

---

## 通用配置

Metapi 暴露标准 OpenAI / Claude 兼容接口，下游客户端只需配置两项：

| 配置项 | 值 |
|--------|-----|
| **Base URL** | `https://your-domain.com`（不要拼接 `/v1`，客户端会自动加） |
| **API Key** | 你设置的 `PROXY_TOKEN` 值，或创建的下游 API Key |

模型列表自动从 `GET /v1/models` 获取，无需手动配置。

## 支持的接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/v1/responses` | POST | OpenAI Responses |
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/messages` | POST | Claude Messages |
| `/v1/completions` | POST | OpenAI Completions（Legacy） |
| `/v1/embeddings` | POST | 向量嵌入 |
| `/v1/files` | POST / GET / DELETE | OpenAI Files 上传、列举、读取与删除 |
| `/v1/images/generations` | POST | 图像生成 |
| `/v1/models` | GET | 模型列表 |

## 已验证兼容的客户端

### ChatGPT-Next-Web

| 配置项 | 值 |
|--------|-----|
| Settings → Custom Endpoint | `https://your-domain.com` |
| API Key | `PROXY_TOKEN` |

### Open WebUI

| 配置项 | 值 |
|--------|-----|
| Settings → Connections → OpenAI API URL | `https://your-domain.com/v1` |
| API Key | `PROXY_TOKEN` |

### Cherry Studio

| 配置项 | 值 |
|--------|-----|
| 模型提供商 → OpenAI → API 地址 | `https://your-domain.com` |
| API Key | `PROXY_TOKEN` |

> 说明：Metapi 现在支持标准 OpenAI `/v1/files` 文件链路。  
> Cherry Studio、Open WebUI 等客户端如果通过标准 OpenAI Files + `Responses` / Chat 文件块发送 PDF、Markdown、JSON、图片、音频附件，即可经由 Metapi 转发。  
> 如果某个客户端版本仍使用私有附件协议而不是标准 `/v1/files`，则仍需单独适配。

### Cursor

| 配置项 | 值 |
|--------|-----|
| Settings → Models → OpenAI API Key | `PROXY_TOKEN` |
| Override OpenAI Base URL | `https://your-domain.com/v1` |

### Claude Code

在 `~/.claude/settings.json` 中配置：

```json
{
  “env”: {
    “ANTHROPIC_BASE_URL”: “https://your-domain.com”,
    “ANTHROPIC_API_KEY”: “your-proxy-sk-token”,
    “ANTHROPIC_AUTH_TOKEN”: “your-proxy-sk-token”,
    “CLAUDE_CODE_ATTRIBUTION_HEADER”: “0”,
    “CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC”: “1”
  }
}
```

> 说明：不同版本客户端可能读取 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，建议同时设置。
> 上述变量由 Claude Code 客户端读取，属于客户端行为开关；
> `metapi` 服务端无法替代客户端”设置这些变量”，只能处理已经发来的请求。

### Codex CLI

`~/.codex/config.toml`

```toml
model = “gpt-5”
model_provider = “metapi”

[model_providers.metapi]
name = “metapi”
base_url = “https://your-domain.com/v1”
```

`~/.codex/auth.json`

```json
{
  “OPENAI_API_KEY”: “your-proxy-sk-token”
}
```

> 提示：`model` 需要是你在 Metapi `GET /v1/models` 可见的模型名。

### Roo Code / Kilo Code

配置方式与 Cursor 类似，在设置中填入 Base URL 和 API Key。

### 其他客户端

所有支持 OpenAI API 格式的客户端均可接入，只需找到 Base URL 和 API Key 的配置位置即可。

## 下游 API Key 策略

除了全局 `PROXY_TOKEN`，你还可以在 **系统设置 → 下游 API Key 策略** 中创建多个项目级下游 Key，每个 Key 可独立配置：

| 配置项 | 说明 |
|--------|------|
| **过期时间**（ExpiresAt） | Key 到期后自动失效 |
| **费用上限**（MaxCost） | 累计消费超限后拒绝请求 |
| **请求上限**（MaxRequests） | 累计请求数超限后拒绝请求 |
| **模型白名单**（SupportedModels） | 限制可用模型，支持 exact / glob / `re:regex` |
| **路由白名单**（AllowedRouteIds） | 限制可走的路由规则 |
| **站点倍率**（SiteWeightMultipliers） | 按站点调整路由权重，控制上游偏好 |

适用于多团队/多项目共用一个 Metapi 实例但需要独立计量和权限控制的场景。

---

## 快速自检

部署完成后，用以下命令验证链路：

```bash
# 1. 检查模型列表
curl -sS https://your-domain.com/v1/models \
  -H "Authorization: Bearer <PROXY_TOKEN>" | head -50

# 2. 测试对话（非流式）
curl -sS https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# 3. 测试文件上传
curl -sS https://your-domain.com/v1/files \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -F "purpose=assistants" \
  -F "file=@./sample.pdf"

# 4. 测试流式
curl -sS https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## 常见问题

### 流式响应异常

如果非流式正常但流式异常，原因几乎都是反向代理配置问题：

1. Nginx 未设置 `proxy_buffering off`
2. CDN 或中间层缓存了 SSE 响应
3. 中间层改写了 `text/event-stream` Content-Type

参考 [部署指南 → Nginx 配置](./deployment.md#nginx) 解决。

### 模型列表为空

- 检查是否已添加站点和账号
- 检查账号是否处于 `healthy` 状态
- 检查是否已同步 Token
- 在管理后台手动触发「刷新模型」

### 客户端提示 401 / 403

- 确认使用的是 `PROXY_TOKEN` 而非 `AUTH_TOKEN`
- 确认反向代理透传了 `Authorization` 请求头

## 下一步

- [配置说明](./configuration.md) — 环境变量详解
- [常见问题](./faq.md) — 更多故障排查
