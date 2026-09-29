/**
 * pip 条的节点（编码见 ./pips.js）。宠物名牌、浮层的分数按钮、Den 共用这一份：
 * 格数与宽缝的位置只在 pips.js 定义一次，这里是唯一把它变成节点的地方。
 * 只用 box 自己的 ownerDocument，所以单测里给一个假节点就能跑。
 */
import { PIP_CELLS, PIP_GAP_AFTER } from "./pips.js";

/**
 * 把 box 画成十个格子（格数不对才重建 —— 名牌每次推送只切 on，不重建节点），
 * 第 PIP_GAP_AFTER 格带 gap class（宽缝画在它左边）；strip.cells[i] 为真的格子带 on。
 * box 自己的 class（kind / band）由调用方定。
 *
 * @param {Element} box
 * @param {{ cells: boolean[] } | null | undefined} strip 没有 = 全灭
 * @param {string} [cls] 每一格的 class
 */
export function renderPips(box, strip, cls = "pip") {
  if (box.children.length !== PIP_CELLS) {
    box.replaceChildren();
    for (let i = 0; i < PIP_CELLS; i++) {
      const cell = box.ownerDocument.createElement("span");
      cell.className = i === PIP_GAP_AFTER ? `${cls} gap` : cls;
      box.appendChild(cell);
    }
  }
  for (let i = 0; i < PIP_CELLS; i++) box.children[i].classList.toggle("on", Boolean(strip?.cells?.[i]));
  return box;
}
