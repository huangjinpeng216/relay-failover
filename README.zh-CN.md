# relay-failover

把多个 OpenAI 兼容站点组成一个池子，对外只暴露一个地址。**上游超时、5xx、断流时自动切到下一个，客户端无感知。**

> English: [README.md](README.md)

```
你的客户端 ──► relay-failover ──► 站点 A（主）
                     │
                     ├────────► 站点 B（备）
                     │
                     └────────► 站点 C（备）
```

---

## 为什么需要它

用第三方 API 中转站的人大概都遇到过两件事：

1. **单点故障** —— 某个站今天抽风，你的程序就挂了，代码一行没改却全线报错
2. **不敢把钱放一处** —— 怕跑路，余额分散在几家，手动切来切去很麻烦

这个工具解决的就是这两件事：**把鸡蛋放在多个篮子里，但对客户端只暴露一个篮子。**

---

## 特点

- **零依赖**：只用 Node.js 内置模块，不需要 `npm install`
- **协议自适应**：按目标端点自动切换 `Bearer` / `x-api-key` / `x-goog-api-key`，OpenAI、Anthropic、Gemini 客户端共用一跳
- **加权轮询**：按 `weight` 分配流量，主力站多承担
- **自动冷却**：某站连续失败 N 次后暂停使用，到期自动恢复
- **健康检查**：`GET /health` 查看每个上游的可用性和成功率
- **流式透传**：SSE 直通，不影响流式输出

---

## 快速验证（不用配任何东西）

```bash
git clone https://github.com/huangjinpeng216/relay-failover
cd relay-failover
node test.mjs
```

它会启动三个假上游（一个总是返回 500、一个正常、一个永不响应），验证切换真的生效：

```
✅ 代理启动并能响应 /health
✅ 上游 500 时自动切换  — status=200
✅ 连续请求仍然成功  — status=200
✅ 健康检查记录失败次数  — fails=1
✅ 健康检查显示整体可用
✅ 异常路径不导致进程崩溃  — status=200
✅ 代理进程存活

7/7 通过
```

这就是核心逻辑的证明：**第一个上游一直是坏的，但客户端拿到的始终是 200。**

---

## 快速开始

```bash
# 1. 复制示例配置
cp config.example.json config.json        # Windows: copy config.example.json config.json

# 2. 编辑 config.json，填 baseUrl 和 apiKey

# 3. 启动
node server.mjs
```

启动后把客户端的 `base_url` 指向 `http://127.0.0.1:8787/v1`，key 随便填（代理会替换成真实 key）。

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

| 图标 | 含义 | 怎么办 |
|---|---|---|
| ✅ | 可用 | — |
| 🔑 | key 无效或无权限 | 检查 key 有没有多余空格 |
| 💥 | 上游 5xx | 站点自己的问题 |
| ⏳ | 被限流（429） | 降低调用频率 |
| ❌ | 超时或连不上 | 检查 baseUrl 和本机网络 |

---

## 配置说明

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | 8787 | 本地监听端口 |
| `host` | 127.0.0.1 | 只监听本机。局域网用改 0.0.0.0 |
| `timeoutMs` | 60000 | 单个上游超时 |
| `cooldownMs` | 60000 | 失败后的冷却时长 |
| `maxConsecutiveFails` | 3 | 连续失败几次开始冷却 |

### upstreams

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 显示用 |
| `baseUrl` | 是 | 站点地址，带不带 `/v1` 都行（会自动去重） |
| `apiKey` | 是 | 该站的 key |
| `anthropicKey` | 否 | 走 Anthropic 协议时的 key，不填则用 `apiKey` |
| `weight` | 否 | 权重，默认 1。主力站可设 2 或 3 |

---

## 故障转移是怎么触发的

| 情况 | 行为 |
|---|---|
| 上游返回 5xx | 标记失败，切下一个 |
| 上游超时 | 标记失败，切下一个 |
| 连接失败 / DNS 错误 | 标记失败，切下一个 |
| 上游返回 429 | **直接返回给客户端**（限流换站也没用，反而增加成本） |
| 上游返回 401 / 403 | **直接返回给客户端**（key 有问题，换站解决不了） |
| 其他 4xx | 直接返回（是请求本身的问题） |

连续失败达到 `maxConsecutiveFails` 后进入冷却期，期间不再分配流量。

**这条判断表是设计核心**：什么该切、什么不该切，决定了这个代理是「有用」还是「有害」。

---

## 常见错误

### 1. 找不到配置文件

你没建 config.json。示例只是模板：

```bash
cp config.example.json config.json
```

### 2. `Invalid character in header content ["authorization"]`

`apiKey` 里还有中文占位符（比如 `sk-把这里换成你的key`）。Node 往 HTTP header 塞非 ASCII 字符会直接抛异常。换成真实 key 即可。

> 新版已在请求前拦截，会提示「apiKey 含非 ASCII 字符」，不会崩。

### 3. `EADDRINUSE :::8787`

端口被占。换一个：

```bash
PORT=8790 node server.mjs          # macOS / Linux
$env:PORT=8790; node server.mjs    # Windows PowerShell
```

### 4. 客户端报 404，但 `/health` 是好的

`base_url` 填错了：

| 客户端 | base_url |
|---|---|
| NextChat / Cherry Studio / LobeChat | `http://127.0.0.1:8787/v1` |
| **Claude Code** | `http://127.0.0.1:8787`（**不带 /v1**） |

很多客户端会自己拼 `/chat/completions`，多写 `/v1` 就变成 `/v1/v1/chat/completions`。

### 5. 所有上游都 ❌，但站点在浏览器能打开

大概率走了系统代理。开着 Clash / Hiddify 时 Node 可能也走代理：

```bash
NO_PROXY="*" node server.mjs        # macOS / Linux
$env:NO_PROXY="*"; node server.mjs  # Windows PowerShell
```

---

## 注意

- `config.json` 里集中了多个站的 key，**不要提交到 git**（已在 `.gitignore`）
- 默认只监听 `127.0.0.1`，别改成 `0.0.0.0` 暴露公网
- 它不改变计费方式，只负责把请求路由到可用的站

---

## 相关阅读

- [AI API 价格与选站指南](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/) — 倍率怎么算、选站五项标准
- [DeepSeek / GLM / Kimi 官方价格表](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/api-price-table.html) — 8 个模型官方单价，含缓存命中价
- [中转站避雷指南](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/api-relay-pitfalls.html) — 包括「网站正常但 API 全挂」这种最容易被误判的故障
- [为什么需要 API 故障转移层](https://huangjinpeng216.github.io/ai-api-relay-pricing-cn/failover-guide.html) — 本工具要解决的问题，含一次真实故障复盘

---

## License

MIT
