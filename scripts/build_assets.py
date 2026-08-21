#!/usr/bin/env python3
"""
Vibepaws 宠物素材构建 —— 把 pet_assests/ 的原图变成能上屏的 sprite。

原图是 1254x1254、**没有 alpha**、背景不透明的「伪像素画」：生成时要的是 64x64
逻辑网格（见 output/imagegen/pet-batch-01/prompts.jsonl 的 style 字段），但模型
并没有真的给出规整网格 —— 实测周期性只有 1.5~3.2（真正整数放大的像素画在单一
周期上能到 10+）。所以不能靠 NEAREST 缩小「还原」网格，必须重新定网格。

流程：抠底 -> 裁到内容 -> 取锚点 -> **逐宠物统一缩放与对齐** -> 重定网格 -> 取主色 -> 写盘。

## 多帧（逐状态立绘）

scripts/gen_states.py 会给每只宠物生成 7 个状态的立绘，放在
output/imagegen/pet-states/<slug>/<state>.png。这里把它们和原图一起处理成**同一套
几何**的帧：

  · 一只宠物的所有帧共用**一个缩放比**。绝对不能各帧独立缩放到填满画布 ——
    tired 的实测内容高度是 674px，而 needs-you 是 799px，那个矮下去的差值**就是
    塌下来的姿态本身**。各帧独立归一化会把它抻回全高，姿态就没了。
  · 各帧按**脚底 + 身体中心**对齐到同一张画布上。身体中心（最大连通域的中心）
    对到画布正中，于是所有宠物的 feetX 都是 0.5 —— 顺带解决了 Circuit Witch
    偏心锚点挤压横向余量的问题。

缺帧不会失败：没有的状态在渲染层回落到 base（ui/pets/registry.js）。

这个脚本只在**加新宠物或重新生成立绘时**跑，产物提交进仓库 —— 所以 App 和其他
贡献者都不需要装 Python。用法：
    npm run assets            # 生成
    npm run assets -- --check # 只体检，不写盘
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, deque
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError as e:  # 提前把话说清楚，别让人对着 traceback 猜
    sys.exit(f"需要 Pillow 和 numpy：pip install pillow numpy（{e}）")

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "pet_assests"
OUT_DIR = ROOT / "ui" / "pets"
# scripts/gen_states.py 的产物（output/ 已 gitignore）
STATES_DIR = ROOT / "output" / "imagegen" / "pet-states"

# 与 src/core/events.ts 的 PET_STATES 一致
STATES = ["idle", "working", "needs-you", "warning", "finished", "tired", "level-up"]

# 抠底：背景实测是**完全平**的（每块 patch σ=0.6，四角互差 ≤0.5），所以固定阈值
# 就够精确。KEY_TOL 以下算背景，往上 KEY_SOFT 个色阶做软过渡 —— 像素画边缘本身
# 是硬的，留一点软过渡只是为了吃掉生成时带的一圈抗锯齿。
KEY_TOL = 14
KEY_SOFT = 12
# 裁剪与连通域判定用的 alpha 门槛
ALPHA_FLOOR = 8

# 重定网格：先 BOX 缩到 80，再 NEAREST 放大 2 倍到 160。
#
# 为什么是 160 而不是把 canvas（208）填满：变换原点在脚底，而锚点可以偏心
# （Circuit Witch 的 feetX=0.443，身体大部分在锚点右边）。精灵越大，横向留给
# 抖动+旋转的余量越小 —— 取 176 时 warning 态会顶破右边缘，被
# ui/pets/motion.test.js 的越界断言抓出来。160 给所有状态都留出了余量。
GRID = 80
UPSCALE = 2

# 连通域分析的降采样倍率：1254 -> ~314，够快也够准
COMP_STEP = 4
# 小于这个面积（原图像素）的连通域当噪点，不计入 components
COMP_MIN_AREA = 4000


def key_background(path: Path) -> Image.Image:
    """抠底 + 裁到内容。返回 RGBA。"""
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    # 背景色逐图采样：五张图的背景各不相同（236,232,227 ~ 217,212,207），
    # 写死一个常量会在别的图上留边。
    bg = a[0:60, 0:60].reshape(-1, 3).mean(axis=0)
    dist = np.abs(a - bg).max(axis=2)
    alpha = np.clip((dist - KEY_TOL) * (255.0 / KEY_SOFT), 0, 255).astype(np.uint8)
    rgba = np.dstack([a.astype(np.uint8), alpha])
    im2 = Image.fromarray(rgba, "RGBA")
    box = im2.getchannel("A").point(lambda v: 255 if v > ALPHA_FLOOR else 0).getbbox()
    if box is None:
        raise ValueError(f"{path.name}: 抠完一个不透明像素都不剩")
    return im2.crop(box)


def components(alpha: np.ndarray) -> list[dict]:
    """
    连通域（BFS，自己写）。**不要用 scipy** —— 这个环境里 scipy.ndimage 因为
    NumPy 2.x 的 ABI 变更直接 import 失败。

    先膨胀 1 格再标记：生成图的细线（法阵、电弧）边缘是抗锯齿的，不膨胀会被
    切成一串碎片，主体判定就废了。
    """
    m = alpha[::COMP_STEP, ::COMP_STEP] > ALPHA_FLOOR
    d = m.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            d |= np.roll(np.roll(m, dy, 0), dx, 1)
    h, w = d.shape
    seen = np.zeros_like(d, dtype=bool)
    out: list[dict] = []
    px = COMP_STEP * COMP_STEP
    for sy in range(h):
        for sx in range(w):
            if not d[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            pts = []
            while q:
                y, x = q.popleft()
                pts.append((y, x))
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and d[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            ys = np.array([p[0] for p in pts]) * COMP_STEP
            xs = np.array([p[1] for p in pts]) * COMP_STEP
            out.append({
                "area": len(pts) * px,
                "x0": int(xs.min()), "x1": int(xs.max()),
                "y0": int(ys.min()), "y1": int(ys.max()),
            })
    out.sort(key=lambda c: c["area"], reverse=True)
    return [c for c in out if c["area"] >= COMP_MIN_AREA]


def accent_of(im: Image.Image, comp: dict) -> str:
    """主色：最大连通域里最常见的高饱和色，用来给 EXP 条/气泡描边取色。"""
    crop = im.crop((comp["x0"], comp["y0"], comp["x1"] + 1, comp["y1"] + 1)).convert("RGBA")
    a = np.asarray(crop).astype(int)
    rgb, alpha = a[..., :3], a[..., 3]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    keep = (alpha > 200) & (sat > 0.35) & (mx > 64)
    if not keep.any():
        keep = alpha > 200
    q = (rgb[keep] // 16 * 16 + 8).clip(0, 255)
    if len(q) == 0:
        return "#888888"
    r, g, b = Counter(map(tuple, q)).most_common(1)[0][0]
    return f"#{r:02x}{g:02x}{b:02x}"


def shrink(im: Image.Image, scale: float) -> Image.Image:
    """
    按给定比例 BOX 缩小。**比例由调用方给**，因为一只宠物的所有帧必须共用一个比例。

    缩放前后要做 premultiply / un-premultiply。PIL 缩 RGBA 时不会预乘 alpha，
    透明像素的 RGB（我们只改了 alpha，那里存的还是原来的背景色）会被混进边缘，
    结果整圈发白。
    """
    a = np.asarray(im.convert("RGBA")).astype(np.float64)
    rgb, alpha = a[..., :3], a[..., 3:4] / 255.0
    pre = np.dstack([rgb * alpha, alpha * 255.0]).astype(np.uint8)

    w, h = im.size
    small = Image.fromarray(pre, "RGBA").resize(
        (max(1, round(w * scale)), max(1, round(h * scale))), Image.BOX
    )

    b = np.asarray(small).astype(np.float64)
    al = b[..., 3:4] / 255.0
    un = np.where(al > 0, b[..., :3] / np.maximum(al, 1e-6), 0).clip(0, 255)
    flat = np.dstack([un, b[..., 3:4]]).astype(np.uint8)
    return Image.fromarray(flat, "RGBA")


def frame_sources(pet: dict) -> list[tuple[str, Path]]:
    """
    参与构建的帧。

    **原图不作为运行时帧**，只当生成立绘时的参考图。原图的构图比生成帧更紧
    （当初的提示词要求「body fills about 68 percent」），实测内容高度 160px 对
    状态帧的 ~130px —— 混在一起会让宠物在加载完成的瞬间明显缩小一圈，而且它
    还会把统一缩放比往下拽，白白浪费掉状态帧的画布。

    一张立绘都还没生成时，退回单帧（原图当 base），行为和多帧改造之前一致。
    """
    d = STATES_DIR / pet["slug"]
    frames = ([(st, d / f"{st}.png") for st in STATES if (d / f"{st}.png").exists()]
              if d.exists() else [])
    return frames or [("base", SRC_DIR / pet["src"])]


def build_pet(pet: dict, check: bool) -> tuple[dict, dict]:
    """
    处理一只宠物的所有帧。返回 (index.json 记录, {帧名: 图})。

    核心是**一只宠物内共用一套几何**：一个缩放比、一张画布、一个锚点。
    """
    prepared = []
    for name, path in frame_sources(pet):
        if not path.exists():
            sys.exit(f"缺素材：{path}")
        cropped = key_background(path)
        comps = components(np.asarray(cropped)[..., 3])
        if not comps:
            sys.exit(f"{path.name}: 找不到主体连通域")
        body = comps[0]
        bcx = (body["x0"] + body["x1"]) / 2  # 身体中心（不含脱离本体的装饰）
        prepared.append({
            "name": name, "im": cropped, "comps": len(comps),
            "body": body, "bcx": bcx, "w": cropped.width, "h": cropped.height,
        })

    # 画布宽度要能容纳「身体中心对齐到正中」之后最外侧的内容。用最大的单边需求
    # 乘 2，保证任何一帧都不会被切到。
    half = max(max(f["bcx"], f["w"] - f["bcx"]) for f in prepared)
    tall = max(f["h"] for f in prepared)
    scale = GRID / max(half * 2, tall)
    cw = max(1, round(half * 2 * scale))
    ch = max(1, round(tall * scale))

    # base 帧 = idle（没有 idle 就拿第一帧顶）。它是状态帧还没解码时垫着的那张，
    # 所以必须和其他状态帧同一套几何，不能是原图。
    base = next((f for f in prepared if f["name"] == "idle"), prepared[0])
    # 主色取 base 帧：各帧姿态不同但配色一致，没必要每帧都算
    accent = accent_of(base["im"], base["body"])

    print(f"{pet['slug']:<14} {pet['rarity']:<9} {len(prepared)} 帧  "
          f"画布 {cw * UPSCALE}x{ch * UPSCALE}  scale={scale:.4f}  accent={accent}")

    frames = {}
    for f in prepared:
        small = shrink(f["im"], scale)
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        # 身体中心对到画布正中；脚底贴画布底边 —— 于是所有帧、所有宠物的锚点
        # 都是 (0.5, 1.0)，切状态时宠物不会横向漂移，也不会浮起来。
        canvas.alpha_composite(small, (round(cw / 2 - f["bcx"] * scale), ch - small.height))
        out = canvas.resize((cw * UPSCALE, ch * UPSCALE), Image.NEAREST)
        frames[f["name"]] = out
        fill = out.getchannel("A").point(lambda v: 255 if v > ALPHA_FLOOR else 0)
        bbox = fill.getbbox()
        span = f"{bbox[3] - bbox[1]}px 高" if bbox else "空"
        print(f"    {f['name']:<10} comps={f['comps']}  内容 {span}")

    if not check:
        d = OUT_DIR / pet["slug"]
        d.mkdir(parents=True, exist_ok=True)
        for name, im in frames.items():
            im.save(d / f"{name}.png", optimize=True)
        total = sum((d / f"{n}.png").stat().st_size for n in frames) // 1024
        print(f"    -> {d.relative_to(ROOT)}/ {len(frames)} 个文件，共 {total} KB")

    record = {
        "id": pet["id"], "slug": pet["slug"], "name": pet["name"],
        "rarity": pet["rarity"], "starter": bool(pet["starter"]),
        # 所有帧同宽同高同锚点，渲染层换帧不需要重算任何几何
        "w": cw * UPSCALE, "h": ch * UPSCALE,
        "anchor": {"feetX": 0.5, "feetY": 1.0},
        "accent": accent,
        "base": f"{pet['slug']}/{base['name']}.png",
        "frames": {n: f"{pet['slug']}/{n}.png" for n in frames},
        # 多于 1 个连通域 = 有真正脱离本体的装饰（Circuit Witch 的菱形）。
        # 现在还是整块一起动；将来要做分层动画就从这里挑。
        "components": base["comps"],
        "motion": {},
    }
    return record, frames


def contact_sheet(built: list[tuple[dict, dict]], path: Path) -> None:
    """
    把所有宠物 x 所有状态拼成一张联络表。

    这里**故意不做自动质检**。生成模型偶尔会在脚下画一片地面阴影（提示词明确禁止
    过），而它和宠物自身的大片浅色在数值上分不开 —— 饱和度、alpha、平坦度三种判据
    都试过：要么漏掉 Sporewick 的 working（阴影是不透明的暖灰，色差 ~51），要么把
    Circuit Witch 干净的 tired 误判（她袍子上本来就有一大片平坦浅色）。
    既漏报又误报的检查器比没有更糟，它只会教人忽略警告。

    所以交给眼睛：35 张图排成一屏，脏的那一张一眼就看出来，重新生成即可。
    """
    cell = max(max(im.width for im in fr.values()) for _, fr in built)
    cellh = max(max(im.height for im in fr.values()) for _, fr in built)
    pad, label = 6, 14
    cols = len(STATES)
    sheet = Image.new("RGBA", (cols * (cell + pad) + pad,
                               len(built) * (cellh + pad + label) + pad), (26, 30, 38, 255))
    # 棋盘垫底：透明区域没抠干净的话，在纯色背景上看不出来
    chk = Image.new("RGBA", (cell, cellh))
    px = chk.load()
    for y in range(cellh):
        for x in range(cell):
            px[x, y] = (58, 63, 72, 255) if ((x // 8) + (y // 8)) % 2 else (72, 78, 88, 255)
    for r, (rec, frames) in enumerate(built):
        for c, st in enumerate(STATES):
            im = frames.get(st)
            box = (pad + c * (cell + pad), pad + r * (cellh + pad + label) + label)
            tile = chk.copy()
            if im:
                tile.alpha_composite(im, ((cell - im.width) // 2, cellh - im.height))
            sheet.alpha_composite(tile, box)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)
    print(f"联络表 -> {path.relative_to(ROOT)}（{len(built)} 只 x {cols} 态，逐帧过一眼）")


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 Vibepaws 宠物 sprite")
    ap.add_argument("--check", action="store_true", help="只体检并打印，不写盘")
    args = ap.parse_args()

    roster = json.loads((SRC_DIR / "roster.json").read_text())["pets"]
    built = [build_pet(pet, args.check) for pet in roster]
    records = [rec for rec, _ in built]

    missing = {r["slug"]: [s for s in STATES if s not in r["frames"]] for r in records}
    missing = {k: v for k, v in missing.items() if v}
    if missing:
        # 静默少几个状态最难查：界面只是「某个状态看起来没变化」，不会报错
        print("\n缺状态帧（渲染层会回落到 base）：")
        for slug, states in missing.items():
            print(f"  {slug}: {' '.join(states)}")
        print("  跑 scripts/gen_states.py 补齐")

    if args.check:
        print("\n--check：未写盘")
        return 0

    contact_sheet(built, ROOT / "output" / "imagegen" / "pet-states" / "contact-sheet.png")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = OUT_DIR / "index.json"
    index.write_text(json.dumps({"version": 2, "pets": records}, indent=2, ensure_ascii=False) + "\n")
    print(f"\n写入 {index.relative_to(ROOT)}（{len(records)} 只）")
    return 0



if __name__ == "__main__":
    raise SystemExit(main())
