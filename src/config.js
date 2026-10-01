'use strict';
/**
 * config.js — 读取 config.json
 *
 * 存在的唯一理由是**展开路径里的 `~`**：config.json 入库，所以里面不写
 * `/home/<用户名>/...` 这种带个人信息的绝对路径，改写成 `~/ai-project/game-wind`。
 * Node 的 fs 不认 `~`，必须在这里展开。
 *
 * cli.js 和 scripts/cron_upload.sh 都走这个模块，别各读各的——
 * cron 脚本要先用 gamewindPath 拼出视频路径，读到没展开的 `~` 会直接判定路径不存在。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config.json');

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

  if (process.env.GAMEWIND_PATH) cfg.gamewindPath = process.env.GAMEWIND_PATH;
  cfg.gamewindPath = expandHome(cfg.gamewindPath);

  if (cfg.browser && cfg.browser.profileDirWindows) {
    cfg.browser.profileDirWindows = expandHome(cfg.browser.profileDirWindows);
  }
  return cfg;
}

module.exports = { load, expandHome, DEFAULT_PATH };
