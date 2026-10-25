# relay-failover

把多个 OpenAI 兼容站点组成一个池子，对外只暴露一个地址。**上游超时、5xx、断流时自动切换下一个，客户端无感知。**

```
你的客户端 ──► relay-failover ──► 站点 A（主）
                     │
                     ├────────► 站点 B（备）
                     │
                     └────────► 站点 C（备）
```

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

## 注意

- 本工具把多个站的 key 集中在一个本地文件里，`config.json` **不要提交到 git**（已加 `.gitignore`）
- 默认只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到公网，否则别人能白嫖你的额度
- 它不改变计费方式，只是帮你把请求路由到可用的站

---

## 示例配置

`config.example.json` 里默认填了一个示例上游（`l7shop.xyz`，0.1x 倍率，OpenAI / Anthropic / Gemini 三协议）。你可以留着，也可以全换成自己的。

---

## License

MIT
