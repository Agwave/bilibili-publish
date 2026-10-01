'use strict';
/**
 * dom.js — 定位元素的共享工具
 *
 * uploader.js 和 probe.js 都要找文件输入，而投稿页上**有多个 input[type=file]**：
 *   - 视频：accept=".mp4,.flv,..."
 *   - 字幕：accept=".txt"
 *   - 封面：accept="image/*"（在封面弹窗里）
 * 按 accept 区分，不能简单地取第一个。
 */

const ACCEPT_HINTS = {
  video: /mp4|mov|mkv|flv|avi|webm|m4v|mpeg|\.ts\b/i,
  image: /image\/|\.png|\.jpe?g|\.webp/i,
};

/** 这个 input 的 accept 是否属于我们要的那类文件 */
function acceptMatches(accept, kind) {
  if (!accept) return true; // 没写 accept 的当作通用
  const re = ACCEPT_HINTS[kind];
  if (!re) return true;
  return re.test(accept);
}

/**
 * 找一个文件输入。会跳过 accept 明显不匹配的（比如视频投稿要找视频输入，
 * 就别拿那个 .txt 字幕输入）。
 * 主文档找不到就依次翻 iframe——老版本页面的上传框在 iframe 里，
 * 现在的版本不在了，但翻一下成本很低。
 */
async function findFileInput(page, kind = 'video') {
  const scan = async (root, tag) => {
    const all = root.locator('input[type="file"]');
    const n = await all.count();
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      const accept = (await el.getAttribute('accept').catch(() => null)) || '';
      if (!acceptMatches(accept, kind)) continue;
      return { loc: el, where: tag, accept };
    }
    return null;
  };

  const main = await scan(page, 'main');
  if (main) return main;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const hit = await scan(f, `iframe(${f.name() || '无名'})`);
    if (hit) return hit;
  }
  return null;
}

/** 按候选选择器列表依次尝试，返回第一个可见的。全不中返回 null。 */
async function find(page, candidates, timeout = 6000) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      return { loc, sel };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 找出当前所有 <input type=file> 的 accept，排障时打印用 */
async function describeFileInputs(page) {
  const out = [];
  for (const [tag, root] of [['main', page], ...page.frames().filter((f) => f !== page.mainFrame()).map((f) => [`iframe(${f.name() || '无名'})`, f])]) {
    const all = root.locator('input[type="file"]');
    const n = await all.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      out.push({
        where: tag,
        accept: (await all.nth(i).getAttribute('accept').catch(() => null)) || '(无)',
        name: (await all.nth(i).getAttribute('name').catch(() => null)) || '(无)',
      });
    }
  }
  return out;
}

module.exports = { find, findFileInput, describeFileInputs, acceptMatches };
