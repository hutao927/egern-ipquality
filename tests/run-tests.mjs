/**
 * Behavioural tests for the bundled IPQuality scripts.
 *
 * Usage: node tests/run-tests.mjs
 */

import { strict as assert } from 'node:assert';
import { makeCtx, load, createRunner, makeResponse } from './harness.mjs';

const t = createRunner();
const report = await load('ipquality.js');
const widget = await load('ipquality-widget.js');
const net = await load('ipquality-net.js');
const nodes = await load('ipquality-nodes.js');

/* ===================================================================
 * Main report
 * =================================================================== */

t.section('ipquality.js — report');

await t.test('renders all six sections', async () => {
  const result = await report(makeCtx());
  assert.equal(result.type, 'text');
  for (const heading of [
    '# 🌐 IP 质量体检报告',
    '## 一、基础信息',
    '## 二、风险评分',
    '## 三、风险因子',
    '## 四、流媒体及 AI 服务解锁',
    '## 五、邮局服务连通性',
  ]) {
    assert.ok(result.text.includes(heading), `missing: ${heading}`);
  }
  assert.ok(result.text.includes('AS64500'), 'ASN shown');
  assert.ok(result.text.includes('Example Telecom'), 'org shown');
});

await t.test('masks the IP unless SHOW_FULL_IP is set', async () => {
  const masked = await report(makeCtx());
  assert.ok(masked.text.includes('203.0.*.*'), 'masked form');
  assert.ok(!masked.text.includes('203.0.113.45'), 'full IP hidden');

  const full = await report(makeCtx({ env: { SHOW_FULL_IP: 'true' } }));
  assert.ok(full.text.includes('203.0.113.45'), 'full IP shown');
});

await t.test('reports a risk score with per-database breakdown', async () => {
  const result = await report(makeCtx());
  assert.ok(/综合评分/.test(result.text), 'aggregate score present');
  assert.ok(result.text.includes('ip-api.com'), 'ip-api.com row');
  assert.ok(result.text.includes('ipapi.is'), 'ipapi.is row');
  assert.ok(!result.text.includes('综合评分：🟢 0/100'), 'datacenter is not scored 0');
});

/* ===================================================================
 * Improved service detection — the accuracy work
 * =================================================================== */

t.section('ipquality.js — service detection accuracy');

await t.test('ChatGPT uses Cloudflare trace loc, not a blind status code', async () => {
  const result = await report(makeCtx());
  const line = result.text.split('\n').find((l) => l.startsWith('| ChatGPT'));
  assert.ok(line, 'ChatGPT row present');
  assert.ok(line.includes('✅ 解锁'), `expected unlock, got: ${line}`);
  assert.ok(line.includes('JP'), 'region read from trace');
  assert.ok(line.includes('Cloudflare trace'), 'detection method disclosed');
});

await t.test('ChatGPT reads as blocked for a restricted region', async () => {
  const ctx = makeCtx({
    overrides: { 'https://chatgpt.com/cdn-cgi/trace': 'fl=1\nip=1.2.3.4\nloc=CN\n' },
  });
  const result = await report(ctx);
  const line = result.text.split('\n').find((l) => l.startsWith('| ChatGPT'));
  assert.ok(line.includes('⛔️ 屏蔽'), `expected blocked, got: ${line}`);
  assert.ok(line.includes('CN'), 'region shown');
});

await t.test('Netflix inspects two titles and detects partial catalogs', async () => {
  // One title works, one is geo-blocked => partial, not a flat "no".
  const ctx = makeCtx({
    overrides: {
      'https://www.netflix.com/title/81280792': { __status: 200, __text: '<html>LEGO Ninjago</html>' },
      'https://www.netflix.com/title/70143836': { __status: 200, __text: '<html>Oh no!</html>' },
    },
  });
  const result = await report(ctx);
  const line = result.text.split('\n').find((l) => l.startsWith('| Netflix'));
  assert.ok(line.includes('⚠️ 部分'), `expected partial, got: ${line}`);
  assert.ok(line.includes('部分剧集受限'), 'explains why');
});

await t.test('Netflix reports full availability when both titles work', async () => {
  const result = await report(makeCtx());
  const line = result.text.split('\n').find((l) => l.startsWith('| Netflix'));
  assert.ok(line.includes('✅ 解锁'), `expected unlock, got: ${line}`);
});

await t.test('YouTube Premium reads INNERTUBE_CONTEXT_GL and the ad-free marker', async () => {
  const result = await report(makeCtx());
  const line = result.text.split('\n').find((l) => l.startsWith('| YouTube'));
  assert.ok(line.includes('✅ 解锁'), `expected unlock, got: ${line}`);
  assert.ok(line.includes('JP'), 'region parsed');
});

await t.test('YouTube Premium detects the google.cn redirect as blocked', async () => {
  const ctx = makeCtx({
    overrides: {
      'https://www.youtube.com/premium': { __status: 200, __text: '<html>www.google.cn</html>' },
    },
  });
  const result = await report(ctx);
  const line = result.text.split('\n').find((l) => l.startsWith('| YouTube'));
  assert.ok(line.includes('⛔️ 屏蔽'), `expected blocked, got: ${line}`);
});

await t.test('Disney+ performs the device-assertion handshake', async () => {
  const ctx = makeCtx();
  const result = await report(ctx);
  const line = result.text.split('\n').find((l) => l.startsWith('| Disney+'));
  assert.ok(line.includes('✅ 解锁'), `expected unlock, got: ${line}`);
  assert.ok(line.includes('JP'), 'countryCode parsed from graphql');
  // It must have called all three handshake stages.
  const urls = ctx.__calls.map((c) => c.url);
  assert.ok(urls.some((u) => u.includes('/devices')), 'devices stage');
  assert.ok(urls.some((u) => u.includes('/token')), 'token stage');
  assert.ok(urls.some((u) => u.includes('/graphql')), 'graphql stage');
});

await t.test('Disney+ reports a ban when the device stage returns 403', async () => {
  const ctx = makeCtx({
    overrides: {
      'https://disney.api.edge.bamgrid.com/devices': { __status: 200, __text: '<html>403 ERROR</html>' },
    },
  });
  const result = await report(ctx);
  const line = result.text.split('\n').find((l) => l.startsWith('| Disney+'));
  assert.ok(line.includes('⛔️ 屏蔽'), `expected blocked, got: ${line}`);
  assert.ok(line.includes('封禁'), 'explains the ban');
});

await t.test('PrimeVideo reads currentTerritory', async () => {
  const result = await report(makeCtx());
  const line = result.text.split('\n').find((l) => l.startsWith('| Amazon Prime Video'));
  assert.ok(line.includes('✅ 解锁'), `expected unlock, got: ${line}`);
  assert.ok(line.includes('JP'), 'territory parsed');
});

await t.test('PrimeVideo reports service restriction', async () => {
  const ctx = makeCtx({
    overrides: {
      'https://www.primevideo.com': { __status: 200, __text: '<html>isServiceRestricted</html>' },
    },
  });
  const result = await report(ctx);
  const line = result.text.split('\n').find((l) => l.startsWith('| Amazon Prime Video'));
  assert.ok(line.includes('⛔️ 屏蔽'), `expected blocked, got: ${line}`);
});

await t.test('unreachable services are UNKNOWN, not falsely blocked', async () => {
  const ctx = makeCtx({ failServices: true });
  const result = await report(ctx);
  assert.ok(result.text.includes('❔ 未知'), 'unknown state used');
  assert.ok(!/\| ChatGPT \| ⛔️/.test(result.text), 'ChatGPT not falsely blocked');
  assert.ok(result.text.includes('不代表被屏蔽'), 'report explains the distinction');
});

await t.test('the summary separates unlocked / blocked / partial / unknown', async () => {
  const result = await report(makeCtx());
  assert.ok(/\*\*汇总：解锁 \d+ · 屏蔽 \d+ · 部分 \d+ · 未知 \d+\*\*/.test(result.text), 'summary line present');
});

await t.test('ONLY_SERVICES limits which probes run', async () => {
  const ctx = makeCtx({ env: { ONLY_SERVICES: 'chatgpt' } });
  const result = await report(ctx);
  const serviceSection = result.text.split('## 四、')[1] || '';
  assert.ok(serviceSection.includes('ChatGPT'), 'ChatGPT probed');
  assert.ok(!serviceSection.includes('Netflix'), 'Netflix skipped');
});

/* ===================================================================
 * Options & output modes
 * =================================================================== */

t.section('ipquality.js — options');

await t.test('SKIP_SERVICES / SKIP_MAIL omit sections and renumber', async () => {
  const result = await report(makeCtx({ env: { SKIP_SERVICES: 'true', SKIP_MAIL: 'true' } }));
  assert.ok(!result.text.includes('流媒体及 AI 服务解锁'), 'services omitted');
  assert.ok(!result.text.includes('邮局服务连通性'), 'mail omitted');
  assert.ok(result.text.includes('## 三、风险因子'), 'earlier sections kept');
  assert.ok(!result.text.includes('## 四、'), 'no numbering gap');
});

await t.test('OUTPUT=json yields a structured payload matching the -j schema', async () => {
  const result = await report(makeCtx({ env: { OUTPUT: 'json' } }));
  const j = JSON.parse(result.text);
  assert.equal(j.Info.ASN, 'AS64500');
  assert.equal(j.Head.IP, '203.0.*.*');
  assert.ok(j.Score.Databases['ip-api.com'] !== undefined, 'per-db scores');
  assert.ok(Array.isArray(j.Services) && j.Services.length > 0, 'services array');
  assert.ok(j.Services.every((s) => 'Status' in s), 'status field');
});

await t.test('notification carries a clipboard action with the full report', async () => {
  const ctx = makeCtx();
  await report(ctx);
  assert.equal(ctx.__notifications.length, 1, 'one notification');
  const note = ctx.__notifications[0];
  assert.ok(note.title.includes('IP 质量'), 'title');
  assert.equal(note.action.type, 'clipboard', 'clipboard action');
  assert.ok(note.action.text.length > 200, 'full report copied');
});

await t.test('NOTIFY=false suppresses notifications', async () => {
  const ctx = makeCtx({ env: { NOTIFY: 'false' } });
  await report(ctx);
  assert.equal(ctx.__notifications.length, 0);
});

await t.test('IP_VERSION=6 only probes IPv6 echo endpoints', async () => {
  const ctx = makeCtx({
    env: { IP_VERSION: '6' },
    overrides: { 'https://api.ipv6.ip.sb/ip': '2001:db8::1\n' },
  });
  await report(ctx);
  const urls = ctx.__calls.map((c) => c.url);
  assert.ok(urls.some((u) => u.includes('ipv6')), 'v6 endpoint tried');
  assert.ok(!urls.some((u) => u === 'https://ipv4.icanhazip.com'), 'v4 endpoint skipped');
});

/* ===================================================================
 * Resilience
 * =================================================================== */

t.section('ipquality.js — resilience');

await t.test('writes the widget cache after a successful run', async () => {
  const ctx = makeCtx();
  await report(ctx);
  const cached = ctx.storage.getJSON('ipquality:last');
  assert.ok(cached && cached.model, 'cache written');
  assert.ok(cached.summary.includes('203.0.*.*'), 'summary');
  assert.ok(cached.at, 'timestamped');
});

await t.test('degrades gracefully when every API fails', async () => {
  const ctx = makeCtx({ failAll: true });
  const result = await report(ctx);
  assert.equal(result.type, 'text');
  assert.ok(
    result.text.includes('无法检测出口 IP') || result.text.includes('数据源不可达'),
    `friendly failure, got: ${result.text.slice(0, 120)}`,
  );
  assert.equal(ctx.__notifications.length, 1, 'notifies on failure');
});

await t.test('falls back to the cached summary when providers fail', async () => {
  const seed = { 'ipquality:last': JSON.stringify({ summary: '203.0.*.* · 12/100', at: new Date().toISOString(), model: {} }) };
  const ctx = makeCtx({ failAll: true, storageSeed: seed });
  const result = await report(ctx);
  assert.ok(result.text.includes('上次成功结果'), 'mentions the previous result');
});

/* ===================================================================
 * IP change tracking
 * =================================================================== */

t.section('ipquality.js — IP change tracking');

await t.test('records history on the first run', async () => {
  const ctx = makeCtx();
  await report(ctx);
  const history = ctx.storage.getJSON('ipquality:ipHistory');
  assert.equal(history.length, 1, 'one record');
  assert.equal(history[0].ip, '203.0.113.45');
  assert.equal(history[0].country, 'JP');
});

await t.test('a second run with the same IP does not append history', async () => {
  const ctx = makeCtx();
  await report(ctx);
  await report(ctx);
  const history = ctx.storage.getJSON('ipquality:ipHistory');
  assert.equal(history.length, 1, 'unchanged IP is not re-recorded');
});

await t.test('an IP change adds history and surfaces a change section', async () => {
  const first = makeCtx();
  await report(first);
  const seed = Object.fromEntries(first.__store);

  const second = makeCtx({
    storageSeed: seed,
    overrides: {
      'https://api.ip.sb/ip': '198.51.100.7\n',
      'https://ipinfo.io/ip': '198.51.100.7\n',
      'http://ip-api.com/json/198.51.100.7': {
        status: 'success', country: 'United States', countryCode: 'US', city: 'Ashburn',
        regionName: 'Virginia', as: 'AS14618 AMAZON', isp: 'Amazon', proxy: true, hosting: true,
        timezone: 'America/New_York', lat: 39.0, lon: -77.5,
      },
      'https://api.ipapi.is/?q=198.51.100.7': {
        ip: '198.51.100.7', is_datacenter: true, is_proxy: true,
        location: { country: 'United States', country_code: 'US' },
        asn: { asn: 14618, descr: 'AMAZON' }, company: { name: 'Amazon' },
      },
      'https://ipinfo.io/198.51.100.7/json': { ip: '198.51.100.7', country: 'US' },
    },
  });

  const result = await report(second);
  assert.ok(result.text.includes('## 六、出口 IP 变化'), 'change section present');
  assert.ok(result.text.includes('198.51.*.*'), 'new IP shown');

  const history = second.storage.getJSON('ipquality:ipHistory');
  assert.equal(history.length, 2, 'history appended');
  assert.equal(history[1].country, 'US');
});

await t.test('TRACK_HISTORY=false disables recording', async () => {
  const ctx = makeCtx({ env: { TRACK_HISTORY: 'false' } });
  await report(ctx);
  assert.equal(ctx.storage.getJSON('ipquality:ipHistory'), null, 'no history written');
});

/* ===================================================================
 * Widget
 * =================================================================== */

t.section('ipquality.js — widget mode');

await t.test('returns a widget tree and does not notify', async () => {
  const ctx = makeCtx({ widgetFamily: 'systemMedium' });
  const result = await report(ctx);
  assert.equal(result.type, 'widget');
  assert.ok(result.refreshAfter, 'refresh hint set');
  assert.equal(ctx.__notifications.length, 0, 'widgets stay silent');
});

t.section('ipquality-widget.js');

await t.test('warm cache renders with zero network calls', async () => {
  const warm = makeCtx();
  await report(warm);
  const ctx = makeCtx({ widgetFamily: 'systemMedium', storageSeed: Object.fromEntries(warm.__store) });
  const result = await widget(ctx);
  assert.equal(result.type, 'widget');
  assert.equal(ctx.__calls.length, 0, 'no HTTP with a fresh cache');
});

await t.test('stale cache triggers a refresh and rewrites the cache', async () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const model = {
    ip: '203.0.113.45', family: 4, score: { total: 9, level: 'VeryLow', entries: [] },
    ipType: { label: '机房 IP' }, usageType: { label: '机房', key: 'hosting' },
    signals: { ipApiCom: { source: 'ip-api.com', country: 'JP', asn: 64500, isp: 'Example' } },
    services: [], mail: [], meta: {},
  };
  const ctx = makeCtx({
    widgetFamily: 'systemMedium',
    storageSeed: { 'ipquality:last': JSON.stringify({ at: old, model, summary: 'old' }) },
  });
  const result = await widget(ctx);
  assert.equal(result.type, 'widget');
  assert.ok(ctx.__calls.length > 0, 'stale cache refreshes');
  const after = ctx.storage.getJSON('ipquality:last');
  assert.ok(Date.parse(after.at) > Date.parse(old), 'cache timestamp refreshed');
});

await t.test('stale cache is used when the refresh fails, and labelled', async () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const model = {
    ip: '203.0.113.45', family: 4, score: { total: 42, level: 'Medium', entries: [] },
    ipType: { label: '广播 IP' }, usageType: { label: '机房', key: 'hosting' },
    signals: { ipApiCom: { source: 'ip-api.com', country: 'JP', asn: 64500 } },
    services: [], mail: [], meta: {},
  };
  const ctx = makeCtx({
    widgetFamily: 'systemMedium',
    failAll: true,
    storageSeed: { 'ipquality:last': JSON.stringify({ at: old, model, summary: 'stale' }) },
  });
  const result = await widget(ctx);
  const flat = JSON.stringify(result);
  assert.ok(flat.includes('42'), 'stale score rendered');
  assert.ok(flat.includes('缓存'), 'labelled as cached');
});

await t.test('empty state when there is no cache and no network', async () => {
  const ctx = makeCtx({ widgetFamily: 'systemMedium', failAll: true });
  const result = await widget(ctx);
  assert.ok(JSON.stringify(result).includes('暂无数据'), 'empty state shown');
});

await t.test('AUTO_REFRESH=false never probes', async () => {
  const ctx = makeCtx({ widgetFamily: 'systemMedium', env: { AUTO_REFRESH: 'false' }, failAll: true });
  await widget(ctx);
  assert.equal(ctx.__calls.length, 0, 'no probing when disabled');
});

await t.test('cold cache probes and populates storage', async () => {
  const ctx = makeCtx({ widgetFamily: 'systemMedium' });
  await widget(ctx);
  assert.ok(ctx.__calls.length > 0, 'probed');
  assert.ok(ctx.storage.getJSON('ipquality:last'), 'cache written');
});

/* ===================================================================
 * IP change monitor
 * =================================================================== */

t.section('ipquality-net.js — change monitor');

await t.test('first run records a baseline silently', async () => {
  const ctx = makeCtx();
  const result = await net(ctx);
  assert.equal(result.type, 'text');
  const history = ctx.storage.getJSON('ipquality:ipHistory');
  assert.equal(history.length, 1, 'baseline recorded');
  assert.equal(ctx.__notifications.length, 0, 'silent on first observation');
});

await t.test('an unchanged IP produces no notification by default', async () => {
  const first = makeCtx();
  await net(first);
  const ctx = makeCtx({ storageSeed: Object.fromEntries(first.__store) });
  await net(ctx);
  assert.equal(ctx.__notifications.length, 0, 'quiet when stable');
});

await t.test('NOTIFY_ON_STABLE=true reports a stable IP', async () => {
  const first = makeCtx();
  await net(first);
  const ctx = makeCtx({
    env: { NOTIFY_ON_STABLE: 'true' },
    storageSeed: Object.fromEntries(first.__store),
  });
  await net(ctx);
  assert.equal(ctx.__notifications.length, 1, 'stable notification');
  assert.ok(ctx.__notifications[0].title.includes('无变化'), 'correct title');
});

await t.test('a changed IP notifies with a field-by-field diff', async () => {
  const first = makeCtx();
  await net(first);
  const ctx = makeCtx({
    storageSeed: Object.fromEntries(first.__store),
    overrides: {
      'https://api.ip.sb/ip': '198.51.100.7\n',
      'https://ipinfo.io/ip': '198.51.100.7\n',
      'http://ip-api.com/json/198.51.100.7': {
        status: 'success', country: 'United States', countryCode: 'US', city: 'Ashburn',
        as: 'AS14618 AMAZON', isp: 'Amazon', proxy: true, hosting: true,
      },
      'https://api.ipapi.is/?q=198.51.100.7': {
        ip: '198.51.100.7', is_datacenter: true, is_proxy: true,
        location: { country: 'United States', country_code: 'US' },
        asn: { asn: 14618, descr: 'AMAZON' }, company: { name: 'Amazon' },
      },
    },
  });
  const result = await net(ctx);
  assert.equal(ctx.__notifications.length, 1, 'change notified');
  const note = ctx.__notifications[0];
  assert.ok(note.title.includes('已变化'), `title: ${note.title}`);
  assert.ok(note.body.includes('IP：'), 'IP diff shown');
  assert.ok(note.body.includes('地区：'), 'country diff shown');
  assert.ok(result.text.includes('IP 变化'), 'returned summary');
});

await t.test('switching from residential to datacenter warns about it', async () => {
  // Seed a residential baseline, then switch to a datacenter IP.
  const residential = {
    ip: '198.51.100.99',
    at: new Date().toISOString(),
    country: 'JP',
    asn: 2516,
    org: 'KDDI',
    score: 5,
    level: 'VeryLow',
    hosting: false,
  };
  const ctx = makeCtx({
    storageSeed: { 'ipquality:ipHistory': JSON.stringify([residential]) },
    overrides: {
      'https://api.ip.sb/ip': '198.51.100.7\n',
      'https://ipinfo.io/ip': '198.51.100.7\n',
      'http://ip-api.com/json/198.51.100.7': {
        status: 'success', country: 'United States', countryCode: 'US',
        as: 'AS14618 AMAZON', isp: 'Amazon', hosting: true,
      },
      'https://api.ipapi.is/?q=198.51.100.7': {
        ip: '198.51.100.7', is_datacenter: true,
        location: { country: 'United States', country_code: 'US' },
        asn: { asn: 14618, descr: 'AMAZON' }, company: { name: 'Amazon' },
      },
    },
  });
  await net(ctx);
  const note = ctx.__notifications[0];
  assert.ok(note, 'a notification was sent');
  assert.ok(note.body.includes('机房 IP'), `datacenter warning expected, got: ${note.body}`);
  assert.ok(note.body.includes('类型：住宅/ISP → 机房'), 'type transition shown');
});

await t.test('history is capped by MAX_HISTORY', async () => {
  const ctx = makeCtx({ env: { MAX_HISTORY: '3' } });
  // Seed with a full history, then add one more.
  const seeded = [];
  for (let i = 0; i < 3; i += 1) {
    seeded.push({ ip: `203.0.113.${i}`, at: new Date().toISOString(), country: 'JP', asn: 64500, score: 10 });
  }
  ctx.storage.setJSON('ipquality:ipHistory', seeded);
  await net(ctx);
  const history = ctx.storage.getJSON('ipquality:ipHistory');
  assert.ok(history.length <= 3, `capped at 3, got ${history.length}`);
});

await t.test('monitor survives a total network failure', async () => {
  const ctx = makeCtx({ failAll: true });
  const result = await net(ctx);
  assert.equal(result.type, 'text');
  assert.ok(result.text.includes('失败'), 'reports failure');
});

/* ===================================================================
 * Node comparison
 * =================================================================== */

t.section('ipquality-nodes.js — node comparison');

await t.test('requires POLICIES and says so clearly', async () => {
  const ctx = makeCtx();
  const result = await nodes(ctx);
  assert.ok(result.text.includes('POLICIES'), 'explains the missing setting');
  assert.ok(result.text.includes('香港01'), 'gives a concrete example');
});

await t.test('compares each policy and ranks residential above datacenter', async () => {
  const ctx = makeCtx({
    env: { POLICIES: '东京机房,美国家宽', NOTIFY: 'false' },
    overrides: {},
  });

  // Route per policy by inspecting the request's policy option.
  const originalGet = ctx.http.get;
  ctx.http.get = async (url, options = {}) => {
    if (url.startsWith('https://api.ip.sb/ip')) {
      return makeResponse(options.policy === '东京机房' ? '203.0.113.45\n' : '198.51.100.7\n');
    }
    if (url.startsWith('http://ip-api.com/json/')) {
      const dc = url.includes('203.0.113.45');
      return makeResponse({
        status: 'success',
        country: dc ? 'Japan' : 'United States',
        countryCode: dc ? 'JP' : 'US',
        city: dc ? 'Tokyo' : 'Dallas',
        as: dc ? 'AS64500 DATACENTER' : 'AS7018 ATT',
        isp: dc ? 'DC Provider' : 'AT&T',
        hosting: dc,
        proxy: false,
      });
    }
    if (url.startsWith('https://api.ipapi.is/')) {
      const dc = url.includes('203.0.113.45');
      return makeResponse({
        ip: dc ? '203.0.113.45' : '198.51.100.7',
        is_datacenter: dc,
        is_proxy: false,
        location: { country: dc ? 'Japan' : 'United States', country_code: dc ? 'JP' : 'US' },
        asn: { asn: dc ? 64500 : 7018, descr: dc ? 'DATACENTER' : 'ATT' },
        company: { name: dc ? 'DC Provider' : 'AT&T' },
      });
    }
    return originalGet(url, options);
  };

  const result = await nodes(ctx);
  assert.ok(result.text.includes('# 🔍 节点体检对比'), 'title');
  assert.ok(result.text.includes('东京机房'), 'first policy listed');
  assert.ok(result.text.includes('美国家宽'), 'second policy listed');
  assert.ok(result.text.includes('推荐节点：美国家宽'), `residential should win, got:\n${result.text}`);

  const stored = ctx.storage.getJSON('ipquality:nodeCompare');
  assert.equal(stored.rows.length, 2, 'both rows stored');
});

await t.test('rejects an unreasonable number of policies', async () => {
  const many = Array.from({ length: 13 }, (_, i) => `节点${i}`).join(',');
  const ctx = makeCtx({ env: { POLICIES: many, NOTIFY: 'false' } });
  const result = await nodes(ctx);
  assert.ok(result.text.includes('最多对比 12 个'), 'guards against runaway runs');
});

await t.test('probes policies sequentially, never two nodes at once', async () => {
  const ctx = makeCtx({ env: { POLICIES: 'A,B,C', NOTIFY: 'false' } });
  // Track which policy each in-flight request belongs to. Two different
  // policies must never be in flight simultaneously, or the tunnel
  // would cross their results.
  const activePolicies = new Set();
  let overlapped = false;

  ctx.http.get = async (url, options = {}) => {
    const policy = options.policy || 'DEFAULT';
    if (activePolicies.size > 0 && !activePolicies.has(policy)) overlapped = true;
    activePolicies.add(policy);
    await new Promise((r) => setTimeout(r, 3));
    activePolicies.delete(policy);

    if (url.startsWith('https://api.ip.sb/ip')) return makeResponse('203.0.113.45\n');
    if (url.startsWith('http://ip-api.com/')) {
      return makeResponse({ status: 'success', country: 'Japan', countryCode: 'JP', as: 'AS1 X' });
    }
    if (url.startsWith('https://api.ipapi.is/')) {
      return makeResponse({ ip: '203.0.113.45', location: { country_code: 'JP' }, asn: { asn: 1 } });
    }
    // Echo endpoints other than ip.sb fail fast; that is fine.
    throw new Error('unexpected ' + url);
  };

  await nodes(ctx);
  assert.ok(!overlapped, 'two different policies were probed concurrently');
});

/* ===================================================================
 * Rule generation
 * =================================================================== */

t.section('ipquality-nodes.js — rule generation');

await t.test('generates a YAML block and explains each decision', async () => {
  const ctx = makeCtx({ env: { MODE: 'rules', TARGET_POLICY: '日本节点', NOTIFY: 'false' } });
  const result = await nodes(ctx);
  assert.ok(result.text.includes('# 🧭 分流规则建议'), 'title');
  assert.ok(result.text.includes('```yaml'), 'yaml block');
  assert.ok(result.text.includes('rules:'), 'rules key');
  assert.ok(result.text.includes('日本节点'), 'target policy used');
  assert.ok(result.text.includes('## 生成依据'), 'rationale section');
  assert.ok(result.text.includes('geoip'), 'CN direct rule generated');
});

await t.test('routes blocked services through the target policy', async () => {
  const ctx = makeCtx({
    env: { MODE: 'rules', TARGET_POLICY: 'PROXY', NOTIFY: 'false' },
    // Reddit returns 403 in the fixtures => blocked => rules expected.
  });
  const result = await nodes(ctx);
  assert.ok(result.text.includes('reddit.com'), 'reddit domains routed');
  assert.ok(result.text.includes('Reddit 当前被屏蔽'), 'explains why');
});

await t.test('stores the generated rules for later reuse', async () => {
  const ctx = makeCtx({ env: { MODE: 'rules', NOTIFY: 'false' } });
  await nodes(ctx);
  const stored = ctx.storage.getJSON('ipquality:lastRules');
  assert.ok(stored && stored.yaml.includes('rules:'), 'rules cached');
});

await t.test('rule output is valid Egern YAML', async () => {
  const ctx = makeCtx({ env: { MODE: 'rules', NOTIFY: 'false' } });
  const result = await nodes(ctx);
  const block = result.text.split('```yaml')[1].split('```')[0];
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    yaml = require('D:/Program Files (x86)/DSH Next/resources/app/node_modules/js-yaml');
  }
  const parsed = yaml.load(block);
  assert.ok(Array.isArray(parsed.rules), 'parses to a rules array');
  assert.ok(parsed.rules.length > 0, 'has rules');
  // Egern nests match/policy under the rule type, e.g.
  //   - domain_suffix: { match: x, policy: y }
  const KNOWN_TYPES = new Set([
    'domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'domain_wildcard',
    'geoip', 'ip_cidr', 'ip_cidr6', 'asn', 'url_regex', 'user_agent',
    'dest_port', 'protocol', 'rule_set', 'ssid', 'bssid', 'cellular',
  ]);
  for (const rule of parsed.rules) {
    const type = Object.keys(rule)[0];
    assert.ok(KNOWN_TYPES.has(type), `unknown rule type: ${type}`);
    assert.ok(rule[type].match, `rule ${type} has a match`);
    assert.ok(rule[type].policy, `rule ${type} has a policy`);
  }
});

t.finish();
