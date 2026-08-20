/**
 * Vibepaws 宠物 sprite 包（数据驱动）— ui/ 纯静态，浏览器直接加载。
 * 程序化生成 16×16 像素宠物：椭圆身体 + 耳朵 + 眼睛/嘴表情 + 装饰。
 * 7 状态 = 表情变体（normal/alert/sad/star/closed/angry）+ 动画变换（app.js）。
 */

export const PET_COLORS = {
  cat: { body: "#f4a261", dark: "#d9773f", accent: "#e76f51", belly: "#ffe8d6" },
  pup: { body: "#a8c5e0", dark: "#7fa3c4", accent: "#5c7c9e", belly: "#e8f1f8" },
  raccoon: { body: "#8d99ae", dark: "#6b7585", accent: "#2b2d42", belly: "#edf2f4" },
  turtle: { body: "#6db36d", dark: "#4a8f4a", accent: "#9b6b3d", belly: "#d8e8d0" },
  fox: { body: "#e07a5f", dark: "#b85c42", accent: "#f2cc8f", belly: "#fae1dd" },
  slug: { body: "#9b7ed8", dark: "#7b5fc0", accent: "#e8a5ff", belly: "#e5d8f8" },
  sprite: { body: "#ffd166", dark: "#f0b429", accent: "#ef476f", belly: "#fff3c4" },
  // 进化家族的后两阶原来共用 sprite 配色 —— 进化完看起来一模一样，
  // 「宠物变了」这件事在界面上完全看不出来。
  flare: { body: "#ff9f45", dark: "#e2701a", accent: "#ff4d6d", belly: "#ffe0b2" },
  nova: { body: "#b39dff", dark: "#7c5cff", accent: "#7ef9ff", belly: "#f0eaff" },
};

/** 16×16 像素画程序生成 */
export function makePetFrame(palette, opts) {
  const W = 16, H = 16;
  const grid = Array.from({ length: H }, () => Array(W).fill(null));
  const { ears = "round", earsColor = palette.dark, tail = null, spot = null } = opts;

  // 耳朵。ears: null 表示「这个物种没有耳朵」（乌龟、鼻涕虫）——
  // 原来的 else 分支会给它们画上圆耳朵，因为默认值只在 undefined 时生效。
  if (ears === "pointy") {
    for (let y = 0; y < 4; y++) {
      for (let x = 3 - y; x <= 4 + y; x++) grid[y][x] = earsColor;
      for (let x = 11 - y; x <= 12 + y; x++) grid[y][x] = earsColor;
    }
  } else if (ears === "round") {
    for (let y = 0; y < 3; y++) {
      for (let x = 2 + y; x <= 5 - y; x++) grid[y][x] = earsColor;
      for (let x = 10 + y; x <= 13 - y; x++) grid[y][x] = earsColor;
    }
  }

  // 身体椭圆（中心 8, 9，半宽 6，半高 5）
  for (let y = 3; y <= 14; y++) {
    for (let x = 2; x <= 13; x++) {
      const dx = (x - 8) / 6.2;
      const dy = (y - 9) / 5.4;
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        // 底部阴影
        grid[y][x] = d > 0.72 ? palette.dark : y > 12 ? palette.dark : palette.body;
      }
    }
  }
  // 肚皮
  for (let y = 9; y <= 13; y++) {
    for (let x = 5; x <= 10; x++) {
      const dx = (x - 7.5) / 3.2;
      const dy = (y - 11.5) / 2.6;
      if (dx * dx + dy * dy <= 1) grid[y][x] = palette.belly;
    }
  }
  // 腿
  for (let x of [4, 5, 10, 11]) {
    grid[14][x] = palette.dark;
    grid[15][x] = palette.dark;
  }
  // 尾巴
  if (tail === "curly") {
    grid[13][14] = palette.accent;
    grid[12][15] = palette.accent;
    grid[14][15] = palette.accent;
  } else if (tail === "straight") {
    grid[13][14] = palette.accent;
    grid[14][14] = palette.accent;
    grid[15][14] = palette.accent;
  }
  // 斑点/花纹
  if (spot === "heart") {
    grid[4][8] = palette.accent; grid[5][9] = palette.accent;
    grid[4][10] = palette.accent; grid[6][9] = palette.accent;
  } else if (spot === "stripe") {
    for (let x = 3; x <= 12; x++) if (grid[4][x]) grid[4][x] = palette.accent;
  } else if (spot === "shell") {
    for (let y = 5; y <= 9; y++) {
      for (let x = 5; x <= 10; x++) {
        const dx = (x - 7.5) / 3.0, dy = (y - 7) / 2.6;
        if (dx * dx + dy * dy <= 1) grid[y][x] = palette.accent;
      }
    }
  }
  return grid;
}

/** 表情 overlay：眼睛与嘴（状态→表情） */
export function applyExpression(grid, expr) {
  const g = grid.map((row) => row.slice());
  // 眼睛位置（身体上部）
  const eyeL = [6, 6], eyeR = [9, 6];
  // 清掉默认眼睛区域
  const clear = (x, y) => { g[y][x] = null; g[y + 1] && (g[y + 1][x] = null); };
  for (const [x, y] of [eyeL, eyeR]) { clear(x, y); clear(x + 1, y); }

  switch (expr) {
    case "normal":
      for (const [x, y] of [eyeL, eyeR]) {
        g[y][x] = "#1f2430"; g[y][x + 1] = "#1f2430";
        g[y + 1][x] = "#1f2430"; g[y + 1][x + 1] = "#1f2430";
      }
      g[8][7] = "#1f2430"; // 嘴
      break;
    case "alert": // 需要你：白圈大眼 + 张嘴
      for (const [x, y] of [eyeL, eyeR]) {
        g[y][x] = "#ffffff"; g[y][x + 1] = "#ffffff";
        g[y + 1][x] = "#1f2430"; g[y + 1][x + 1] = "#1f2430";
      }
      g[8][7] = "#1f2430"; g[9][7] = "#1f2430";
      break;
    case "sad": // 下垂眼
      for (const [x, y] of [eyeL, eyeR]) {
        g[y + 1][x] = "#1f2430"; g[y + 1][x + 1] = "#1f2430";
      }
      g[8][7] = "#1f2430";
      break;
    case "angry": // warning：斜眉 + 怒眼
      for (const [x, y] of [eyeL, eyeR]) {
        g[y][x + 1] = "#1f2430";
        g[y + 1][x] = "#1f2430"; g[y + 1][x + 1] = "#1f2430";
      }
      g[7][5] = "#1f2430"; g[7][10] = "#1f2430"; // 眉毛
      break;
    case "star": // level-up：星星眼
      for (const [x, y] of [eyeL, eyeR]) {
        g[y][x] = "#ffd700"; g[y][x + 1] = "#ffd700";
        g[y + 1][x] = "#ffd700"; g[y + 1][x + 1] = "#ffd700";
      }
      g[8][7] = "#ffd700";
      break;
    case "closed": // tired：闭眼
      for (const [x, y] of [eyeL, eyeR]) {
        g[y][x] = "#1f2430"; g[y][x + 1] = "#1f2430";
      }
      g[8][7] = "#1f2430";
      break;
    case "happy": // finished：弯眼 + 笑脸
      for (const [x, y] of [eyeL, eyeR]) {
        g[y][x + 1] = "#1f2430";
        g[y + 1][x] = "#1f2430";
      }
      g[8][6] = "#1f2430"; g[8][7] = "#1f2430"; g[8][8] = "#1f2430";
      break;
  }
  return g;
}

/** 宠物定义：形状参数 + 配色 + 状态→表情 */
export const PETS = [
  { id: 1, name: "Pixel Cat", kind: "cat", palette: PET_COLORS.cat, shape: { ears: "pointy", tail: "curly", spot: null }, stateExpr: { idle: "normal", working: "normal", "needs-you": "alert", warning: "angry", finished: "happy", "level-up": "star", tired: "closed" } },
  { id: 2, name: "Byte Pup", kind: "pup", palette: PET_COLORS.pup, shape: { ears: "round", tail: "straight", spot: null }, stateExpr: { idle: "normal", working: "normal", "needs-you": "alert", warning: "angry", finished: "happy", "level-up": "star", tired: "closed" } },
  { id: 3, name: "Git Raccoon", kind: "raccoon", palette: PET_COLORS.raccoon, shape: { ears: "pointy", tail: "curly", spot: "stripe" }, stateExpr: { idle: "normal", working: "normal", "needs-you": "alert", warning: "angry", finished: "happy", "level-up": "star", tired: "closed" } },
  { id: 4, name: "Turbo Turtle", kind: "turtle", palette: PET_COLORS.turtle, shape: { ears: null, tail: null, spot: "shell" }, stateExpr: { idle: "normal", working: "normal", "needs-you": "alert", warning: "angry", finished: "happy", "level-up": "star", tired: "closed" } },
  { id: 5, name: "Mono Fox", kind: "fox", palette: PET_COLORS.fox, shape: { ears: "pointy", tail: "curly", spot: null }, stateExpr: { idle: "normal", working: "normal", "needs-you": "alert", warning: "angry", finished: "happy", "level-up": "star", tired: "closed" } },
  { id: 6, name: "Shell Slug", kind: "slug", palette: PET_COLORS.slug, shape: { ears: null, tail: null, spot: "stripe" }, stateExpr: { idle: "normal", working: "normal", "needs-you": "alert", warning: "angry", finished: "happy", "level-up": "star", tired: "closed" } },
];

/** 进化家族（DB seed 里的 pet_type 10/11/12），三阶各有配色 */
export const EVOLUTIONS = [
  { id: 10, name: "Spark Sprite", kind: "sprite", palette: PET_COLORS.sprite, shape: { ears: "pointy", tail: "curly", spot: "heart" }, stateExpr: PETS[0].stateExpr },
  { id: 11, name: "Flare Sprite", kind: "flare", palette: PET_COLORS.flare, shape: { ears: "pointy", tail: "curly", spot: "stripe" }, stateExpr: PETS[0].stateExpr },
  { id: 12, name: "Nova Sprite", kind: "nova", palette: PET_COLORS.nova, shape: { ears: "pointy", tail: "curly", spot: "shell" }, stateExpr: PETS[0].stateExpr },
];

/**
 * 按 pet_type_id 取宠物。返回的对象必须是稳定引用（渲染缓存按 id 建键）。
 * 未知 id 回落到 1 号，而不是凭空显示一只进化体 —— 后者会让「我进化了？」变成误会。
 */
export function getPet(petTypeId) {
  return (
    PETS.find((x) => x.id === petTypeId) ??
    EVOLUTIONS.find((x) => x.id === petTypeId) ??
    PETS[0]
  );
}

/**
 * (pet, 表情) → 像素网格 的缓存。网格是纯函数产物，但每帧重算要新建
 * 两个 16×16 二维数组、跑上千次循环 —— 一个 always-on 的桌面宠物没必要
 * 拿电池去换这个。
 */
const frameCache = new Map();

function petGrid(pet, expr) {
  const key = `${pet.id}:${expr}`;
  let grid = frameCache.get(key);
  if (!grid) {
    grid = applyExpression(makePetFrame(pet.palette, pet.shape), expr);
    frameCache.set(key, grid);
  }
  return grid;
}

export function renderPet(canvas, pet, state, scale = 10, t = 0) {
  const expr = pet.stateExpr[state] ?? "normal";
  const grid = petGrid(pet, expr);
  const ctx = canvas.getContext("2d");
  const W = 16, H = 16;
  // 给 canvas.width 赋值会重建整个后备缓冲区，每帧做一次纯属浪费
  if (canvas.width !== W * scale) canvas.width = W * scale;
  if (canvas.height !== H * scale) canvas.height = H * scale;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  // 动画变换
  let ox = 0, oy = 0, rot = 0;
  if (state === "idle") oy = Math.sin(t / 500) * scale * 0.6;
  else if (state === "working") oy = Math.sin(t / 120) * scale * 0.9;
  else if (state === "needs-you") ox = Math.sin(t / 90) * scale * 0.8;
  else if (state === "warning") { ox = Math.sin(t / 60) * scale * 1.2; rot = Math.sin(t / 60) * 0.06; }
  else if (state === "level-up") { oy = -Math.abs(Math.sin(t / 400)) * scale * 2.5; }

  ctx.save();
  ctx.translate(canvas.width / 2 + ox, canvas.height / 2 + oy);
  ctx.rotate(rot);
  ctx.translate(-(W * scale) / 2, -(H * scale) / 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid[y][x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  ctx.restore();
}

/* ================= Zani sprite pet（Codex 风格 spritesheet） ================= */
/**
 * 素材来源：https://github.com/chenxin-dlut/codex-anime-pets（pets/zani）
 * 8×9 图集，每格 192×208。行 → 动画的映射与 Codex 官方一致（见 openai/codex
 * codex-rs/tui/src/pets/model.rs 的 default_animations）：
 *   row0 idle / row1 running-right / row2 running-left / row3 waving /
 *   row4 jumping / row5 failed / row6 waiting / row7 running / row8 review。
 */
export const ZANI = {
  id: "zani",
  name: "Zani",
  src: "./pets/zani/spritesheet.webp",
  frame: { w: 192, h: 208 },
  cols: 8,
  states: {
    // idle 用 Codex 原版的不规则呼吸节奏：开头一帧多停一会，再轻微起伏。
    idle: { row: 0, frames: [0, 1, 2, 3, 4, 5], durations: [1680, 660, 660, 840, 840, 1920] },
    working:    track(7, 6, 120, 220), // running：agent 正在干活
    "needs-you": track(6, 6, 150, 260), // waiting：等你拍板/授权
    warning:    track(5, 8, 140, 240), // failed：出问题了
    finished:   track(3, 4, 140, 280), // waving：收工
    "level-up":  track(4, 5, 140, 280), // jumping：升级庆祝
    tired:      track(8, 6, 150, 280), // review：歇着/复盘
  },
};

/** 一行动画轨道：row + 连续的前 N 列，首尾帧稍作停顿更自然 */
function track(row, cols, baseMs, finalMs) {
  return {
    row,
    frames: Array.from({ length: cols }, (_, col) => col),
    durations: Array.from({ length: cols }, (_, i) => (i === cols - 1 ? finalMs : baseMs)),
  };
}

let zaniImage = null;
function zaniImageEl() {
  if (!zaniImage) {
    zaniImage = new Image();
    zaniImage.src = ZANI.src;
  }
  return zaniImage;
}

/** 按当前时间在动画轨里选一帧列号（循环播放） */
function zaniFrameCol(anim, now) {
  const total = anim.durations.reduce((a, b) => a + b, 0);
  let t = now % total;
  for (let i = 0; i < anim.frames.length; i++) {
    if (t < anim.durations[i]) return anim.frames[i];
    t -= anim.durations[i];
  }
  return anim.frames[0];
}

/**
 * 把 Zani 的某个状态帧 1:1 画到 canvas（192×208）。
 * 图还没加载完时返回 false，循环下一帧再试 —— 桌面宠物的 rAF 循环天然会重试。
 */
export function renderZaniPet(canvas, state, now) {
  const img = zaniImageEl();
  if (!img.complete || img.naturalWidth === 0) return false;

  const anim = ZANI.states[state] ?? ZANI.states.idle;
  const col = zaniFrameCol(anim, now);
  const { w, h } = ZANI.frame;

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, col * w, anim.row * h, w, h, 0, 0, w, h);
  return true;
}
