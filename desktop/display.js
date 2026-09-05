/**
 * 「宠物多大」和「宠物在哪块屏幕上」的全部纯逻辑（landscape 0.3）。
 *
 * 单独成文件的理由和 launch.js 一样：这里的每一条都**只在别人的桌上出错**。
 * 开发机是一块内置屏，分辨率从不变、线也从不拔；而这一项之所以排在路线图上，
 * 是因为它是整个桌宠品类里复现率最高的一类抱怨 —— 换了显示器宠物就消失、
 * 拔掉扩展屏宠物留在不存在的坐标里、高 DPI 下位置差一截。
 * 那些情形只能靠把显示器摆出来测，所以它们必须是不 import electron 的纯函数。
 *
 * 这里只认 Electron `Display` 的形状（{ id, label, bounds, workArea, size, scaleFactor }），
 * 不认 Electron 本身。
 */

/* ---------------- 尺寸 ---------------- */

/**
 * 三档尺寸。倍率作用在**整扇窗口**上（主进程把它交给 webContents.setZoomFactor），
 * 所以 CSS 里一个像素都不用改：宠物、气泡、浮层、字号一起缩放。
 *
 * 不做无级调节：一个滑杆意味着每个用户都在跟一个自己也说不清的数字较劲，而
 * 「太小了 / 太大了」只有三个有意义的答案。0.8 / 1.3 是从 210px 的宠物本体倒推的 ——
 * 再小一档（0.65）在 27 寸 4K 上已经认不出是哪只宠物，再大一档（1.6）在 13 寸上
 * 会把浮层顶到菜单栏里。
 */
export const PET_SCALES = { small: 0.8, medium: 1, large: 1.3 };

/** medium 档的窗口尺寸；其余两档由它乘出来。与 ui/style.css 的布局同源。 */
export const BASE_WINDOW = { width: 300, height: 430 };
/** medium 档里宠物本体占的那一块（贴在窗口底部，= ui/style.css 的 #stage）。 */
export const BASE_PET_BOX = { width: 210, height: 250 };

/** 倍率。认不出来的档一律当 medium —— 偏好文件是用户可以手改的。 */
export function scaleFactor(scale) {
  return PET_SCALES[scale] ?? PET_SCALES.medium;
}

/**
 * 某一档下的窗口与宠物盒子尺寸。
 * 一律取整：小数尺寸会让合成器在整扇透明窗口上做半像素重采样，宠物边缘发虚。
 */
export function scaledSizes(scale) {
  const k = scaleFactor(scale);
  return {
    window: { width: Math.round(BASE_WINDOW.width * k), height: Math.round(BASE_WINDOW.height * k) },
    petBox: { width: Math.round(BASE_PET_BOX.width * k), height: Math.round(BASE_PET_BOX.height * k) },
  };
}

/* ---------------- 显示器身份 ---------------- */

/**
 * 一块显示器的**稳定标识**。
 *
 * 不能直接用 display.id：macOS 的 CGDirectDisplayID 会随着拔插、换口、重启变，
 * 而「记住每块屏上的位置」这件事的全部价值就在于跨拔插仍然认得出来 ——
 * 用 id 当键的效果是每次插回显示器都得重新摆一次宠物。
 *
 * 所以键由「型号名 + 分辨率 + 缩放倍率」组成，这三样在同一块屏上是稳定的。
 */
function baseKey(d) {
  const label = String(d?.label ?? "").trim();
  const w = Math.round(d?.size?.width ?? d?.bounds?.width ?? 0);
  const h = Math.round(d?.size?.height ?? d?.bounds?.height ?? 0);
  const scale = d?.scaleFactor ?? 1;
  // label 在 Linux / 某些 Windows 驱动上是空的，那时退回 id：不稳定，但至少不会
  // 让所有显示器挤进同一个键
  return `${label || `display-${d?.id ?? "?"}`}|${w}x${h}@${scale}`;
}

/**
 * displays → Map<display.id, key>。
 *
 * 两台一模一样的显示器（很常见的双屏配置）会撞出同一个 baseKey。撞了就按**摆放
 * 位置**（左→右、上→下）编号：左边那台是 `…`，右边那台是 `…#2`。
 * 于是把两台屏在系统设置里对调，宠物的位置记忆也跟着对调 —— 这恰好是对的：
 * 用户记住的是「左边那块屏的右下角」，不是某个序列号。
 */
export function displayKeys(displays) {
  const groups = new Map();
  for (const d of displays ?? []) {
    const k = baseKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const out = new Map();
  for (const [k, group] of groups) {
    if (group.length === 1) {
      out.set(group[0].id, k);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) || (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0),
    );
    sorted.forEach((d, i) => out.set(d.id, i === 0 ? k : `${k}#${i + 1}`));
  }
  return out;
}

/**
 * 从键里把型号名还原出来。
 *
 * 用在**那块屏此刻不在**的时候：钉住的显示器被拔掉了，界面还得说得出「你钉的是
 * 哪一块」—— 手上只剩下键，没有 Display 对象。键的第一段就是当初的型号名
 * （见 baseKey），所以这件事不需要再存一份名字，也就不会有两份名字对不上的可能。
 * `…#2` 那个消歧后缀留着：两块同型号的屏，说出「第 2 块」比只说型号有用。
 */
export function displayNameFromKey(key) {
  const text = String(key ?? "");
  if (!text) return "";
  const [name = "", rest = ""] = text.split("|");
  const dup = /#(\d+)$/.exec(rest);
  if (name.startsWith("display-")) return text; // 当初就没拿到型号名，原样交出去比编一个好
  return dup ? `${name} #${dup[1]}` : name;
}

/** 给人看的显示器名（设置窗口里那一行「当前：内置视网膜显示器」）。 */
export function displayName(d) {
  const label = String(d?.label ?? "").trim();
  if (label) return label;
  const w = Math.round(d?.size?.width ?? d?.bounds?.width ?? 0);
  const h = Math.round(d?.size?.height ?? d?.bounds?.height ?? 0);
  return w && h ? `${w}×${h}` : String(d?.id ?? "?");
}

/* ---------------- 锚点 ---------------- */

/**
 * 锚点存成**工作区里的比例**，不是屏幕绝对坐标。
 *
 * 绝对坐标只在「分辨率一辈子不变」时才成立。改一次缩放档位、接一次投影仪、
 * 系统更新后 macOS 换一次默认分辨率，存下来的那个点就落到屏幕外面去了 ——
 * 这正是「换了显示器宠物就不见了」的成因。比例在这些变化下仍然指向同一个角落。
 *
 * 存的是**宠物脚下**那一点（见 main.js DEFAULT_PREFS 上面那段），不是窗口左上角。
 */
export function anchorToFraction(anchor, workArea) {
  const w = workArea?.width || 1;
  const h = workArea?.height || 1;
  return {
    fx: clamp01(((anchor?.x ?? 0) - (workArea?.x ?? 0)) / w),
    fy: clamp01(((anchor?.y ?? 0) - (workArea?.y ?? 0)) / h),
  };
}

export function fractionToAnchor(frac, workArea) {
  return {
    x: (workArea?.x ?? 0) + clamp01(frac?.fx) * (workArea?.width ?? 0),
    y: (workArea?.y ?? 0) + clamp01(frac?.fy) * (workArea?.height ?? 0),
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 右下角的默认位置。用**内边距**而不是比例：角落是角落，不该随屏幕变大而变远。 */
export const DEFAULT_INSET = { right: 24, bottom: 40 };

export function defaultAnchor(workArea, petBox = BASE_PET_BOX) {
  return {
    // 用 petBox 而不是窗口宽度：默认位置说的是「宠物离右下角多远」，
    // 拿窗口宽度算会把宠物往左推（多出来那部分是透明的，用户只看得见宠物）。
    x: (workArea?.x ?? 0) + (workArea?.width ?? 0) - DEFAULT_INSET.right - petBox.width / 2,
    y: (workArea?.y ?? 0) + (workArea?.height ?? 0) - DEFAULT_INSET.bottom,
  };
}

/**
 * 区间夹取。上界比下界还小时取**上界**，而不是像 Math.max(lo, …) 那样取下界。
 *
 * 这个方向不是随便选的：上界小于下界只发生在「窗口比工作区还大」时（large 档
 * 撞上一块很矮的屏）。取下界＝窗口顶边对齐，宠物的脚被挤出屏幕下沿，也就是
 * 用户什么都看不见；取上界＝窗口底边对齐，宠物完整可见，被裁掉的是它头顶那片
 * 留给浮层的空白。两种都不理想，但只有后者还能用。
 */
function clampRange(v, lo, hi) {
  if (hi < lo) return Math.round(hi);
  return Math.round(Math.max(lo, Math.min(v, hi)));
}

/**
 * 由「宠物脚下的锚点」算出窗口矩形。
 *
 * 横向按**宠物盒子**夹、纵向按**窗口**夹，两条边界故意不一样：
 * 窗口比宠物宽，多出来的是全透明且点击穿透的空白，按窗口夹的话宠物就贴不到
 * 屏幕左右边缘了。纵向多出来的那一段是浮层要用的，探出屏幕会被裁掉，
 * 所以纵向必须按整个窗口夹。
 */
export function boundsForAnchor({ anchor, workArea, window: win, petBox }) {
  const cx = clampRange(
    Math.round(anchor?.x ?? 0),
    workArea.x + petBox.width / 2,
    workArea.x + workArea.width - petBox.width / 2,
  );
  const y = clampRange(Math.round(anchor?.y ?? 0) - win.height, workArea.y, workArea.y + workArea.height - win.height);
  return { x: Math.round(cx - win.width / 2), y, width: win.width, height: win.height };
}

/* ---------------- 跟随 / 钉住 ---------------- */

/** 光标在另一块屏上待够这么久，宠物才搬家。 */
export const FOLLOW_DWELL_MS = 1200;
/** 轮询光标的间隔。只在「多于一块屏 + 跟随模式」时才跑（见 main.js）。 */
export const FOLLOW_POLL_MS = 400;

/**
 * 跟随的判据：光标**停留**在另一块屏上够久才搬家，而不是一碰到就搬。
 *
 * 没有这道停留门槛的话，任何一次横穿两块屏的鼠标移动都会把宠物拽走 ——
 * 而横穿是多屏用户每分钟都在做的事。宠物跟着光标乱窜比它不动更烦人。
 *
 * 纯 reducer：状态进、状态出，主进程只负责按时喂 now 和光标所在的屏。
 *
 * @param {{pendingKey: string|null, pendingSince: number}} state
 * @param {{cursorKey: string|null, windowKey: string|null, now: number, dwellMs?: number}} input
 * @returns {{state: {pendingKey: string|null, pendingSince: number}, move: string|null}}
 */
export function followStep(state, { cursorKey, windowKey, now, dwellMs = FOLLOW_DWELL_MS }) {
  const idle = { pendingKey: null, pendingSince: 0 };
  // 光标就在宠物这块屏上（或者压根不在任何一块屏上）：没什么要决定的
  if (!cursorKey || cursorKey === windowKey) return { state: idle, move: null };
  // 换了目标屏：计时重来。光标在 A、B 之间来回扫时，两边都攒不满停留时间。
  if (state?.pendingKey !== cursorKey) return { state: { pendingKey: cursorKey, pendingSince: now }, move: null };
  if (now - (state.pendingSince ?? now) < dwellMs) return { state, move: null };
  return { state: idle, move: cursorKey };
}

/**
 * 宠物这一刻**应该**待在哪块屏上。启动时、拔插显示器后各算一次。
 *
 * 「记住的那块屏不在了」是这里唯一真正要处理的情形，也是 landscape 里那条
 * 「拔掉扩展屏之后宠物就消失了」的成因：坐标还在，屏幕没了，窗口停在一片
 * 不存在的桌面上。所以任何认不出来的键一律回落到主屏 —— 宠物必须在某个
 * **看得见**的地方，哪怕不是用户上次放的那个地方。
 *
 * @param {{available: Iterable<string>, mode: string, pinnedKey?: string|null,
 *          lastKey?: string|null, primaryKey: string}} opts
 */
export function pickHomeKey({ available, mode, pinnedKey, lastKey, primaryKey }) {
  const set = new Set(available ?? []);
  const want = mode === "pin" ? pinnedKey : lastKey;
  if (want && set.has(want)) return want;
  return primaryKey;
}

/* ---------------- 偏好 ---------------- */

export const DISPLAY_DEFAULTS = {
  /** "small" | "medium" | "large" */
  scale: "medium",
  /** "follow"（跟着你换屏）| "pin"（钉在一块屏上） */
  displayMode: "follow",
  /** pin 模式下钉住的那块屏；null = 还没钉过，第一次用当前所在的屏 */
  pinnedDisplay: null,
  /** 上次待的那块屏（follow 模式下重启后回到这里） */
  lastDisplay: null,
  /** displayKey → { fx, fy }：每块屏各记一个位置 */
  anchors: {},
};

/**
 * 偏好文件是用户可以手改的普通 JSON，所以这里假定它**什么都可能是**。
 * 认不出来的值一律回落到默认，而不是让主进程拿着 NaN 去算窗口坐标 ——
 * 那会得到一扇位置为 NaN 的窗口，在 macOS 上表现为「宠物彻底不见了」，
 * 而且日志里一个字都没有。
 */
export function normalizeDisplayPrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = { ...DISPLAY_DEFAULTS };
  if (Object.hasOwn(PET_SCALES, src.scale)) out.scale = src.scale;
  if (src.displayMode === "pin" || src.displayMode === "follow") out.displayMode = src.displayMode;
  out.pinnedDisplay = nonEmptyString(src.pinnedDisplay);
  out.lastDisplay = nonEmptyString(src.lastDisplay);
  out.anchors = {};
  if (src.anchors && typeof src.anchors === "object") {
    for (const [key, value] of Object.entries(src.anchors)) {
      if (!key || !value || typeof value !== "object") continue;
      const fx = Number(value.fx);
      const fy = Number(value.fy);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) continue;
      out.anchors[key] = { fx: clamp01(fx), fy: clamp01(fy) };
    }
  }
  return out;
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim() ? v : null;
}
