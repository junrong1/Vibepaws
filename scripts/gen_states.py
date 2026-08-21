#!/usr/bin/env python3
"""
逐状态宠物立绘生成 —— 7 个状态各出一张，靠 image-to-image 保住是同一只宠物。

为什么要生成而不是继续用「一张底图 + 位移特效」：表情和姿态这条通道，位移和角标
替代不了。tired 该是耷着眼皮塌下去，needs-you 该是抬头看着你 —— 这些只能画出来。

**身份一致性是这件事成立的前提**，所以每次请求都把该宠物的原图当参考图传进去，
而不是纯文本生成。纯文本生成 7 次会得到 7 只不同的宠物。

## 传输层

Poe 有两条路，这个账号只有第二条能走（实测）：
  · POST /v1/images/generations —— 403 "Images API is not enabled for this user"，
    而且是**整个账号**级别的，gpt-image-2 / nano-banana-pro / flux-2-pro 全一样；
  · POST /v1/chat/completions  —— nano-banana-pro、flux-2-pro 可用，返回一段
    markdown，图在 poecdn 的 URL 里。gpt-image-* 系列在这条路上直接断连
    （RemoteDisconnected），所以 --model gpt-image-2 现在跑不通。
    等 Images API 开了，加一条 images 传输即可，命令行参数不用变。

## 用法

    export POE_API_KEY=...            # 只从环境变量读，绝不写进仓库
    python3 scripts/gen_states.py --dry-run          # 只打印要生成什么
    python3 scripts/gen_states.py --pet embercub --state tired
    python3 scripts/gen_states.py                    # 全量（5 只 x 7 态 = 35 张）

产物落在 output/imagegen/pet-states/<slug>/<state>.png（output/ 已 gitignore）。
它们是 scripts/build_assets.py 的输入；构建出来的小图在 ui/pets/ 下并且提交进仓库，
所以日常开发不需要重新生成，也不需要 API key。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("需要 requests：pip install requests")

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "pet_assests"
OUT_DIR = ROOT / "output" / "imagegen" / "pet-states"

API = "https://api.poe.com/v1/chat/completions"
DEFAULT_MODEL = "nano-banana-pro"

# 7 个状态，对齐 src/core/events.ts 的 PET_STATES
STATES = ["idle", "working", "needs-you", "warning", "finished", "tired", "level-up"]

# 只描述**姿态和表情**。造型、配色、比例全部由参考图决定 —— 在提示词里重复描述
# 长相反而会让模型「重新设计」一只相似但不同的宠物。
STATE_DIRECTION = {
    "idle": "standing calmly at rest, relaxed neutral posture, eyes open, "
            "a small content smile, ears in their natural position",
    "working": "busy and focused, leaning slightly forward, brow set in concentration, "
               "eyes narrowed on something just off-frame, one front limb raised mid-motion",
    "needs-you": "alert and asking for attention: head up, looking directly at the viewer, "
                 "eyes wide and round, ears perked straight up, mouth slightly open as if "
                 "about to speak, one front limb lifted in a small beckoning gesture",
    "warning": "anxious and uneasy: brow furrowed, ears folded back, leaning away slightly, "
               "mouth a worried wavy line, a bead of sweat on the temple",
    "finished": "happy and proud of finished work: chest up, head high, eyes closed in a "
                "cheerful arc, wide open smile, both front limbs raised in a small cheer",
    "tired": "worn out and sleepy: eyes closed, head drooping forward and down, body slumped "
             "and sitting low to the ground, ears folded limply down, shoulders sagging",
    "level-up": "triumphant and radiant: standing tall and stretched upward, looking up, "
                "eyes bright and confident, beaming open-mouthed grin, both front limbs "
                "thrown up in victory",
}

# 每次请求都重复的硬约束。**画面构图必须逐帧一致** —— 否则同一只宠物在不同状态
# 之间会忽大忽小、忽左忽右，切状态时就是一次跳动。build_assets.py 还会按脚底
# 再对齐一次，但生成阶段越稳，后面越不用硬掰。
FRAMING = (
    "Keep the character EXACTLY the same as the reference image: identical design, "
    "identical colors and palette, identical proportions, identical markings, identical "
    "pixel-art style and outline weight. Do not redesign it, do not add or remove features, "
    "do not change its species or costume. Only the pose and facial expression change.\n"
    "Framing must match the reference: square 1:1 canvas, single full-body character, "
    "three-quarter view facing slightly right, the same camera distance and the same body "
    "scale as the reference, character horizontally centered, feet resting on the same "
    "ground line.\n"
    "Background must be a single perfectly flat pale warm-gray, exactly like the reference, "
    "edge to edge, with NOTHING else on it.\n"
    "CRITICAL: do not draw any shadow. No ground shadow, no contact shadow, no drop shadow, "
    "no dark or tinted patch beneath or around the character, no ellipse or smudge under its "
    "feet, no floor, no ground plane, no horizon. The character must appear to float on a "
    "completely empty flat background. Every pixel that is not the character itself must be "
    "exactly the same background color.\n"
    "No scenery, no text, no UI, no watermark, no border, no extra props, no second character."
)


def prompt_for(state: str) -> str:
    return (
        f"Redraw this exact character in a new pose: {STATE_DIRECTION[state]}.\n\n{FRAMING}"
    )


def data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def extract_url(text: str) -> str | None:
    m = re.findall(r"https?://[^\s\)\]]+", text)
    return m[0] if m else None


def generate(model: str, ref: Path, state: str, timeout: int) -> tuple[str, bytes]:
    """一次生成。返回 (图片 URL, 图片字节)。失败抛异常，由调用方重试。"""
    key = os.environ.get("POE_API_KEY")
    if not key:
        raise RuntimeError("POE_API_KEY 没设置")
    prompt = prompt_for(state)
    body = {
        "model": model,
        "stream": True,  # 非流式会被服务端直接断连
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_uri(ref)}},
        ]}],
    }
    r = requests.post(
        API,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=body, timeout=timeout, stream=True,
    )
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")

    chunks: list[str] = []
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload.strip() == "[DONE]":
            break
        try:
            d = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if "error" in d:
            raise RuntimeError(f"API error: {json.dumps(d['error'])[:200]}")
        piece = d.get("choices", [{}])[0].get("delta", {}).get("content")
        if piece:
            chunks.append(piece)

    text = "".join(chunks)
    url = extract_url(text)
    if not url:
        raise RuntimeError(f"响应里没有图片 URL：{text[:200]}")
    img = requests.get(url, timeout=timeout)
    img.raise_for_status()
    if not img.content.startswith(b"\x89PNG"):
        raise RuntimeError(f"下载到的不是 PNG（{img.content[:8]!r}）")
    return url, img.content


def one(model: str, pet: dict, state: str, timeout: int, retries: int) -> dict:
    ref = SRC_DIR / pet["src"]
    dest = OUT_DIR / pet["slug"] / f"{state}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt in range(1, retries + 1):
        try:
            url, blob = generate(model, ref, state, timeout)
            dest.write_bytes(blob)
            print(f"  ✓ {pet['slug']}/{state}  {len(blob) // 1024} KB")
            return {"slug": pet["slug"], "state": state, "model": model,
                    "prompt": prompt_for(state), "ref": pet["src"],
                    "url": url, "out": f"{pet['slug']}/{state}.png"}
        except Exception as e:  # 生成接口偶发失败是常态，不该让整批崩掉
            last = e
            print(f"  … {pet['slug']}/{state} 第 {attempt}/{retries} 次失败：{str(e)[:120]}")
            if attempt < retries:
                time.sleep(2 * attempt)
    print(f"  ✗ {pet['slug']}/{state} 放弃：{str(last)[:160]}")
    return {}


def main() -> int:
    ap = argparse.ArgumentParser(description="生成逐状态宠物立绘")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help=f"默认 {DEFAULT_MODEL}。gpt-image-2 需要先在 Poe 开通 Images API")
    ap.add_argument("--pet", action="append", help="只做这些 slug（可重复）")
    ap.add_argument("--state", action="append", choices=STATES, help="只做这些状态（可重复）")
    ap.add_argument("--force", action="store_true", help="已存在也重新生成")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划")
    ap.add_argument("--workers", type=int, default=3, help="并发数（默认 3，别把限流打满）")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--retries", type=int, default=3)
    args = ap.parse_args()

    roster = json.loads((SRC_DIR / "roster.json").read_text())["pets"]
    pets = [p for p in roster if not args.pet or p["slug"] in args.pet]
    states = [s for s in STATES if not args.state or s in args.state]
    if not pets:
        sys.exit(f"没有匹配的宠物；可选：{[p['slug'] for p in roster]}")

    jobs = [(p, s) for p in pets for s in states
            if args.force or not (OUT_DIR / p["slug"] / f"{s}.png").exists()]
    skipped = len(pets) * len(states) - len(jobs)
    print(f"模型 {args.model}｜{len(pets)} 只 x {len(states)} 态 = "
          f"{len(pets) * len(states)} 张，其中 {len(jobs)} 张要生成"
          f"{f'（{skipped} 张已存在，--force 可覆盖）' if skipped else ''}")
    if args.dry_run:
        for p, s in jobs:
            print(f"  would generate {p['slug']}/{s}")
        return 0
    if not jobs:
        return 0
    if not os.environ.get("POE_API_KEY"):
        sys.exit("POE_API_KEY 没设置")

    records = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(one, args.model, p, s, args.timeout, args.retries)
                   for p, s in jobs]
        for f in as_completed(futures):
            rec = f.result()
            if rec:
                records.append(rec)

    # 出处记录，沿用 output/imagegen/*/prompts.jsonl 的既有约定（追加，不覆盖历史）
    if records:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        with (OUT_DIR / "prompts.jsonl").open("a") as fh:
            for rec in records:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    ok, total = len(records), len(jobs)
    print(f"\n完成 {ok}/{total}")
    if ok < total:
        print("有失败的，重跑一次即可 —— 已存在的会自动跳过")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
