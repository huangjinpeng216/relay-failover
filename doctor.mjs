#!/usr/bin/env node
/**
 * relay-failover doctor — 逐个检查配置里的站点是否可用
 *
 * 用法：
 *   node doctor.mjs                    # 检查 config.json 里的所有站点
 *   node doctor.mjs ./my-config.json
 *
 * 每个站点会请求 /v1/models，报告：能否连通、状态码、延迟、返回的模型数量。
 * 不消耗 token（/v1/models 是免费接口），所以可以放心反复跑。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.argv[2] || path.join(__dirname, 'config.json');

if (!fs.existsSync(cfgPath)) {
  console.error(`找不到配置文件：${cfgPath}`);
  const examplePath = path.join(path.dirname(cfgPath), 'config.example.json');
  if (fs.existsSync(examplePath)) {
    console.error('先复制示例配置，再填入你自己的站点：');
    console.error('  cp config.example.json config.json');
    console.error('然后编辑 config.json 填 baseUrl 和 apiKey。');
  } else {
    console.error('用法：node doctor.mjs [config.json 路径]');
  }
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!Array.isArray(cfg.upstreams) || cfg.upstreams.length === 0) {
  console.error('config.upstreams 必须是至少包含一个站点的数组，例如：');
  console.error('  "upstreams": [{ "name": "a", "baseUrl": "https://站点/v1", "apiKey": "sk-..." }]');
  process.exit(1);
}
const upstreams = cfg.upstreams;

const TIMEOUT = Number(cfg.timeoutMs || 20000);

function probe(u) {
  // 与 server.mjs 保持一致：允许每个上游单独覆盖超时
  const timeout = Number(u.timeoutMs || TIMEOUT);
  return new Promise((resolve) => {
    const base = String(u.baseUrl || '').replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? base + '/models' : base + '/v1/models';
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ ok: false, reason: 'baseUrl 非法', ms: 0 });
    }
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const started = Date.now();

    const headers = { accept: 'application/json' };
    const key = u.apiKey || '';
    // 占位符里常带中文，Node 会在设置 header 时抛 ERR_INVALID_CHAR，先拦下来
    if (/[^\x20-\x7E]/.test(key)) {
      return resolve({ ok: false, reason: 'apiKey 含非 ASCII 字符（大概是还没换成真实 key）', ms: 0 });
    }
    if (key) headers.authorization = `Bearer ${key}`;
    if (u.anthropicKey) {
      if (/[^\x20-\x7E]/.test(u.anthropicKey)) {
        return resolve({ ok: false, reason: 'anthropicKey 含非 ASCII 字符', ms: 0 });
      }
      headers['x-api-key'] = u.anthropicKey;
    }
    headers['user-agent'] = 'relay-failover-doctor';

    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Date.now() - started;
          const body = Buffer.concat(chunks).toString();
          let models = null;
          try {
            const j = JSON.parse(body);
            if (Array.isArray(j.data)) models = j.data.length;
            else if (Array.isArray(j.models)) models = j.models.length;
          } catch {}
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            ms,
            models,
            snippet: body.slice(0, 120).replace(/\s+/g, ' '),
          });
        });
      },
    );

    req.setTimeout(timeout, () => req.destroy(new Error(`超时 ${timeout}ms`)));
    req.on('error', (e) => resolve({ ok: false, reason: e.message, ms: Date.now() - started }));
    req.end();
  });
}

function icon(r) {
  if (r.ok) return '✅';
  if (r.status === 401 || r.status === 403) return '🔑';
  if (r.status === 429) return '⏳';
  if (r.status >= 500) return '💥';
  return '❌';
}

console.log(`检查 ${upstreams.length} 个站点（每站请求一次 /v1/models，不消耗 token）\n`);

const rows = [];
for (const u of upstreams) {
  const r = await probe(u);
  let note = '';
  if (r.reason) note = r.reason;
  else if (r.status === 401 || r.status === 403) note = 'key 无效或无权限';
  else if (r.status === 429) note = '被限流';
  else if (!r.ok) note = `HTTP ${r.status}`;
  else if (r.models === 0) note = '返回 0 个模型（可能分组无权限）';
  else if (r.models != null) note = `${r.models} 个模型`;

  rows.push({ name: u.name || u.baseUrl, ok: r.ok, ms: r.ms, note, icon: icon(r) });
  console.log(`${icon(r)} ${String(u.name || u.baseUrl).padEnd(14)} ${String(r.ms + 'ms').padStart(7)}  ${note}`);
}

const okCount = rows.filter((r) => r.ok).length;
console.log(`\n可用 ${okCount}/${rows.length}`);

if (okCount === 0) {
  console.log('\n全部不可用。检查：');
  console.log('  1. baseUrl 是否写错（多数站点是 https://域名/v1）');
  console.log('  2. key 是否复制完整、有没有多余空格');
  console.log('  3. 本机网络/代理是否把请求拦了');
  process.exit(1);
}

if (okCount < rows.length) {
  console.log('\n部分不可用属于正常——故障转移的价值正是在这里：');
  console.log('  可用数 ≥ 1 时，客户端不会感知到故障。');
}

// 延迟分布
const lat = rows.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
if (lat.length) {
  const p50 = lat[Math.floor(lat.length * 0.5)];
  const max = lat[lat.length - 1];
  console.log(`\n延迟：中位 ${p50}ms，最慢 ${max}ms（单次采样，仅供参考）`);
}
