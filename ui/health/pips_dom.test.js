/**
 * pip 条节点的单测：名牌、浮层、Den 共用一个画法 —— 十格、缝在第七格之后、亮格带 on。
 * 用一个最小的假节点跑（只有 children / replaceChildren / appendChild / classList）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPips } from "./pips_dom.js";
import { scoreStrip, PIP_CELLS, PIP_GAP_AFTER } from "./pips.js";

function fakeEl() {
  const classes = new Set();
  const node = {
    children: [],
    get className() {
      return [...classes].join(" ");
    },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c), on),
      contains: (c) => classes.has(c),
    },
    replaceChildren() {
      node.children = [];
    },
    appendChild(c) {
      node.children.push(c);
      return c;
    },
    ownerDocument: { createElement: () => fakeEl() },
  };
  return node;
}

test("十格、缝在第七格之后、亮格带 on", () => {
  const box = renderPips(fakeEl(), scoreStrip(73));
  assert.equal(box.children.length, PIP_CELLS);
  box.children.forEach((c, i) => {
    assert.equal(c.classList.contains("gap"), i === PIP_GAP_AFTER, `gap @${i}`);
    assert.equal(c.classList.contains("on"), i < 7, `on @${i}`);
    assert.ok(c.classList.contains("pip"));
  });
});

test("格数对的时候不重建节点，只切 on；没有 strip = 全灭", () => {
  const box = renderPips(fakeEl(), scoreStrip(100));
  const first = box.children[0];
  renderPips(box, null);
  assert.equal(box.children[0], first, "同一个节点");
  assert.ok(box.children.every((c) => !c.classList.contains("on")));
});
