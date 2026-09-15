---
title: undefined：Zig 怎么处理还没写入的内存
description: 零初始化用 0 填满每个变量，C 的未初始化是未定义行为，Zig 给了一个明确标记 undefined，语义是「先写后读」。这篇在四种构建模式下实测读 undefined 的后果，看清 0xAA 填充和优化器各行其是的样子。实验均在 Zig 0.16.0 上进行。
pubDate: 2026-09-04
category: zig
tags: [Zig, 编程语言]
---

变量拿到名字，不等于拿到值。「声明」和「有值」之间隔着一段真空，真空里放着什么，是每种语言都必须回答的问题。

多数语言的回答是提前把这段真空填掉。Java 给每个字段铺零，安全，但零像个善意的谎言：忘了初始化的字段揣着 0 混过所有检查，bug 不吵不闹，要在很远的地方才显形；而且铺零不是免费的，一个大数组归零，在热路径上是真实的 CPU 开销。C 把未初始化读定义成 UB：读出来是什么随缘，但 fresh page 常年恰好是零，bug 在测试机上藏得很好，上线之后才暴露；更糟的是编译器还拿这个 UB 做优化，理论上能「优化出」任何东西。

Zig 的回答是把这段真空标出来：`undefined`。语言文档的原文是：

> undefined means the value could be anything, even something that is nonsense according to the type.

这个值可以是任何东西，哪怕按类型来讲是胡说八道的东西。它的实际语义是一份你写给编译器的承诺：这个值不会被读，除非先被写。文档里那句大白话翻译就是："The value will be unused, or overwritten before being used."

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 206" role="img" aria-label="三种语言对声明与有值之间真空的回答：Java 提前铺零，安全但零像善意的谎言且归零有真实开销；C 把未初始化读定义成未定义行为，读出来随缘，编译器还拿它做优化；Zig 用 undefined 把真空标出来，换取不生成清零代码，承诺先写后读" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11.5" fill="#6b675e">「声明」与「有值」之间的真空，三种回答</text>
<rect class="bx-q" x="20" y="34" width="196" height="140" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="118" y="56" text-anchor="middle" font-size="11" fill="#2b2a26">Java · 填掉</text>
<text class="ts" x="118" y="80" text-anchor="middle" font-size="9" fill="#6b675e">每个字段提前铺零</text>
<text class="ts" x="118" y="100" text-anchor="middle" font-size="9" fill="#6b675e">零像善意的谎言：</text>
<text class="ts" x="118" y="116" text-anchor="middle" font-size="9" fill="#6b675e">忘初始化的 0 混过所有检查</text>
<text class="ts" x="118" y="140" text-anchor="middle" font-size="9" fill="#6b675e">大数组归零</text>
<text class="ts" x="118" y="156" text-anchor="middle" font-size="9" fill="#6b675e">是热路径上的真实开销</text>
<rect class="bx-q" x="232" y="34" width="196" height="140" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="330" y="56" text-anchor="middle" font-size="11" fill="#2b2a26">C · 装作没有</text>
<text class="ts" x="330" y="80" text-anchor="middle" font-size="9" fill="#6b675e">未初始化读 = UB</text>
<text class="ts" x="330" y="100" text-anchor="middle" font-size="9" fill="#6b675e">读出来随缘：</text>
<text class="ts" x="330" y="116" text-anchor="middle" font-size="9" fill="#6b675e">fresh page 常年恰好是零</text>
<text class="ts" x="330" y="140" text-anchor="middle" font-size="9" fill="#6b675e">bug 在测试机藏得很好</text>
<text class="ts" x="330" y="156" text-anchor="middle" font-size="9" fill="#6b675e">编译器还拿 UB 做优化</text>
<rect class="bx" x="444" y="34" width="196" height="140" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="t" x="542" y="56" text-anchor="middle" font-size="11" fill="#2b2a26">Zig · 标出来</text>
<text class="ts" x="542" y="80" text-anchor="middle" font-size="9" fill="#6b675e">undefined：显式记号</text>
<text class="ts" x="542" y="100" text-anchor="middle" font-size="9" fill="#6b675e">承诺：先写后读</text>
<text class="ts" x="542" y="124" text-anchor="middle" font-size="9" fill="#6b675e">回报：不生成清零代码</text>
<text class="ts" x="542" y="148" text-anchor="middle" font-size="9" fill="#6b675e">违约仍是 UB，</text>
<text class="ts" x="542" y="164" text-anchor="middle" font-size="9" fill="#6b675e">但写在了明面上</text>
<text class="ts" x="20" y="196" font-size="10" fill="#6b675e">真空本身消不掉，区别只在：填平它、假装没有，还是立一块牌子</text>
</svg>
</figure>

上一篇讲 Allocator，结尾实测了 use-after-free：Debug 构建下崩溃报告精确到行号，ReleaseFast 下五次运行五次静默退出。那篇讲的是内存还了之后的事；这篇往前走一步，问一个更早的问题：内存拿到之后、写入之前，那段时间里它是什么。文中的四种构建实验都在 Zig 0.16.0 上跑的。

## 正确用法：占住内存，值由写入赋予

承诺的回报是明码标价的：编译器不再需要生成清零代码。`var buf: [4096]u8 = undefined;` 一声不响地占住 4KB 栈内存，一个字节的初始化指令都没有；作为交换，你承诺在读取之前先写入。

这不是冷僻语法。整个标准库里，`= undefined;` 出现了一万零一百七十七次，我数过。最常见的用法：

```zig
const std = @import("std");

fn fakeRead(buf: []u8) usize {
    const msg = "听雨";
    @memcpy(buf[0..msg.len], msg);
    return msg.len;
}

pub fn main() !void {
    var buf: [128]u8 = undefined;
    const n = fakeRead(&buf);
    const got = buf[0..n];
    std.debug.print("读到 {d} 字节: \"{s}\"\n", .{ n, got });
}
```

`buf` 的 128 字节在声明时全是 undefined，但读的只有 `buf[0..n]`，恰好是 `fakeRead` 写过的那段。承诺履行完毕，四个构建模式下这份代码的输出一模一样：

```text
读到 6 字节: "听雨"
```

这就是 undefined 的正确用法：它标注的那段真空，随后被一次写入完整覆盖。「听雨」两个字能安全地待在里面，因为它们是先写进去的，不是从真空里读出来的。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="buf 的 128 字节：声明时全部 undefined；fakeRead 只写入前 6 个字节，即听雨的 UTF-8；程序只读 buf 的 0 到 n 共 6 字节，读取范围与写入范围完全重合，其余 122 字节始终未被读取" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">var buf: [128]u8 = undefined · 每格 ≈ 8 字节（示意）</text>
<rect class="bx" x="24" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<rect class="bx" x="60" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="59" y="57" text-anchor="middle" font-size="9" fill="#2b2a26">听雨 · 6 字节</text>
<rect class="bx-gone" x="96" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="132" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="168" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="204" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="240" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="276" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="312" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="348" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="384" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="420" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="456" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="492" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="528" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="564" y="34" width="34" height="36" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="380" y="57" text-anchor="middle" font-size="9" fill="#a29d90">其余 122 字节：undefined，从未被读</text>
<line class="flc" x1="24" y1="82" x2="94" y2="82" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="24" y1="78" x2="24" y2="86" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="94" y1="78" x2="94" y2="86" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="59" y="100" text-anchor="middle" font-size="9.5" fill="#b03a2e">读取 buf[0..n]，n = 6</text>
<text class="ts" x="24" y="132" font-size="10" fill="#2b2a26">① 声明：128 字节全部 undefined，零初始化指令一条没有</text>
<text class="ts" x="24" y="152" font-size="10" fill="#2b2a26">② fakeRead 写入前 6 字节　③ 只读这 6 字节：读取范围 ⊆ 写入范围，承诺履行</text>
<text class="tc" x="24" y="172" font-size="9.5" fill="#b03a2e">四种构建模式输出一模一样：读到 6 字节 "听雨"</text>
</svg>
</figure>

## Debug 下的 0xAA

承诺总有人违背。Zig 对此的态度藏在文档的下一句里：

> In Debug and ReleaseSafe mode, Zig writes 0xaa bytes to undefined memory. This is to catch bugs early, and to help detect use of undefined memory in a debugger.

Debug 和 ReleaseSafe 下，undefined 的内存会被写上 0xAA。很多文章把这一句讲成「Zig 用 0xAA 填充垃圾值」，讲反了：0xAA 是调试构建里的检测手段，任务是让违约在第一时间现形。

最直白的实验：

```zig
const std = @import("std");

pub fn main() void {
    var x: usize = undefined;
    _ = &x;
    std.debug.print("x = {d} (0x{x})\n", .{ x, x });
}
```

（`_ = &x;` 有个实际用处：拦住又一个编译器检查。`var` 声明从未被写入也不行，它坚持要你承认这个变量并不需要 `var`。第一个实验我就是在这一行被拦下的。）

Debug 构建运行：

```text
x = 12297829382473034410 (0xaaaaaaaaaaaaaaaa)
```

八个字节的 usize，每一位都是 0xAA。这个值被选得很讲究：非零，冒充不了零初始化的侥幸；处处非法，拿它当指针、当 enum tag、当长度，几乎注定当场出事；可复现，不依赖内存里恰好残留了什么。随机值只能靠运气撞上 bug，0xAA 是设计出来让 bug 撞上它的。

## ReleaseFast 的零，根本不是读出来的

矩阵跑到 ReleaseFast，事情开始有意思了。

同一个实验，四种模式的输出：

```text
Debug        x = 12297829382473034410 (0xaaaaaaaaaaaaaaaa)
ReleaseSafe  x = 12297829382473034410 (0xaaaaaaaaaaaaaaaa)
ReleaseFast  x = 0 (0x0)
ReleaseSmall x = 0 (0x0)
```

ReleaseFast 打出 0。第一反应是「碰巧栈上是零」。但「碰巧」可以证伪：先把栈弄脏再读。

```zig
const std = @import("std");

fn dirty() void {
    var trash: [64]u8 = undefined;
    _ = &trash;
    for (&trash) |*b| b.* = 0xCD;
}

pub fn main() void {
    dirty(); // 先把栈弄脏
    var buf: [16]u8 = undefined;
    _ = &buf;
    std.debug.print("buf:", .{});
    for (buf) |b| std.debug.print(" {x:0>2}", .{b});
    std.debug.print("\n", .{});
}
```

`dirty()` 在同一个栈位置写下 64 个 0xCD，随后 `buf` 极可能落在同一片内存上。如果 ReleaseFast 真的在「读栈」，它该读到 0xCD 的残骸。实际输出：

```text
Debug        buf: aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa
ReleaseSafe  buf: aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa
ReleaseFast  buf: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
ReleaseSmall buf: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

脏了的栈，读出了干净的零。这个结果只有一种解释：它根本没读。反汇编也确认了，ReleaseFast 的 `main` 里没有一行读栈指令，那个打印循环在往 stderr 写常量 0。

这才是 undefined 的真面目。在编译器的世界里，它不是一块内容未知的内存，是一个可以任意取值的记号。ReleaseFast 遇到「读 undefined」，就随手填一个对自己最方便的值，比如 0，因为常量 0 最好生成。程序没有在偷看内存，它在编造内存里的东西。

## 真实的违约：一个没盖全的分支

到目前为止的违约都是故意的。真实的 bug 长得无害得多，比如一个没盖全的分支：

```zig
const std = @import("std");

const Mode = enum { fast, safe };

const Config = struct {
    retries: u8,
    mode: Mode,
};

pub fn main(init: std.process.Init) !void {
    var it = init.minimal.args.iterate();
    _ = it.next(); // argv[0]
    const even = if (it.next()) |a| std.mem.eql(u8, a, "even") else false;

    var cfg: Config = undefined;
    _ = &cfg;
    if (even) {
        cfg = .{ .retries = 3, .mode = .safe };
    }
    std.debug.print("retries = {d}, mode = {s}\n", .{ cfg.retries, @tagName(cfg.mode) });
}
```

（读命令行参数的几行是 0.16 的新 API，与本题无关，把它当成一颗返回真假的骰子就行。）

带 `even` 参数运行，分支走进去，`cfg` 被完整写入，一切正常。不带参数运行，分支没走，`cfg` 还是 undefined，Debug 构建下：

```text
thread 46367 panic: invalid enum value
exp3.zig:21:68: 0x11d742c in main (exp3.zig)
    std.debug.print("retries = {d}, mode = {s}\n", .{ cfg.retries, @tagName(cfg.mode) });
```

检查当场拦住了。`mode` 字段的 tag 读出来是 0xAA，不在 `{ fast, safe }` 里，`@tagName` 的安全检查立刻 panic，报告精确到列：`cfg.mode` 四个字，第 68 列，正是出错位置。上一篇的 DebugAllocator 把错误的 free 从上线后的崩溃提前成当场报错，这里是同一件事的初始化版本，违约者甚至没机会把错误的值用出去。

## 四种模式，四种结果

同一段代码、同一个未写入的 `cfg`，四种构建模式给出了各自的数字：

| 构建模式 | retries | mode | 结局 |
| --- | --- | --- | --- |
| Debug | — | — | panic: invalid enum value，行号列号精确 |
| ReleaseSafe | 170 | fast | 正常打印，无报错 |
| ReleaseFast | 3 | fast | 正常打印，无报错 |
| ReleaseSmall | 3 | fast | 正常打印，无报错 |

这四行值得逐个看。

ReleaseSafe 的 170 就是 0xAA，填充还在。但 `mode` 打出 "fast" 就耐人寻味了：0xAA 不是合法的 tag，怎么过的检查？反汇编给出了答案：函数里有一条 `mov $0xaa, %r15b`，编译器把 undefined 的 u8 固化成了常量 0xAA，这是 retries 的值；而 `@tagName` 对 undefined tag 的 switch，被编译器在编译期直接折叠成了 "fast" 分支，连非法 tag 的安全检查都跟着消失了。同一个 `cfg`，两个字段走上了两条路：u8 读到固化的 0xAA，enum 的分支判断被整体折走。

ReleaseFast 的结果更妙：`retries = 3`。本次运行没有一行代码写入过 3，它来自旁边那个没走到的分支里的常量 `.retries = 3`。编译器需要给 undefined 一个值，环顾四周，捡了最顺手的一个。

把两份结果放在一起，undefined 的完整语义就显形了。它不是一块放着垃圾的内存，垃圾至少是一块确定的内存。它更像一张空白支票：每一处使用，编译器都可以独立地填一个对自己最方便的数。ReleaseSafe 给 retries 填了 0xAA，给 mode 填了 "fast"，两张支票出自同一支笔，金额却各不相干；ReleaseFast 干脆把隔壁的 3 填了进来。语言文档那句 "could be anything, even something that is nonsense according to the type"，字字都是实指。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 252" role="img" aria-label="同一只未写入的 cfg 在三种运行模式下的读数：Debug 下 mode 的 tag 是 0xAA，非法值被 tagName 检查当场拦下 panic；ReleaseSafe 下 retries 固化成常量 0xAA 即 170，mode 的分支被编译期折叠成 fast；ReleaseFast 下 retries 被填成 3，来自旁边没走到的分支里的常量" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="udA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-sick" x="160" y="16" width="340" height="42" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="ts" x="330" y="34" text-anchor="middle" font-size="10" fill="#b03a2e">var cfg: Config = undefined</text>
<text class="ts" x="330" y="50" text-anchor="middle" font-size="9" fill="#6b675e">分支没走到：retries 与 mode 都未被写入</text>
<line class="fl" x1="240" y1="58" x2="120" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#udA3)"/>
<line class="fl" x1="330" y1="58" x2="330" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#udA3)"/>
<line class="fl" x1="420" y1="58" x2="540" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#udA3)"/>
<rect class="bx-sick" x="20" y="90" width="196" height="120" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="118" y="112" text-anchor="middle" font-size="10" fill="#b03a2e">Debug</text>
<text class="ts" x="118" y="136" text-anchor="middle" font-size="9" fill="#6b675e">mode 的 tag 读出 0xAA</text>
<text class="ts" x="118" y="152" text-anchor="middle" font-size="9" fill="#6b675e">不在 { fast, safe } 里</text>
<text class="ts" x="118" y="176" text-anchor="middle" font-size="9" fill="#b03a2e">panic: invalid enum value</text>
<text class="ts" x="118" y="192" text-anchor="middle" font-size="9" fill="#6b675e">行列号精确到出错处</text>
<rect class="bx-q" x="232" y="90" width="196" height="120" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="112" text-anchor="middle" font-size="10" fill="#2b2a26">ReleaseSafe</text>
<text class="ts" x="330" y="136" text-anchor="middle" font-size="9" fill="#6b675e">retries ← 0xAA（= 170）</text>
<text class="ts" x="330" y="152" text-anchor="middle" font-size="9" fill="#6b675e">u8 被固化成常量</text>
<text class="ts" x="330" y="176" text-anchor="middle" font-size="9" fill="#6b675e">mode ← "fast"</text>
<text class="ts" x="330" y="192" text-anchor="middle" font-size="9" fill="#6b675e">switch 在编译期被整体折叠</text>
<rect class="bx-q" x="444" y="90" width="196" height="120" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="542" y="112" text-anchor="middle" font-size="10" fill="#2b2a26">ReleaseFast / Small</text>
<text class="ts" x="542" y="136" text-anchor="middle" font-size="9" fill="#6b675e">retries ← 3</text>
<text class="ts" x="542" y="152" text-anchor="middle" font-size="9" fill="#6b675e">捡自没走到的分支的常量</text>
<text class="ts" x="542" y="176" text-anchor="middle" font-size="9" fill="#6b675e">mode ← "fast"</text>
<text class="ts" x="542" y="192" text-anchor="middle" font-size="9" fill="#6b675e">本次运行没有任何代码写过 3</text>
<text class="ts" x="20" y="240" font-size="10" fill="#6b675e">每处使用各填各的数：它是记号，不是一块内容未知的内存</text>
</svg>
</figure>

所以「ReleaseFast 下 undefined 恰好是零」这句话是错的，错得和「C 的未初始化恰好是零」一模一样。它不是零，也不是任何具体的东西。

## 编译期不检查

读 undefined 这么危险，编译器能不能在编译期拦住？最后一个实验给出的答案是：它不管。

```zig
const std = @import("std");

pub fn main() void {
    const x: usize = undefined;
    std.debug.print("x = {d}\n", .{x});
}
```

`const` 声明，赋值 undefined，然后直接读。这段违约写得明目张胆，编译器一个字的意见都没有，Debug 构建照常打出 `x = 12297829382473034410`，还是那八个 0xAA。静态层面，Zig 对「读 undefined」没有任何检查。它唯一管过的是第一个实验里那个 `var` 从未被写入的报错，但那是变量可变性的检查，不是初始化的检查。

一层层数下来，防线是这样的：语法层没有，类型层没有，Debug/ReleaseSafe 的运行时有一层显影（0xAA 加安全检查），ReleaseFast/Small 什么都没有。承诺的履行完全靠写代码的人自觉，0xAA 只是事后验伤的手段。文档在这件事上罕见地坦白：0xAA 填充 "is only an implementation feature, not a language semantic"，是实现细节，不是语言承诺。依赖它写的代码，换个后端就可能碎。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="读 undefined 的四层防线盘点：语法层没有，undefined 与 0 的写法同样无辜；类型层没有，const 赋 undefined 再直接读也能编译；Debug 与 ReleaseSafe 运行时有一层显影，0xAA 填充加非法值检查；ReleaseFast 与 ReleaseSmall 什么都没有，编译器编造一个值继续跑" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<rect class="bx-sick" x="20" y="20" width="270" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/>
<text class="ts" x="36" y="43" font-size="10" fill="#b03a2e">语法层</text>
<text class="tc" x="300" y="43" font-size="10" fill="#b03a2e">✗</text>
<text class="ts" x="324" y="43" font-size="9.5" fill="#6b675e">= undefined 与 = 0 写出来同样无辜</text>
<rect class="bx-sick" x="20" y="64" width="270" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/>
<text class="ts" x="36" y="87" font-size="10" fill="#b03a2e">类型层</text>
<text class="tc" x="300" y="87" font-size="10" fill="#b03a2e">✗</text>
<text class="ts" x="324" y="87" font-size="9.5" fill="#6b675e">const x: usize = undefined 直接读，照样编译</text>
<rect class="bx" x="20" y="108" width="270" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="36" y="131" font-size="10" fill="#2b2a26">运行时 · Debug / ReleaseSafe</text>
<text class="ts" x="300" y="131" font-size="10" fill="#2b2a26">✓</text>
<text class="ts" x="324" y="131" font-size="9.5" fill="#6b675e">0xAA 显影 + 非法 tag / 越界检查</text>
<rect class="bx-sick" x="20" y="152" width="270" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/>
<text class="ts" x="36" y="175" font-size="10" fill="#b03a2e">运行时 · ReleaseFast / Small</text>
<text class="tc" x="300" y="175" font-size="10" fill="#b03a2e">✗</text>
<text class="ts" x="324" y="175" font-size="9.5" fill="#6b675e">编译器编个最省事的值，程序继续跑</text>
<text class="ts" x="20" y="202" font-size="9.5" fill="#a29d90">唯一的一层还有开关：发布构建通常选 Fast，显影随之消失</text>
</svg>
</figure>

## 显影管不住的事

它是货真价实的 UB。这一点怎么强调都不过分。undefined 不是「安全的垃圾值」，是 C 意义上的未定义行为，只是被 Zig 拉到了明面上、配了一套调试工具。Rust 处理同一件事用的是 `MaybeUninit`，同样的承诺，圈在 `unsafe` 块里，读未初始化内存的代码一眼就能被审计出来。Zig 没有 `unsafe` 关键字，`var x: T = undefined` 和 `var x: T = 0` 在语法上同样无辜。

显影是有开关的。0xAA 和非法 tag 检查只在 Debug 和 ReleaseSafe 里存在，而发布构建通常选 ReleaseFast。上一篇的 use-after-free 是这样，这篇的空白支票也是这样：Debug 下精确报错，ReleaseFast 下编译器替你编一个值继续跑。测试覆盖不到的违约路径，上了线就是定时炸弹。上一篇在悬垂指针那里得出过同样的结论，这篇发现它适用的范围比我想的更大。

承诺要自己背全。「先写后读」说起来一句话，做起来处处是边角：分支要盖全（这次的 `cfg`）、循环边界要覆盖到每一次读（`buf[0..n]` 的 n 不能大于写入量）、struct 可以只初始化一半字段而另一半全裸。零初始化语言里这些都不用想，代价是 bug 藏得更深。Zig 把「这个变量现在有值吗」从语言的默认知变成了程序员的显式责任。写惯了 Java 的人会觉得烦；写惯了 C 的人会发现，自己一直在承担这份责任，只是从没写在明处。

---

到这里，系列前几篇的线索可以接上了。comptime 把求值时机交还给调用方，错误处理把失败显式成值，Allocator 把分配决策变成参数，这一篇补上最朴素的一块：初始化是程序员写在明处的承诺。四篇的主题其实是同一个，把藏在语言里、运行时里或者 UB 里的责任，还原成源代码里看得见的东西。零初始化把「还没有值」伪装成 0，C 把它伪装成「碰巧是 0」，Zig 只是留了一行字：此处尚无值，先写后读，风险自负。

下一篇讲整数溢出。同样是没有隐藏默认值的问题：`255 + 1` 等于什么，Zig 的答案写在操作符上。
