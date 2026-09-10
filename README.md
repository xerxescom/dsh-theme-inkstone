# dsh-theme-inkstone 砚

DeepSeek Harness Web 客户端的一个配色主题插件：**砚石**中性与**青玉**强调。

它不做别的——不改布局、不加按钮、不碰字体、不注册设置项。整个插件就是一层
`--dsw-*` token 覆盖，叠在 DSH 内置的 light/dark 调色板之上。

```
砚石 stone ladder   #ffffff … #3c4843 … #0c1310     中性阶：绿灰色矿物感
青玉 jade ladder    #e3f1ed … #037968 … #01473c     light 强调
                    #eaf8f4 … #0ebfa5 … #086455     dark 强调
```

![palette](preview.png)

<sub><i>色板与模拟界面——由 <code>tools/render-preview.mjs</code> 从真实 token 值绘制，不是运行截图。
想看实际效果请打开 <code>preview.html</code>：同一套 token 值渲染的交互预览，含真实字体的正文、
气泡、代码块、菜单与状态色。</i></sub>

`preview.html` 是同一套 token 值渲染的交互预览，用浏览器打开即可直观看效果
（真实字体的正文、气泡、代码块、菜单、状态色）。

## 它改了什么

**119 个 token**，分两层发出，这是有意的：

| 层 | 数量 | 为什么 |
|---|---|---|
| `--dsw-static-*` 原始色阶 | 58 | 语义层是从色阶 `var()` 派生出来的，改色阶能让整套语义别名自动重导出——包括我不认识的、以及未来新增的 |
| 语义 token | 61 | 把最终颜色显式写出来，不留给 `var()` 链去推导 |

覆盖 144 个被组件实际消费的 token 中的 **84 个**；其余 50 个不承载颜色
（字体、elevation、阴影、遮罩、圆角），另有 10 个设计系统**从未声明**——
按主题 README 的规定，这些值「有意不补入」，本主题不去发明它们。

### 两个来自基线的约束

调色不是凭感觉取色，下面两条是从已安装的 DSH 里读出来的事实，也是本主题设计的出发点：

**一、原始色阶在 light/dark 之间是同一张表。** 基线的 `--dsw-static-*` 两个模式里
几乎完全相同（只有 `neutral-bluish-60` 一步不同），换挡由语义层负责——light 指向色阶
的暗端当文字色，dark 指向亮端。所以中性色阶**必须保持模式不变**，否则它就不再是一条
色阶了。生成器里有一条断言专门守这件事。

**二、强调色需要按模式反向修正。** 强调色要在调色板自己的背景上承载文字，所以浅色
背景下要压深、深色背景下要提亮。生成器对强调色族施加相反方向的 OKLCH 明度倾斜
（light −0.075，dark +0.02），中性色族不倾斜。

### 语义状态色不动

`--dsw-static-green/amber/red` 三个族**完全保持基线**。给「警告」重新上色不是主题化，
是改变含义。这三族只在生成器的报告里出现，不出现在覆盖表里。

## 色板是怎么算出来的

`tools/palette.mjs` 从已安装的 `dsh-client-ui-theme` 包里解析出**权威基线**
（`design_platform.css` 以 JS 字符串内联在它的 client bundle 里），然后：

1. 把每个色阶成员转到 **OKLCH**；
2. **保留感知明度 L**，只改色相与彩度——中性阶移到 168°（绿灰）、青玉移到 178°、
   次级强调移到 198°（青蓝）。彩度按一条在两端收敛的曲线给出，所以纯白仍是纯白、
   最深的表面仍近黑，矿物色偏只出现在中间调；
3. 超出 sRGB 色域时逐步降低彩度（58 个成员里有 24 处触发）；
4. 沿真实 CSS `var()` 链（含 alias→alias 引用）把每个 token 重新解出**最终颜色**；
5. 在最终颜色上做 WCAG 对比度校验。

**对比度零回退**：28 组可读性配对，没有任何一组被推到自己原本通过的阈值以下。
其中 `link` / 强调按钮文字 / 业务强调文字在 light 下从 4.23 提升到 5.33。

有 3 组低于阈值，但**基线本身就已经低于阈值**，生成器把它们单独标记为 `inherited`
而不是当作本主题的过失：

| light 下的配对 | 基线 → 砚石 |
|---|---|
| `label-caption` on `bg-base` | 2.13 → 2.13 |
| `state-warn-label` on `bg-base` | 2.79 → 2.79 |
| `state-success-primary` on `bg-base` | 2.28 → 2.28 |

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:xerxescom/dsh-theme-inkstone

# 或从本地检出安装
dsh plugin --profile web add E:\github_own\dsh-theme-inkstone
```

`dsh plugin` 是 pnpm 的转发器：装完后它会检查新依赖是否声明了 `dsh.bundle.patch`，
是的话自动把包名加入 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`
层栈。**然后重启 `dsh web` 才会生效**——正在运行的进程不会重新读层栈。

卸载就反过来：

```sh
dsh plugin --profile web remove dsh-theme-inkstone
```

卸掉后 `ctx.effect` 会把这一层 token 精确回收，界面回到内置调色板。

## 开发

```sh
node tools/palette.mjs        # 读基线 → 重映射 → 校验对比度 → 写 tokens.json
node tools/build-client.mjs   # tokens.json → lib/client.js（浏览器半侧）
node tools/check.mjs          # 12 项产物检查
node tools/preview.mjs        # → preview.html
node tools/render-preview.mjs # → preview.png（Node 自绘，不经过浏览器）
```

**没有打包步骤。** 一个纯配色主题用不到 React、JSX 或样式表导入，所以
`lib/client.js` 由 `tools/build-client.mjs` 用字符串拼装生成——没有东西需要 bundle。
`lib/client.js` 是生成产物，但按 DSH 客户端插件的惯例签入仓库。

### 重新调色

改 `tools/palette.mjs` 顶部的策略常量，然后重跑上面两条生成命令：

| 常量 | 作用 |
|---|---|
| `FAMILIES[*].hue` | 各色族的目标 OKLCH 色相 |
| `chromaCurve` | 彩度随明度的分布曲线 |
| `ACCENT_TILT` | 强调色按模式的明度倾斜 |
| `PAIRS` | 对比度校验的配对与阈值 |

### 产物检查都查什么

`tools/check.mjs` 不复算颜色，它只证明磁盘上的文件互相自洽、且与已安装的 DSH 一致：

- token 名合法、无重复键（`JSON.parse` 会静默吞掉重复键）、每个都有 light/dark 两个颜色；
- **每个 token 在已安装的 DSH 里仍然存在**——这是升级后第一时间发现「token 面变了」的地方；
- `report.json` 里没有 `BROKEN` 对比度配对，且它确实是由当前 `tokens.json` 生成的；
- `lib/client.js` 语法有效、内嵌的 token 集合与 `tokens.json` 完全一致（防止改了调色板忘了重新生成）；
- 客户端半侧确实 `inject` 了 theme 服务、把 disposer 交给了 `ctx.effect`（否则卸载会漏掉这一层）；
- `package.json` / `cordis.patch.yml` / client bundle 三者的包名一致，且 `exports` 指向的文件都存在。

## 已知限制

- **它不是一个可在「外观」里选择的主题 id。** DSH 的主题注册表里第三方 id 是进程内扩展，
  不跨内置 settings schema，重启不保持。本主题因此走 `overrideTokens` 路线：叠在你选的
  light/dark 之上，**随你的配色偏好自动适配**，切换模式时每一对颜色都换成对应模式的取值，
  不会出现某一侧不可读。
- **3 组继承自基线的低对比度配对未修复**（见上表）。要修需要把语义状态色按模式拆开覆盖，
  而 `--dsw-alias-state-success-primary` 这类 token 同时被当作文字色和填充色使用，
  贸然压深会连带改变填充。属于独立的一次改动。
- **没有用排版扩展缝。** `--dsw-font-family` / `--dsw-font-mono` 是声明在主题包里、
  组件会读取的 token，换字体是可行的下一步，但需要确认目标机器上字体存在，
  本版只做颜色。
- **依赖源码扫描。** 覆盖率与「token 是否仍存在」的检查靠扫描已安装的客户端 bundle。
  如果 DSH 改变了 bundle 的布局（`design_platform_css_default` 不再是那个字符串），
  生成器会**明确报错**而不是静默产出错色板。
