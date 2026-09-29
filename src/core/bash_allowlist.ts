/**
 * 「永远允许」能授予的 Bash 命令（U9 复审）—— 一张**允许**表，不是一张拒绝表。
 *
 * 之前的模型是「危险类之外都能授予」：少列一项（`nice`、`gh api`、`docker run`……）就等于
 * 按一次放行了一条永久的、任意执行的规则。现在反过来：只有下面列出来的命令前缀才会出现
 * 「永远允许」这个选项，表外的一律没有。rules.ts 的 DESTRUCTIVE_COMMANDS 仍然在，
 * 作为第二道保险 —— 将来有人往这张表里加了一项跟危险类相交的，照样拿不到授予（且有测试守着）。
 *
 * 这张表同时是 command_prefix 的**词汇表**（隐私）：adapter 与 ingress 只保留落在这里的词，
 * `echo hunter2`、`npm install internal-pkg`、`git checkout acme-acquisition` 的第二个词是
 * 用户自己的参数，不进库（见 events.ts 的 commandPrefix / minimiseCommandPrefix）。
 *
 * 选进来的标准：只读，或者只是在本地跑这个项目自己的测试 / 构建。后一类本质上执行的是
 * 项目里的脚本（package.json、Makefile、测试文件）——这是这一类的前提，不是漏洞；
 * 但它不下载、不发布、不碰远端。单个词的前缀（`Bash(ls *)`）只给程序本身只读的那几个。
 *
 * 刻意不在表里的：`rg`（`--pre <cmd>` 会执行任意命令）、`tsc`（`--outFile` 能写到项目外）、
 * `pytest`（单个词但不是只读 —— 它跑的是任意 conftest）。
 *
 * 零依赖：adapter（hook 进程）也 import 它，要保持轻。
 */

export interface GrantableCommand {
  /** 按词比较的完整前缀，写进规则是 `Bash(<prefix> *)` */
  prefix: string;
  why: string;
}

export const GRANTABLE_COMMANDS: ReadonlyArray<GrantableCommand> = Object.freeze([
  // 只读的 git：看状态与历史，不改工作区、不改引用、不碰远端
  { prefix: "git status", why: "read-only: shows the working tree" },
  { prefix: "git diff", why: "read-only: shows changes" },
  { prefix: "git log", why: "read-only: shows history" },
  { prefix: "git show", why: "read-only: shows an object" },
  // 本地跑这个项目自己的测试 / 检查 / 构建（npm / pnpm / yarn）
  { prefix: "npm test", why: "runs the project's own tests locally" },
  { prefix: "npm run test", why: "runs the project's own tests locally" },
  { prefix: "npm run lint", why: "runs the project's own linter locally" },
  { prefix: "npm run build", why: "builds the project locally" },
  { prefix: "npm run typecheck", why: "type-checks the project locally" },
  { prefix: "pnpm test", why: "runs the project's own tests locally" },
  { prefix: "yarn test", why: "runs the project's own tests locally" },
  // 本地测试 / 构建（cargo / go / make）
  { prefix: "cargo test", why: "runs the project's own tests locally" },
  { prefix: "cargo build", why: "builds the project locally" },
  { prefix: "cargo check", why: "type-checks the project locally" },
  { prefix: "go test", why: "runs the project's own tests locally" },
  { prefix: "go build", why: "builds the project locally" },
  { prefix: "go vet", why: "checks the project locally" },
  { prefix: "make test", why: "runs the project's own tests locally" },
  // 程序本身只读：只有这几个能以单个词授予
  { prefix: "ls", why: "read-only: lists files" },
  { prefix: "cat", why: "read-only: prints files" },
  { prefix: "pwd", why: "read-only: prints the directory" },
  { prefix: "which", why: "read-only: locates a program" },
  { prefix: "wc", why: "read-only: counts lines" },
  { prefix: "head", why: "read-only: prints the start of a file" },
  { prefix: "tail", why: "read-only: prints the end of a file" },
  { prefix: "grep", why: "read-only: searches files" },
]);

const GRANTABLE_SET: ReadonlySet<string> = new Set(GRANTABLE_COMMANDS.map((c) => c.prefix));

/**
 * 词汇表：可授予前缀的每一个**按词前缀**（`npm run test` 贡献 `npm`、`npm run`、`npm run test`）。
 * command_prefix 只能是这里面的一项 —— 程序名认得、后面的词认得才留。
 */
const VOCABULARY: ReadonlySet<string> = new Set(
  GRANTABLE_COMMANDS.flatMap((c) => {
    const w = c.prefix.split(" ");
    return w.map((_, i) => w.slice(0, i + 1).join(" "));
  }),
);

/** 这个前缀能不能拿到「永远允许」（完全相同才算，不是「落在里面」） */
export function isGrantableCommand(prefix: string): boolean {
  return GRANTABLE_SET.has(prefix);
}

/**
 * 把一串词削成词汇表里最长的那个按词前缀；程序名本身都不认得 → undefined。
 * `["npm","install","pkg"]` → `npm`；`["git","status"]` → `git status`；`["echo","x"]` → undefined。
 */
export function retainKnownWords(words: readonly string[]): string | undefined {
  let kept: string | undefined;
  for (let i = 1; i <= words.length; i++) {
    const candidate = words.slice(0, i).join(" ");
    if (!VOCABULARY.has(candidate)) break;
    kept = candidate;
  }
  return kept;
}
