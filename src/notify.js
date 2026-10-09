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
 * webhook 由**本仓库自己持有**：`config.local.json` 的 `notify.webhookUrl`
 * （入库的 config.json 里留空模板，见 src/config.js 的加载顺序）。
 * **它是可选的**——没配就是不推送，投稿流程照常跑，不报错。
 */

const fs = require('fs');
const path = require('path');

// 状态文件放 logs/（已在 .gitignore 里）。锚定 __dirname 而不是 process.cwd()：
// cron 里 cwd 取决于 crontab 那条命令怎么写，不该由它决定文件落在哪。
const STATE_DIR = path.join(__dirname, '..', 'logs');
const STATE_FILE = path.join(STATE_DIR, 'notify-state.json');

/**
 * 解析 webhook，优先级：环境变量 → 本地配置。
 *
 * **这里原先是从 game-wind 的 config.local.yaml 里逐行正则刮出来的**，2026-10-09 拆掉。
 * 三个理由：① 那是拿别人的私钥凑自己的功能，还把自己的告警去哪儿的决定权交给了
 * 对方仓库的配置；② 产物文件（mp4/json）格式固定，而 YAML 写法千变万化，
 * 刮不到就静默跳过告警——**兜底自己断了却不出声**，正是这个模块存在的意义所要治的毛病；
 * ③ 想让「投稿失败」进另一个群时，旧写法得先去 game-wind 加字段。
 * 现在 doctor 的第 5 段会如实报出告警状态（推到哪个机器人 / 没配 / 已关掉）。
 * 注意**「没配」是合法状态**——推送是可选的，没配就是不推，自检只如实报，不当问题。
 */
function resolveWebhook(cfg) {
  const fromEnv = (process.env.NOTIFY_WEBHOOK || '').trim();
  if (fromEnv) return fromEnv;
  const fromCfg = cfg && cfg.notify && cfg.notify.webhookUrl;
  return typeof fromCfg === 'string' ? fromCfg.trim() : '';
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

    const webhook = resolveWebhook(cfg);
    if (!webhook) {
      // 推送是可选的：没配就是不推。这不是错误，日志里也不该扮成错误——
      // 加了 "!" 号会让人以为出了事，而其实只是没启用。
      log('未配企业微信 webhook（可选），跳过告警');
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

module.exports = { push, resolveWebhook };
