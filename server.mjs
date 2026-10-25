#!/usr/bin/env node
/**
 * relay-failover — 多中转站自动故障转移代理
 *
 * 把多个 OpenAI 兼容站点组成一个池子，对外只暴露一个地址。
 * 上游超时 / 5xx / 网络错误时自动切换下一个，客户端无感知。
 *
 * 用法：
 *   node server.mjs                  # 读取同目录 config.json
 *   node server.mjs ./my-config.json
 *   PORT=8787 node server.mjs
 *
 * 只依赖 Node.js 内置模块，无需 npm install。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
const configPath = process.argv[2] || path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`找不到配置文件：${configPath}`);
  console.error('请复制 config.example.json 为 config.json 并填入你的站点信息。');
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`配置文件不是合法 JSON：${e.message}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT || cfg.port || 8787);
const HOST = cfg.host || '127.0.0.1';
const TIMEOUT_MS = Number(cfg.timeoutMs || 60000);
const COOLDOWN_MS = Number(cfg.cooldownMs || 60000);
const MAX_FAILS = Number(cfg.maxConsecutiveFails || 3);
const VERBOSE = cfg.verbose !== false;

const upstreams = (cfg.upstreams || []).map((u) => ({
  name: u.name || u.baseUrl,
  baseUrl: String(u.baseUrl || '').replace(/\/+$/, ''),
  apiKey: u.apiKey || '',
  anthropicKey: u.anthropicKey || u.apiKey || '',
  weight: Number(u.weight || 1),
  timeoutMs: Number(u.timeoutMs || TIMEOUT_MS),
  // 运行时状态
  fails: 0,
  cooldownUntil: 0,
  total: 0,
  ok: 0,
}));

if (!upstreams.length) {
  console.error('config.upstreams 为空，至少配置一个站点。');
  process.exit(1);
}

// ---------- 健康状态 ----------
function isAvailable(u, now = Date.now()) {
  return now >= u.cooldownUntil;
}

function markSuccess(u) {
  u.ok += 1;
  u.fails = 0;
  u.cooldownUntil = 0;
}

function markFail(u, reason) {
  u.fails += 1;
  if (u.fails >= MAX_FAILS) {
    u.cooldownUntil = Date.now() + COOLDOWN_MS;
    log(`⚠ ${u.name} 连续失败 ${u.fails} 次（${reason}），冷却 ${Math.round(COOLDOWN_MS / 1000)}s`);
  }
}

function log(...args) {
  if (VERBOSE) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${t}]`, ...args);
  }
}

// 按权重做加权轮询的起点偏移
let rrCursor = 0;
function orderedUpstreams() {
  const now = Date.now();
  const alive = upstreams.filter((u) => isAvailable(u, now));
  const pool = alive.length ? alive : upstreams; // 全部冷却时硬着头皮用
  // 展开成权重数组
  const expanded = [];
  for (const u of pool) for (let i = 0; i < Math.max(1, u.weight); i++) expanded.push(u);
  const start = rrCursor % expanded.length;
  rrCursor += 1;
  const seq = [];
  const seen = new Set();
  for (let i = 0; i < expanded.length; i++) {
    const u = expanded[(start + i) % expanded.length];
    if (seen.has(u)) continue;
    seen.add(u);
    seq.push(u);
  }
  return seq;
}

// ---------- 转发 ----------
function forward(upstream, req, bodyBuf) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      // baseUrl 可能已经带 /v1（用户习惯这么填），而客户端请求也带 /v1，
      // 直接拼接会变成 /v1/v1/...，这里做去重。
      const base = upstream.baseUrl.replace(/\/+$/, '');
      const reqPath = req.url || '/';
      const joiner = base.endsWith('/v1') && reqPath.startsWith('/v1') ? base.slice(0, -3) : base;
      target = new URL(joiner + reqPath);
    } catch {
      return reject(new Error('baseUrl 非法'));
    }
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;

    const headers = { ...req.headers };
    delete headers.host;
    // 我们已经把请求体读成完整 buffer，必须用 content-length 重发；
    // 若同时保留 transfer-encoding，上游会直接返回 400。
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['connection'];
    // 按目标协议替换鉴权头
    delete headers['x-api-key'];
    delete headers['x-goog-api-key'];
    headers['content-length'] = String(Buffer.byteLength(bodyBuf));
    headers['connection'] = 'close';

    const usesAnthropic = /\/v1\/messages(\?|$)/.test(req.url || '');
    const usesGemini = /\/v1beta\//.test(req.url || '');

    if (usesAnthropic && upstream.anthropicKey) {
      headers['x-api-key'] = upstream.anthropicKey;
      delete headers['authorization'];
    } else if (usesGemini) {
      headers['x-goog-api-key'] = upstream.anthropicKey || upstream.apiKey;
      delete headers['authorization'];
    } else {
      headers['authorization'] = `Bearer ${upstream.apiKey}`;
    }

    const started = Date.now();
    const preq = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (pres) => {
        const latency = Date.now() - started;
        pres.on('end', () => {});
        resolve({ pres, latency });
      },
    );

    preq.setTimeout(upstream.timeoutMs, () => {
      preq.destroy(new Error(`超时 ${upstream.timeoutMs}ms`));
    });
    preq.on('error', reject);
    if (bodyBuf.length) preq.write(bodyBuf);
    preq.end();
  });
}

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
  // 健康检查
  if (req.url === '/health' || req.url === '/failover/health') {
    const now = Date.now();
    const payload = {
      ok: upstreams.some((u) => isAvailable(u, now)),
      upstreams: upstreams.map((u) => ({
        name: u.name,
        available: isAvailable(u, now),
        fails: u.fails,
        successRate: u.total ? Number((u.ok / u.total).toFixed(3)) : null,
        requests: u.total,
        cooldownSeconds: u.cooldownUntil > now ? Math.ceil((u.cooldownUntil - now) / 1000) : 0,
      })),
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // 收集请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);

  const seq = orderedUpstreams();
  const errors = [];

  for (const u of seq) {
    u.total += 1;
    try {
      const { pres, latency } = await forward(u, req, bodyBuf);

      // 5xx 视为上游故障，切换
      if (pres.statusCode >= 500) {
        markFail(u, `HTTP ${pres.statusCode}`);
        errors.push(`${u.name}: HTTP ${pres.statusCode}`);
        pres.resume(); // 丢弃响应体
        continue;
      }

      // 401/403 说明 key 有问题，也标记失败但直接返回给客户端（换站也没用）
      if (pres.statusCode === 401 || pres.statusCode === 403) {
        markFail(u, `HTTP ${pres.statusCode}`);
        res.writeHead(pres.statusCode, pres.headers);
        return pres.pipe(res);
      }

      markSuccess(u);
      log(`→ ${u.name} ${req.method} ${req.url} ${pres.statusCode} ${latency}ms`);
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
      return;
    } catch (e) {
      markFail(u, e.message);
      errors.push(`${u.name}: ${e.message}`);
      continue;
    }
  }

  // 全部失败
  log(`✗ 全部上游失败：${errors.join(' | ')}`);
  res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify(
      {
        error: {
          type: 'upstream_unavailable',
          message: '所有上游站点均失败，请查看 /health',
          attempts: errors,
        },
      },
      null,
      2,
    ),
  );
});

server.listen(PORT, HOST, () => {
  console.log(`relay-failover 已启动：http://${HOST}:${PORT}`);
  console.log(`上游站点 ${upstreams.length} 个：`);
  for (const u of upstreams) console.log(`  - ${u.name}  ${u.baseUrl}  weight=${u.weight}`);
  console.log(`健康检查：http://${HOST}:${PORT}/health`);
  console.log(`把客户端的 base_url 指向 http://${HOST}:${PORT}/v1 即可。`);
});
