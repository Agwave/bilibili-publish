'use strict';
/**
 * notify.js — 企业微信兜底告警
 *
 * 存在的理由就是 2026-10-09 丢掉的那一天投稿：SESSDATA 在 10-08 15:21 过期，
 * 而 10-08 早上 cron 其实**已经在** logs/cron.log 里打了一行
 * 「⚠️ 登录态快过期……过期后定时投稿会失败」——但没人会天天翻日志，
 * 于是 10-09 8:15 静默失败，等发现时已经少了一条视频。
 *
 * 所以这里只干一件事：把「登录态快过期 / 投稿失败」推到企业微信。
 * 告警是兜底，**永远不抛异常**——兜底本身失败不能把投稿流程带塌。
 *
 * webhook 不在这里配：复用 game-wind 那份（config.local.yaml 覆盖 config.yaml），
 * 免得同一个企业微信密钥在两个仓库各存一份、轮换时漏改一处。
 */

const fs = require('fs');
const path = require('path');

// 状态文件放 logs/（已在 .gitignore 里）。锚定 __dirname 而不是 process.cwd()：
// cron 里 cwd 取决于 crontab 那条命令怎么写，不该由它决定文件落在哪。
const STATE_DIR = path.join(__dirname, '..', 'logs');
const STATE_FILE = path.join(STATE_DIR, 'notify-state.json');

/**
 * 从 game-wind 的配置文件里取 webhook。
 *
 * 用逐行正则而不引 YAML 库：这里只要一个标量，而本仓库的依赖只有 playwright。
 * 代价是只认 `webhook_url:` 这一种写法——game-wind 的配置模板和本地覆盖都是这么写的，
 * 那边改格式的话这里要跟着改（game-wind 自己用的是 gopkg.in/yaml.v3，解析器不通用）。
 *
 * 两个文件都读、后者覆盖前者，与 game-wind internal/config 的加载顺序保持一致。
 */
const WEBHOOK_RE = /^\s*webhook_url:\s*(?:"([^"]*)"|'([^']*)'|(.*\S))\s*$/;

function loadWebhook(gamewindPath) {
  if (process.env.GAMEWIND_WEBHOOK) return process.env.GAMEWIND_WEBHOOK.trim();
  if (!gamewindPath) return '';
  let url = '';
  for (const name of ['config.yaml', 'config.local.yaml']) {
    let text;
    try {
      text = fs.readFileSync(path.join(gamewindPath, name), 'utf8');
    } catch {
      continue; // 本地覆盖文件不存在是正常情况
    }
    for (const line of text.split('\n')) {
      const m = WEBHOOK_RE.exec(line);
      if (m) url = (m[1] || m[2] || m[3] || '').trim();
    }
  }
  return url;
}

/** 本地日期 YYYY-MM-DD。不用 toISOString：那是 UTC，晚上手动跑会串到第二天。 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读去重状态。文件缺失或损坏都当空——状态坏了顶多多推一条，不该让投稿失败。 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function post(webhook, content) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  // 企业微信 HTTP 200 也可能是业务错误，errcode 才是准的
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // 返回体不是 JSON（网关页面之类），到这里只能认为成功
  }
  if (body.errcode) throw new Error(`errcode ${body.errcode} ${body.errmsg || ''}`);
}

/**
 * 推一条告警。
 *
 * kind 用于去重：同一天同一种只推一次——cron 一天只跑一次本来不会重复，
 * 但调选择器时手动重跑很频繁，不去重会刷屏。
 */
async function push(cfg, kind, content, log = () => {}) {
  try {
    if (cfg && cfg.notify && cfg.notify.enabled === false) return false;

    const webhook = loadWebhook(cfg && cfg.gamewindPath);
    if (!webhook) {
      log('! 没找到企业微信 webhook（game-wind config.local.yaml 的 notify.webhook_url），跳过告警');
      return false;
    }

    const today = localDate();
    const state = readState();
    if (state[kind] === today) {
      log(`告警「${kind}」今天已推过，跳过`);
      return false;
    }

    await post(webhook, content);
    state[kind] = today;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    log(`已推送企业微信告警：${kind}`);
    return true;
  } catch (e) {
    log(`! 告警推送失败（不影响投稿主流程）：${String(e.message).split('\n')[0]}`);
    return false;
  }
}

module.exports = { push, loadWebhook };
