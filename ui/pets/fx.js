/**
 * 状态叠加特效 —— 用代码画，不用素材。
 *
 * 这是「一张静态图撑起 7 个状态」的关键：特效是**与宠物无关**的，成本是
 * O(状态数)=6 个图形，而不是 O(宠物数 x 状态数) 张图。逐状态出图那条路要
 * 5 只 x 7 态 x 3 帧 ≈ 105 张，而且扩散模型跨帧保不住同一个角色 ——
 * references/architecture_gap_analysis.md 早就把它标成最可能滑期的一项。
 *
 * 所有图形都按 PX 对齐成方块，跟 sprite 烘出来的块状质感对上。
 */
import { CANVAS } from "./motion.js";

/** 特效的「像素」边长 */
const PX = 4;

/**
 * 升级光芒的颜色：主色太暗就退回金色。
 * Lunafang 的主色是 #283868（深藏青），照着画出来的「光芒」是暗蓝的 —— 那不叫庆祝。
 */
function rayColor(accent) {
  if (!accent || accent.length !== 7) return C.star;
  const n = Number.parseInt(accent.slice(1), 16);
  if (!Number.isFinite(n)) return C.star;
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.35 ? C.star : accent;
}

const C = {
  danger: "#f85149",
  warn: "#f0883e",
  ink: "#161b22",
  paper: "#e6edf3",
  star: "#ffd700",
  dim: "#8b949e",
  /** subagent 轨道。与 ui/style.css 的 --busy 是同一个紫 —— 宠物身上和 session
   *  列表里说的必须是同一件事、同一个颜色，否则用户得分别学两套暗号。 */
  busy: "#a371f7",
};

/** 画在宠物**后面**的特效（升级光芒）；其余都盖在前面 */
export const FX_BEHIND = new Set(["rays"]);

function blk(ctx, x, y, w = 1, h = 1) {
  ctx.fillRect(Math.round(x / PX) * PX, Math.round(y / PX) * PX, w * PX, h * PX);
}

/**
 * 「!」字形，坐标以**格**为单位。
 *
 * 早先是 1 格宽的竖杠 + 1 格点：在 28px 的徽章里糊成一个红方块，完全读不出来。
 * 状态可读性现在全压在特效上（表情那条通道没了），所以宁可粗一点。
 * 占 2 格宽 x 7 格高。
 */
function bang(ctx, bx, by, color) {
  ctx.fillStyle = color;
  ctx.fillRect(bx * PX, by * PX, 2 * PX, 4 * PX);       // 竖杠
  ctx.fillRect(bx * PX, (by + 5) * PX, 2 * PX, 2 * PX); // 点
}

/** 「z」字形：上横 + 斜 + 下横 */
function zed(ctx, x, y, size, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const u = size;
  blk(ctx, x, y, 3, 1);
  blk(ctx, x + u * 2, y + u, 1, 1);
  blk(ctx, x + u, y + u * 2, 1, 1);
  blk(ctx, x, y + u * 3, 3, 1);
  ctx.restore();
}

/** 四角星：一个十字加长臂 */
function star(ctx, x, y, arm, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  blk(ctx, x, y - arm * PX, 1, arm * 2 + 1);
  blk(ctx, x - arm * PX, y, arm * 2 + 1, 1);
  ctx.restore();
}

/**
 * 「分身」小方块最多画几个。
 *
 * 8 个 subagent 画 8 颗就是绕着宠物的一圈噪点 —— 而这个状态要传达的信息只有
 * 「1 个」和「一堆」两档（landscape 0.11）。超过上限的那些由 session 列表里的
 * 数字负责说清楚，宠物本体只负责让你在余光里看出档位。
 */
const HELPERS_MAX = 5;

/** 逐颗微调半径的上限（1 ± 0.08），用来打散正多边形的排布 */
const WOBBLE_MAX = 1.08;

/**
 * delegating / juggling：绕着宠物转的小方块，一个方块 = 一个在跑的 subagent。
 *
 * 为什么是轨道而不是头顶徽章：这个状态和 needs-you 会在同一只宠物上交替出现，
 * 而头顶那块地方已经被「!」徽章占了 —— 两个都往头上画，余光里就分不出是哪个。
 * 轨道还顺带把个数变成了可数的东西：1 颗慢慢绕，4 颗挤成一圈，不用读字就知道差别。
 *
 * 椭圆轨道是必须的：正圆的上下两点会顶出 canvas，而 canvas 只有 208px、精灵占掉 160px。
 */
function helpers(ctx, phase, box, count) {
  const n = Math.max(1, Math.min(HELPERS_MAX, Math.round(count) || 1));
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  // 轨道必须按 **canvas 装得下多少** 收口，而不是只按精灵有多大摊开。
  // 一只 160px 宽的宠物居中放在 208px 的画布上，左右各只剩 24px —— 想要的
  // 「盒子外 3 格」在横向根本放不下，方块会被切在画布边上（而画布是透明窗口，
  // 切掉的部分不是被裁剪，是直接消失，看起来像特效在随机丢帧）。
  const edge = PX * 2.5; // 方块半边 PX*1.5 + blk 对格取整最多再吃掉 PX/2
  const fitX = Math.min(cx, CANVAS - cx) - edge;
  const fitY = Math.min(cy, CANVAS - cy) - edge;
  // 竖向压到 0.55：椭圆而不是正圆，见上面的说明
  const rx = Math.max(PX * 4, Math.min((box.x1 - box.x0) / 2 + PX * 3, fitX / WOBBLE_MAX));
  const ry = Math.max(PX * 3, Math.min(((box.y1 - box.y0) / 2) * 0.55, fitY / WOBBLE_MAX));
  // 固定紫，**不用**宠物主色：这是状态信号，不是装饰。跟着主色走的话，每只宠物的
  // 「分身」都是不同颜色，而且在暖色系宠物身上会和 finished 的金色星星撞车。
  // （rays 用主色是另一回事 —— 那是庆祝这只宠物自己。）
  for (let i = 0; i < n; i++) {
    // 每颗错开相位；半径逐颗微调，免得 n 颗排成一个僵硬的正多边形
    const ang = phase + (i / n) * Math.PI * 2;
    const wobble = 1 + ((i % 3) - 1) * (WOBBLE_MAX - 1);
    const x = cx + Math.cos(ang) * rx * wobble;
    const y = cy + Math.sin(ang) * ry * wobble;
    // 远端（sin > 0，画面下方）稍暗：一点纵深，免得看起来像贴在玻璃上的贴纸
    ctx.save();
    ctx.globalAlpha = 0.55 + (1 - (Math.sin(ang) + 1) / 2) * 0.45;
    ctx.fillStyle = C.paper;
    blk(ctx, x - PX * 1.5, y - PX * 1.5, 3, 3); // 描边：浅色宠物身上也读得出来
    ctx.fillStyle = C.busy;
    blk(ctx, x - PX, y - PX, 2, 2);
    ctx.restore();
  }
}

/**
 * 画特效。
 * @param box 精灵在 canvas 上的包围盒（来自 motion.spriteAabb）——
 *            特效贴着头顶/脚边，所以必须跟着精灵一起动。
 * @param count 只有 `helpers` 用：在跑的 subagent 个数（0/缺省当 1 画）。
 */
export function drawFx(ctx, kind, phase, box, accent, count = 0) {
  const s = Math.sin(phase);
  const headX = (box.x0 + box.x1) / 2;
  const headY = box.y0;

  switch (kind) {
    case "exclaim": {
      // 「等你」：头顶一个会跳的红徽章 + 感叹号。这是整个产品唯一必须做对的提醒，
      // 所以画得比别的特效都大 —— 旧实现靠「白圈大眼」表达，而眼睛这条通道已经没了。
      // 坐标一律先落到**格**上：徽章和字形必须共用同一个网格，否则字会歪出底板。
      const bx = Math.round((box.x1 - PX * 6) / PX);
      const by = Math.round((headY - PX * 10 + s * PX * 1.5) / PX);
      ctx.fillStyle = C.paper;                                    // 描边
      ctx.fillRect((bx - 1) * PX, (by - 1) * PX, 8 * PX, 11 * PX);
      ctx.fillStyle = C.danger;
      ctx.fillRect(bx * PX, by * PX, 6 * PX, 9 * PX);
      bang(ctx, bx + 2, by + 1, C.paper);
      break;
    }
    case "alert": {
      // warning：橙色三角警示。旧实现只抖不变色，而 docs/mvp_architecture.md:187
      // 明确写了「warning 变红」。
      //
      // 几何必须逐格算清楚。旧版三角只有 5 行 x 1 格高（36x20px，扁得不像警示牌），
      // 而感叹号从第 3 行画到第 9 行 —— 三角第 4 行就结束了，于是深色字形一半盖在
      // 三角上把它劈成两半、另一半悬在空处变成一根竖条。深色字形只有落在已填色的
      // 区域里才读得出来。
      //
      // 现在：5 组行、每组 2 格高 → 10 格高 x 9 格宽（40x36px，接近等边）。
      // 第 i 组覆盖第 2i、2i+1 行，宽 (2i+1) 格，以顶点为中心。
      const H = 5;
      const bx = Math.round(headX / PX);
      const by = Math.round((headY - PX * (2 * H + 2)) / PX);
      ctx.fillStyle = C.warn;
      for (let i = 0; i < H; i++) {
        ctx.fillRect((bx - i) * PX, (by + 2 * i) * PX, (2 * i + 1) * PX, 2 * PX);
      }
      // 感叹号：竖杠占第 4~6 行、点占第 8 行，都是 2 格宽。
      // 这几行所在组的半宽分别是 2、2、3、4 格 —— 2 格宽的字形整个落在填色区内。
      ctx.fillStyle = C.ink;
      ctx.fillRect((bx - 1) * PX, (by + 4) * PX, 2 * PX, 3 * PX);
      ctx.fillRect((bx - 1) * PX, (by + 8) * PX, 2 * PX, PX);
      break;
    }
    case "zzz": {
      // tired：三个「z」往右上飘，越远越淡
      for (let i = 0; i < 3; i++) {
        const p = ((phase / (Math.PI * 2)) + i / 3) % 1;
        zed(ctx, box.x1 - PX * 3 + p * PX * 6, headY - PX * 2 - p * PX * 9,
            PX, C.dim, 0.9 - p * 0.8);
      }
      break;
    }
    case "sparkle": {
      // finished：四周闪几颗星，交错闪烁
      const spots = [[box.x0 + PX, headY + PX * 3], [box.x1 - PX * 2, headY + PX * 6],
                     [box.x0 + PX * 4, box.y1 - PX * 8], [box.x1 - PX * 5, box.y1 - PX * 4]];
      spots.forEach(([x, y], i) => {
        const a = Math.abs(Math.sin(phase + (i * Math.PI) / 2));
        if (a > 0.25) star(ctx, x, y, 2, C.star, a);
      });
      break;
    }
    case "rays": {
      // level-up：从脚下往外放的光芒（画在宠物后面）
      const cx = headX;
      const cy = (headY + box.y1) / 2;
      ctx.save();
      ctx.globalAlpha = 0.30 + Math.abs(s) * 0.35;
      ctx.fillStyle = rayColor(accent);
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2 + phase * 0.25;
        const len = PX * (12 + (i % 3) * 5);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        ctx.fillRect(PX * 9, -PX / 2, len, PX);
        ctx.restore();
      }
      ctx.restore();
      break;
    }
    case "helpers": {
      helpers(ctx, phase, box, count);
      break;
    }
    case "dust": {
      // working：脚边两簇小尘土，随周期胀开又淡去
      const a = Math.abs(s);
      ctx.save();
      ctx.globalAlpha = 0.15 + a * 0.4;
      ctx.fillStyle = C.dim;
      const y = box.y1 - PX * 2;
      blk(ctx, box.x0 + PX - a * PX * 3, y, 3, 2);
      blk(ctx, box.x1 - PX * 4 + a * PX * 3, y, 3, 2);
      blk(ctx, (box.x0 + box.x1) / 2 - PX, box.y1 - PX, 2, 1);
      ctx.restore();
      break;
    }
  }
}
