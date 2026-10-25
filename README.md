# relay-failover

![self-test](https://img.shields.io/badge/self--test-7%2F7%20passing-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![release](https://img.shields.io/github/v/release/huangjinpeng216/relay-failover?label=release)](https://github.com/huangjinpeng216/relay-failover/releases)

把多个 OpenAI 兼容站点组成一个池子，对外只暴露一个地址。**上游超时、5xx、断流时自动切换下一个，客户端无感知。**

```
你的客户端 ──► relay-failover ──► 站点 A（主）
                     │
                     ├────────► 站点 B（备）
                     │
                     └────────► 站点 C（备）
```

---

## 快速验证（不用配任何东西）

不想先配置？直接跑自测，它会启动三个假上游（一个总是返回 500、一个正常、一个永不响应），验证切换真的生效：

```bash
node test.mjs
```

真实输出：

```
✅ 代理启动并能响应 /health
✅ 上游 500 时自动切换  — status=200
✅ 连续请求仍然成功  — status=200
✅ 健康检查记录失败次数  — fails=1
✅ 健康检查显示整体可用
✅ 异常路径不导致进程崩溃
✅ 代理进程存活

7/7 通过
```

这就是核心逻辑的证明：**第一个上游一直是坏的，但客户端拿到的始终是 200。**

---

## 为什么需要它

用第三方 API 中转站的都知道两个痛点：

1. **单点故障**——某个站今天抽风，你的程序就挂了
2. **怕跑路**——不敢一次充太多，钱分在几个站上，切来切去很麻烦

这个工具解决的就是这两件事：**把鸡蛋放在多个篮子里，但对客户端只暴露一个篮子。** 余额分散在几家，任何一家出问题自动切走，不用改代码。

---

## 特点

- **零依赖**：只用 Node.js 内置模块，不需要 `npm install`
- **协议透传**：OpenAI / Anthropic / Gemini 三种鉴权头自动适配
- **加权轮询**：按 `weight` 分配流量，主力站多承担
- **自动冷却**：某站连续失败 N 次后暂停使用，到期自动恢复
- **健康检查**：`GET /health` 查看每个上游的可用性和成功率
- **流式支持**：SSE 直通，不影响流式输出

---

## 快速开始

```bash
# 1. 下载
git clone <repo-url>
cd relay-failover

# 2. 配置
cp config.example.json config.json
# 编辑 config.json，填入你的站点和 key

# 3. 启动
node server.mjs
```

看到这样的输出就成功了：

```
relay-failover 已启动：http://127.0.0.1:8787
上游站点 2 个：
  - l7shop    https://l7shop.xyz/v1          weight=2
  - backup-a  https://backup.example.com/v1  weight=1
健康检查：http://127.0.0.1:8787/health
```

然后把客户端的 `base_url` 改成 `http://127.0.0.1:8787/v1`，key 随便填（代理会替换成真实 key）。

---

## 先体检：这个 key 到底通不通

配好之后别急着启动，先跑一遍体检。它会逐个请求 `/v1/models`，报告每站是否可用：

```bash
node doctor.mjs
```

```
检查 4 个站点（每站请求一次 /v1/models，不消耗 token）

✅ l7shop           212ms  18 个模型
🔑 backup-a          98ms  key 无效或无权限
💥 backup-b         501ms  HTTP 500
❌ backup-c        1203ms  超时 20000ms

可用 1/4
```

**`/v1/models` 是免费接口，不消耗 token**，可以反复跑。

四种图标的意思：

| 图标 | 含义 | 怎么办 |
|---|---|---|
| ✅ | 可用 | — |
| 🔑 | key 无效或无权限 | 检查 key 有没有多余空格、是否属于该站 |
| 💥 | 上游 5xx | 站点自己的问题，等它恢复 |
| ⏳ | 被限流（429） | 降低调用频率 |
| ❌ | 超时或连不上 | 检查 baseUrl 和本机网络/代理 |

体检通过再启动代理。可用数 ≥ 1 就能跑——**这正是故障转移的意义：只要还有一家活着，客户端就不受影响。**

---

## 配置说明

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | 8787 | 本地监听端口 |
| `host` | 127.0.0.1 | 只监听本机。要给局域网用改成 0.0.0.0 |
| `timeoutMs` | 60000 | 单个上游超时时间 |
| `cooldownMs` | 60000 | 失败后的冷却时长 |
| `maxConsecutiveFails` | 3 | 连续失败几次开始冷却 |
| `verbose` | true | 是否打印每次请求的路由结果 |

### upstreams

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 显示用，随便起 |
| `baseUrl` | 是 | 站点地址，带不带 `/v1` 都行（会自动去重） |
| `apiKey` | 是 | 该站的 key |
| `anthropicKey` | 否 | 走 Anthropic 协议时用的 key，不填则用 `apiKey` |
| `weight` | 否 | 权重，默认 1。主力站可以设 2 或 3 |
| `timeoutMs` | 否 | 单独覆盖超时 |

---

## 健康检查

```bash
curl http://127.0.0.1:8787/health
```

```json
{
  "ok": true,
  "upstreams": [
    { "name": "l7shop", "available": true,  "fails": 0, "successRate": 0.997, "requests": 1200, "cooldownSeconds": 0 },
    { "name": "backup-a", "available": false, "fails": 3, "successRate": 0.81,  "requests": 210,  "cooldownSeconds": 42 }
  ]
}
```

`ok` 为 `false` 表示所有上游都不可用，这时候该去看看出了什么事。

---

## 客户端怎么填

| 客户端 | 填什么 |
|---|---|
| NextChat / LobeChat / Cherry Studio | Base URL 填 `http://127.0.0.1:8787/v1`，Key 填任意值 |
| Cline / Roo Code | 同上 |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| Cursor | 选 OpenAI 兼容，Base URL 填 `http://127.0.0.1:8787/v1` |

---

## 故障转移是怎么触发的

| 情况 | 行为 |
|---|---|
| 上游返回 5xx | 标记失败，切下一个 |
| 上游超时 | 标记失败，切下一个 |
| 连接失败 / DNS 错误 | 标记失败，切下一个 |
| 上游返回 429 | **直接返回给客户端**（限流换站也没用，反而增加成本） |
| 上游返回 401 / 403 | **直接返回给客户端**（key 有问题，换站解决不了） |
| 上游返回 4xx（其他） | 直接返回给客户端（是请求本身的问题） |

连续失败达到 `maxConsecutiveFails` 后，该站进入冷却期，期间不再分配流量。

---

## 测试

```bash
node test.mjs
```

会启动三个假上游（一个总是 500、一个正常、一个永不响应），验证故障转移真的生效。不需要真实 key。


---

## 常见错误

按「新人第一次用」的实际顺序排的。每一行都是真实会撞上的。

### 1. `Cannot find module .../config.json` 或「找不到配置文件」

你还没建 config.json。示例配置只是模板，需要复制一份：

```bash
cp config.example.json config.json
```

Windows 上用：

```powershell
copy config.example.json config.json
```

### 2. `Invalid character in header content ["authorization"]`

你的 `apiKey` 里还有中文占位符（比如 `sk-把这里换成你的key`）。

Node 往 HTTP header 塞非 ASCII 字符会直接抛异常。把所有中文换成真实 key 即可。

> 新版已经在请求前拦截这种情况，会提示「apiKey 含非 ASCII 字符」，而不是崩给你看。

### 3. `Error: listen EADDRINUSE: address already in use :::8787`

8787 端口被占了。换一个：

```bash
PORT=8790 node server.mjs          # macOS / Linux
$env:PORT=8790; node server.mjs    # Windows PowerShell
```

或者改 `config.json` 里的 `port`。

### 4. 客户端报 404，但 `/health` 是好的

客户端的 `base_url` 填错了。规则是：

| 客户端 | base_url 应填 |
|---|---|
| NextChat / Cherry Studio / LobeChat | `http://127.0.0.1:8787/v1` |
| Cline / Roo Code | `http://127.0.0.1:8787/v1` |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（**不带 /v1**） |

很多客户端会自己在后面拼 `/chat/completions`，你多写了 `/v1` 就变成 `/v1/v1/chat/completions` → 404。

### 5. 所有上游都显示 ❌，但站点在浏览器里能打开

大概率是走了系统代理。开着 Hiddify / Clash 之类的软件时，Node 可能也会走代理，导致连不上国内的站。

```bash
# 临时排除代理
NO_PROXY="*" node server.mjs      # macOS / Linux
$env:NO_PROXY="*"; node server.mjs # Windows PowerShell
```

### 6. 代理跑起来了，但第一次请求特别慢

正常。第一次连接要做 DNS 解析 + TLS 握手，之后复用连接就快了。如果每次请求都慢，看 `/health` 里哪个上游的延迟高。

### 7. 想确认它真的在切换

跑自测，它会启动三个假上游（一个永远 500、一个正常、一个永不响应），打印每一次切换：

```bash
node test.mjs
```

看到「上游 500 时自动切换 — status=200」就说明核心逻辑是通的。

---

## 注意

- 本工具把多个站的 key 集中在一个本地文件里，`config.json` **不要提交到 git**（已加 `.gitignore`）
- 默认只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到公网，否则别人能白嫖你的额度
- 它不改变计费方式，只是帮你把请求路由到可用的站

---

## 示例配置

`config.example.json` 里默认填了一个示例上游（`l7shop.xyz`，0.1x 倍率，OpenAI / Anthropic / Gemini 三协议）。你可以留着，也可以全换成自己的。

---

## 相关阅读

如果你在评估「用哪家站的 API」，这几页可能有用（同一维护方整理，数据抓自官方文档）：

- [AI API 价格与选站指南](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/) — 倍率怎么算、选站五项标准、比价表
- [DeepSeek / GLM / Kimi 官方价格表](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/api-price-table.html) — 8 个模型的官方单价，含缓存命中价与峰谷价，标注抓取日期
- [中转站避雷指南](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/api-relay-pitfalls.html) — 包括「网站正常但 API 全挂」这种最容易被误判的故障
- [为什么需要 API 故障转移层](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/failover-guide.html) — 本工具要解决的问题的完整说明，含一次真实故障的复盘

---

## License

MIT
