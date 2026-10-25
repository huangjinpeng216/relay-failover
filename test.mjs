#!/usr/bin/env node
/**
 * 自测：启动两个假上游（一个总是 500，一个正常），验证故障转移真的生效。
 * 运行：node test.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

function startMock(port, behaviour) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (behaviour === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream down' } }));
      } else if (behaviour === 'slow') {
        // 永不响应，用来测超时
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock-ok',
            object: 'chat.completion',
            choices: [{ message: { role: 'assistant', content: 'hello from mock' } }],
          }),
        );
      }
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function waitReady(url, tries = 40) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (++n >= tries) return reject(new Error('proxy 未就绪'));
        setTimeout(tick, 150);
      });
      req.setTimeout(500, () => req.destroy());
    };
    tick();
  });
}

function callProxy(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.write(JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }));
    req.end();
  });
}

const P_FAIL = 18801;
const P_OK = 18802;
const P_SLOW = 18803;
const PROXY = 18800;

const mock1 = await startMock(P_FAIL, 'fail');
const mock2 = await startMock(P_OK, 'ok');
const mock3 = await startMock(P_SLOW, 'slow');

// 三个假上游：第一个必失败、第二个正常、第三个永不响应
const cfg = {
  port: PROXY,
  host: '127.0.0.1',
  timeoutMs: 1500,
  cooldownMs: 3000,
  maxConsecutiveFails: 2,
  verbose: false,
  upstreams: [
    { name: 'always-fail', baseUrl: `http://127.0.0.1:${P_FAIL}/v1`, apiKey: 'sk-fail' },
    { name: 'healthy', baseUrl: `http://127.0.0.1:${P_OK}/v1`, apiKey: 'sk-ok' },
    { name: 'never-respond', baseUrl: `http://127.0.0.1:${P_SLOW}/v1`, apiKey: 'sk-slow', timeoutMs: 800 },
  ],
};
const cfgFile = path.join(__dirname, 'config.test.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

const proxy = spawn(process.execPath, [path.join(__dirname, 'server.mjs'), cfgFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let proxyLog = '';
proxy.stdout.on('data', (d) => (proxyLog += d.toString()));
proxy.stderr.on('data', (d) => (proxyLog += d.toString()));
proxy.on('error', (e) => console.error('启动 proxy 失败', e));

try {
  await waitReady(`http://127.0.0.1:${PROXY}/health`);
  check('代理启动并能响应 /health', true);

  // 场景 1：第一个上游返回 500，应该自动切到健康的那家
  const r1 = await callProxy(PROXY, '/v1/chat/completions');
  check('上游 500 时自动切换', r1.status === 200 && r1.body.includes('hello from mock'), `status=${r1.status}`);

  // 场景 2：连续调用，仍然成功（说明 failover 稳定）
  const r2 = await callProxy(PROXY, '/v1/chat/completions');
  check('连续请求仍然成功', r2.status === 200, `status=${r2.status}`);

  // 场景 3：健康检查里能看到失败的那个被标记
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PROXY}/health`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).on('error', reject);
  });
  const failUp = health.upstreams.find((u) => u.name === 'always-fail');
  check('健康检查记录失败次数', failUp && failUp.fails > 0, `fails=${failUp?.fails}`);
  check('健康检查显示整体可用', health.ok === true);

  // 场景 4：不存在的路径也不该崩
  const r4 = await callProxy(PROXY, '/v1/nonexistent').catch(() => ({ status: 'error' }));
  check('异常路径不导致进程崩溃', r4.status !== 'error', `status=${r4.status}`);

  // 场景 5：进程还活着
  check('代理进程存活', !proxy.killed && proxy.exitCode === null);
} catch (e) {
  check('测试执行', false, e.message);
} finally {
  proxy.kill();
  mock1.close(); mock2.close(); mock3.close();
  try { fs.unlinkSync(cfgFile); } catch {}
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  if (proxyLog.trim()) {
    console.log('\n--- 代理日志 ---');
    console.log(proxyLog.trim().split('\n').slice(0, 20).join('\n'));
  }
  process.exit(passed === results.length ? 0 : 1);
}
