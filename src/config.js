'use strict';
/**
 * config.js — 读取 config.json（+ 可选的本地覆盖 config.local.json）
 *
 * 两件事：
 *
 * 1. **展开路径里的 `~`**：config.json 入库，所以里面不写 `/home/<用户名>/...`
 *    这种带个人信息的绝对路径，改写成 `~/ai-project/game-wind`。Node 的 fs 不认 `~`。
 * 2. **合并本地覆盖**：`config.local.json` 覆盖 config.json 的同名字段，前者在
 *    .gitignore 里。照 game-wind 的 `config.yaml` + `config.local.yaml` 套路来，
 *    为的是**敏感值（企业微信 webhook）能入库一份空模板、真值留在本地**。
 *    此前 webhook 是去读 game-wind 的配置文件刮出来的，那是拿别人的私钥凑自己的
 *    功能，且刮不到时静默跳过告警——见 notify.js 的 resolveWebhook。
 *
 * cli.js 和 scripts/cron_upload.sh 都走这个模块，别各读各的——
 * cron 脚本要先用 gamewindPath 拼出视频路径，读到没展开的 `~` 会直接判定路径不存在。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config.json');

/** 递归合并本地覆盖：只写要改的字段，不必把整份配置抄一遍。数组整体替换。 */
function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (plain(v) && plain(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

/** 展开开头的 `~`（只处理 `~/`，`~user/` 不支持——没必要） */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 载入配置。gamewindPath 已展开 `~`。
 * 环境变量 GAMEWIND_PATH 优先，方便临时换仓库。
 */
function load(configPath = DEFAULT_PATH) {
  if (!fs.existsSync(configPath)) throw new Error(`找不到配置文件: ${configPath}`);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // 本地覆盖和主配置同目录（放在仓库根）。解析失败要炸出来而不是当没有——
  // 静默忽略一份写坏的本地配置，会让人以为「配了」却实际没生效。
  const localPath = path.join(path.dirname(configPath), 'config.local.json');
  if (fs.existsSync(localPath)) {
    try {
      merge(cfg, JSON.parse(fs.readFileSync(localPath, 'utf8')));
    } catch (e) {
      throw new Error(`${localPath} 解析失败: ${e.message}`);
    }
  }

  if (process.env.GAMEWIND_PATH) cfg.gamewindPath = process.env.GAMEWIND_PATH;
  cfg.gamewindPath = expandHome(cfg.gamewindPath);

  if (cfg.browser && cfg.browser.profileDirWindows) {
    cfg.browser.profileDirWindows = expandHome(cfg.browser.profileDirWindows);
  }
  return cfg;
}

module.exports = { load, expandHome, DEFAULT_PATH };
