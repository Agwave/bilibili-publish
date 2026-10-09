'use strict';
/**
 * selectors.js — 投稿页的全部选择器，集中在这一处
 *
 * 下面每一条都是 **2026-10-01 用 probe 在真实投稿页上验证过的**（不是抄资料的）。
 * B 站创作中心改过不止一次 DOM，公开项目里那些 `bre-*` / `iframe[name=videoUpload]`
 * 的写法在当前版本上已经全部失效——现在是 `bcc-*` 打底 + Vue 的 `vui_*`/`data-v-*`。
 *
 * 维护约定：
 *   1. 选择器只写这里，别散到 uploader.js；
 *   2. 能给多个候选就给多个，按序尝试，单点脆弱性降一档；
 *   3. 失效症状是「卡在某一步直到超时」，跑 `node cli.js probe` 重新 dump 即可。
 *
 * 判定下拉选项时统一用**精确文本匹配**（`^x$`），因为列表里存在包含关系，
 * 例如「游戏」是「游戏」而「生活记录」又是另一个分区。
 */

const S = {
  // ---- 投稿页 ----
  uploadUrl:
    'https://member.bilibili.com/platform/upload/video/frame?page_from=creative_home_top_upload',

  // 文件输入：页面上有 3 个（视频 / 字幕 .txt / 压缩包 .zip），
  // 不要用「第一个」，走 dom.js 的 findFileInput 按 accept 过滤。
  fileInputVideo: 'div.bcc-upload-wrapper input[type="file"]',
  fileInputCover: 'div.cover-upload input[type="file"]', // accept="image/png, image/jpeg"，隐藏的

  // 上传完成标志：视频卡片上出现「上传完成」；此时表单已可编辑
  uploadDoneText: '上传完成',

  // ---- 表单 ----
  // 标题：注意会被自动预填成文件名（如 "2026-10-01"），填之前必须先清空！
  title: ['div.video-title input.input-val', 'input[placeholder*="稿件标题"]'],
  titleMaxLen: 80,

  // 简介：Quill 编辑器。页面上有 2 个 ql-editor，另一个是「粉丝动态」，必须限定容器。
  desc: ['div.desc-container div.ql-editor', 'div.desc-text-wrp div.ql-editor'],
  descMaxLen: 2000,

  // 创作声明（必填的下拉）。选项见 STATEMENT_OPTIONS。
  statementTrigger: [
    'div.statement-main input.bcc-select-input-inner',
    'input[placeholder*="创作声明"]',
  ],
  statementOptions: 'ul.bcc-select-option-list li.bcc-option',

  // 分区：单层扁平选择器（不是老的两级 tid）。选项见 TID_OPTIONS。
  tidTrigger: ['div.video-human-type div.select-controller'],
  tidOptions: 'p.item-cont-main',

  // 标签：页面上有 2 个同 placeholder 的输入框（标签 / 参与话题），
  // 用外层容器区分，优先取 tag-container 里的那个。
  tagInput: [
    '#tag-container input.input-val',
    'div.tag-container input.input-val',
    'div.tag-input-wrp input[placeholder*="回车"]',
  ],
  tagMaxLen: 20,
  // 已添加的标签 chip。注意：**页面加载时 B站会按默认分区预置 3 个标签**
  // （实测是 生活记录/学习/记录），不清掉就会占掉 10 个上限的名额。
  tagChip: '#tag-container .label-item-v2-container',
  tagChipText: '.label-item-v2-content',
  tagChipClose: 'svg.close',
  // B站 按当天标题/简介生成的推荐标签行。**必须优先点它而不是手打**：
  // 有些标签（实测「手游情报」）手打后回车无事发生、输入框还会被清空，
  // 但点推荐 chip 就能加上——多半是活动标签，只认它自己的入口。
  // 已被选中的 chip 会多一个 hot-tag-container-selected 类。
  tagRecommendChip: 'div.hot-tag-item',
  tagRecommendSelected: 'hot-tag-container-selected',
  tagTotal: 10,
  tagCountHint: '还可以添加', // 旁边的「还可以添加N个标签」提示，用来核对

  // ---- 封面弹窗 ----
  coverTrigger: ['div.cover-module-main span.add-text', 'span.add-text'],
  coverDone: ['.bcc-dialog div.button.submit', '.bcc-dialog >> text=完成'],

  // B站 新版封面编辑器把封面拆成 4:3（视频卡片）和 16:9（个人空间）两张。
  // 我们只上传 4:3 那张，所以点「完成」时会弹一个同步确认框问要不要同步过去；
  // **不处理它，编辑器就不会关**，遮罩留在页面上把后面的「立即投稿」挡死。
  // 2026-10-09 的投稿失败就是它——而那时日志已经打了「封面已设置」，看着像成功。
  // 实测形态：
  //   <div class="videoup-confirm-modal bcc-dialog__wrap bcc-dialog__wrap-mask" data-reporter-id="132">
  //     <div class="bcc-dialog" style="width: 432px; top: 30vh;">
  //       <div class="bcc-dialog__header">检测到个人空间封面（16:9）未修改</div>
  //       <div class="bcc-dialog__body"><div class="sync-confirm-content">…</div></div>
  //       <div class="bcc-dialog__footer"><div class="modal-footer">
  //         <button class="bcc-button button bcc-button--default large">不同步，手动编辑</button>
  //         <button class="bcc-button button bcc-button--primary large">确认同步</button>
  //       </div></div>
  // 两个按钮靠 --default / --primary 区分：确认同步是 primary。
  // 选「确认同步」是按用户的意思（2026-10-09 确认过）：让 16:9 个人空间封面
  // 跟 4:3 一致，代价是会改动个人空间的封面图。
  coverSyncModal: '.videoup-confirm-modal',
  coverSyncConfirm: '.videoup-confirm-modal .bcc-button--primary',
  coverSyncSkip: '.videoup-confirm-modal .bcc-button--default',

  // 封面编辑器本身（实测 2026-10-09：它的遮罩类名以 cover-editor 开头）。
  // 单独拎出来是因为「关掉同步框 != 关掉编辑器」——答完同步框，编辑器还开着，
  // 得再点一次「完成」。实测三个中间态：只有 cover-editor、只有 syncModal、两个都在。
  coverEditor: '.cover-editor',

  // 弹窗遮罩的通用特征。任何 bcc-dialog 打开时都会有这层 wrap-mask。
  // 单独拎出来是因为它是投稿流程里最阴的失败源：它不移除元素、不报错，
  // 只是让后面每一次点击都变成 "intercepts pointer events" 然后超时——
  // 报错信息指向被点的按钮，真正的原因在几十行之外。
  mask: '[class*="bcc-dialog__wrap-mask"]',

  // 浏览器通知权限引导框（「禁止 / 允许 / 知道了」）。同样是全屏遮罩。
  // 实测 2026-10-09 它存在但 display:none，没挡路；留着兜底。
  notifyDialog: '.videoup-notification-dialog',
  notifyDialogDismiss: '.videoup-notification-dialog .bcc-button',

  // ---- 提交 ----
  submit: ['span.submit-add', 'text=立即投稿'],
  saveDraft: ['span.submit-draft'],
  submitDisabledHints: ['转码', '上传中', '处理中'],

  // 注意：**不要**从页面 HTML 正则捞 bvid。页面上混着推荐位等无关 BV 号，
  // 实测会捞到错的那个。投稿后查创作中心稿件列表接口按标题认领（见 uploader.js 的 fetchBvid）。
  archivesApi:
    'https://member.bilibili.com/x/web/archives?status=is_pubing,pubed,not_pubed&pn=1&ps=20&coop=1&interactive=1',
};

/**
 * 创作声明选项（实测 6 个）。
 * 我们的内容是榜单数据 + 免责声明，选「个人观点，仅供参考」最贴切，
 * 和视频片尾那句「仅供行业观察参考，不构成任何投资建议」对得上。
 */
S.STATEMENT_OPTIONS = [
  '内容无需标注',
  '含AI生成内容',
  '含虚构演绎内容',
  '内容含营销信息',
  '个人观点，仅供参考',
  '内容为转载',
];
S.STATEMENT_DEFAULT = '个人观点，仅供参考';

/**
 * 分区选项（实测 30 个，单层）。
 * 本项目投「游戏」；想换分区改 config.json 的 publish.tid 即可。
 */
S.TID_OPTIONS = [
  '影视', '娱乐', '音乐', '舞蹈', '动画', '绘画', '鬼畜', '游戏', '资讯', '知识',
  '人工智能', '科技数码', '汽车', '时尚美妆', '家装房产', '户外潮流', '健身', '体育运动',
  '手工', '美食', '小剧场', '旅游出行', '三农', '动物', '亲子', '健康', '情感',
  'vlog', '生活兴趣', '生活经验',
];

module.exports = S;
