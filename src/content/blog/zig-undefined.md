---
title: undefined 不是零，0xAA 也不是垃圾
description: 零初始化递给每个变量一杯温水，C 的未初始化是一场静默的赌博，Zig 的答案是登记簿上的一笔签字。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-04
tags: [Zig, 编程语言]
---

一间刚退房的客房，钥匙已经在你手里，但床单是新的还是旧的，前台不说。变量也一样：拿到名字，不等于拿到值。「声明」和「有值」之间隔着一段真空，真空里放着什么，是每种语言都必须回答的问题。

多数语言的回答是提前把房间收拾干净。Java 给每个字段铺上雪白的零——安全，贴心，但零是个善意的谎言：忘了初始化的字段揣着 0 混过所有检查，bug 不吵不闹，等在千里之外显形；而且铺床不是免费的，一个大数组归零，在热路径上是真实的 CPU 开销。C 说随缘——未初始化读出来是 UB，但 fresh page 常年恰好是零，bug 在测试机上藏得很好，上线才翻脸，更糟的是编译器还拿这个 UB 做优化，理论上能「优化出」任何东西。

Zig 的回答有点冷酷，也很体面：房间的状态我不替你假装知道，但你在登记簿上签的字——`undefined`——白纸黑字，说好了入住之前，东西不算你的。

上一篇讲 Allocator，结尾实测了 use-after-free：Debug 构建下崩溃报告精确到行号，ReleaseFast 下五次运行五次静默退出。那篇讲的是内存**还了之后**的事；这篇往前走一步，问一个更早的问题：内存**拿到之后、写入之前**，那段时间里它是什么。代码照例全部在 Zig 0.16.0 上验证过。

## undefined 是一份契约，不是一个值

先把官方定义摆在桌上，语言文档的原文说得比我利落：

> undefined means the value could be anything, even something that is nonsense according to the type.

翻译过来：这个值可以是任何东西，哪怕按类型来讲是胡说八道的东西。但它的真实身份不是「一个不可预测的值」，是一份你写给编译器的契约——**这个值不会被读，除非先被写**。文档里那句大白话翻译就是："The value will be unused, or overwritten before being used."

签字的回报是明码标价的：编译器不再需要生成清零代码。`var buf: [4096]u8 = undefined;` 一声不响地占住 4KB 栈内存，一个字节的初始化指令都没有。作为交换，你承诺在读取之前先写入。

这不是冷僻语法。整个标准库里，`= undefined;` 出现了一万零一百七十七次——我数过。最常见的姿势是「先占内存，值由写入赋予」：

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

`buf` 的 128 字节在声明时全是 undefined，但读的只有 `buf[0..n]`——恰好是 `fakeRead` 写过的那段。契约履行完毕，四个构建模式下这份代码的输出一模一样：

```text
读到 6 字节: "听雨"
```

这是 undefined 的正确用法：它标注的那段真空，随后被一次写入完整覆盖。「听雨」两个字能安全地待在里面，因为它们不是从真空里读出来的，是先写进去的。

## 0xAA 是显影液，不是垃圾

契约总有人违约。Zig 对违约者的态度藏在文档的下一句里：

> In Debug and ReleaseSafe mode, Zig writes 0xaa bytes to undefined memory. This is to catch bugs early, and to help detect use of undefined memory in a debugger.

Debug 和 ReleaseSafe 下，undefined 的内存会被写上 0xAA。很多文章把这一句讲成「Zig 用 0xAA 填充垃圾值」——讲反了。0xAA 不是给你的垃圾，是编译器派驻在调试构建里的便衣。它的任务只有一个：让违约在第一时间现形。

最直白的实验：

```zig
const std = @import("std");

pub fn main() void {
    var x: usize = undefined;
    _ = &x;
    std.debug.print("x = {d} (0x{x})\n", .{ x, x });
}
```

（`_ = &x;` 不是仪式，是又一个编译器检查：`var` 声明从未被写入也不行，它坚持要你承认这个变量并不需要 `var`。第一个实验我就是在这一行被拦下的。）

Debug 构建运行：

```text
x = 12297829382473034410 (0xaaaaaaaaaaaaaaaa)
```

八个字节的 usize，每一位都是 0xAA。这个值被选得很讲究：非零——冒充不了零初始化的侥幸；处处非法——拿它当指针、当 enum tag、当长度，几乎注定当场出事；可复现——它不依赖内存里恰好残留了什么。随机值只能靠运气撞上 bug，0xAA 是设计出来让 bug 撞上它的。

## 脏了的栈，读不出来的零

那 ReleaseFast 呢？矩阵跑下去，事情开始有意思了。

同一个实验，四种模式的输出：

```text
Debug        x = 12297829382473034410 (0xaaaaaaaaaaaaaaaa)
ReleaseSafe  x = 12297829382473034410 (0xaaaaaaaaaaaaaaaa)
ReleaseFast  x = 0 (0x0)
ReleaseSmall x = 0 (0x0)
```

ReleaseFast 打出 0。第一反应是「碰巧栈上是零」。但「碰巧」是可以证伪的——我先把栈弄脏再读：

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

脏了的栈，读出了干净的零。这个结果只有一种解释：**它根本没读**。反汇编确认了——ReleaseFast 的 `main` 里没有一行读栈指令，那个打印循环在往 stderr 写常量 0。

这才是 undefined 的真面目。在编译器的世界里，它不是一块内容未知的内存，是一个可以**任意取值**的记号。ReleaseFast 遇到「读 undefined」，做法不是去读，是随手填一个对自己最方便的值——填 0，因为常量 0 最好生成。你以为程序在偷看房间，其实它在编造房间里的东西。

## 只盖一半的分支：违约现场

到目前为止的违约都是故意的。真实的 bug 长得无害得多——一个没盖全的分支：

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

带 `even` 参数运行，分支走进去，`cfg` 被完整写入，一切正常。不带参数运行——分支没走，`cfg` 还是 undefined——Debug 构建下：

```text
thread 46367 panic: invalid enum value
exp3.zig:21:68: 0x11d742c in main (exp3.zig)
    std.debug.print("retries = {d}, mode = {s}\n", .{ cfg.retries, @tagName(cfg.mode) });
```

便衣当场把人按住了。`mode` 字段的 tag 读出来是 0xAA，不在 `{ fast, safe }` 里，`@tagName` 的安全检查立刻 panic，报告精确到列——`cfg.mode` 四个字，第 68 列，正是案发位置。上一篇说 DebugAllocator 把「free 了不该 free 的东西」从深夜崩溃提前成当场报错；这里同一个剧本又演了一遍，这次演的是初始化。违约者甚至没机会把错误的值用出去。

## 四份口供

同一段代码、同一个未写入的 `cfg`，四种构建模式各执一词：

| 构建模式 | retries | mode | 结局 |
| --- | --- | --- | --- |
| Debug | — | — | panic: invalid enum value，行号列号精确 |
| ReleaseSafe | 170 | fast | 正常打印，无报错 |
| ReleaseFast | 3 | fast | 正常打印，无报错 |
| ReleaseSmall | 3 | fast | 正常打印，无报错 |

这四行值得逐份审讯。

ReleaseSafe 的 170 就是 0xAA——填充还在。但 `mode` 打出 "fast" 就耐人寻味了：0xAA 不是合法的 tag，怎么过的检查？反汇编给出了答案：函数里有一条 `mov $0xaa, %r15b`——编译器把 undefined 的 u8 固化成了常量 0xAA，这是 retries 的值；而 `@tagName` 对 undefined tag 的 switch，被编译器在编译期直接折叠成了 "fast" 分支，连非法 tag 的安全检查都跟着消失了。**同一个 `cfg`，两个字段，两种命运**：u8 读到固化的 0xAA，enum 的分支判断被整体折走。

ReleaseFast 的供词更妙：`retries = 3`。这个 3 是哪儿来的？本次运行从头到尾没有一行代码写入过 3——它来自旁边那个**没走到**的分支里的常量 `.retries = 3`。编译器需要给 undefined 一个值，环顾四周，捡了最顺手的一个。

把两份供词放在一起，undefined 的完整语义就显形了。它不是「一块放着垃圾的内存」——垃圾至少是一块确定的内存。它更像一张空白支票：**每一处使用，编译器都可以独立地填一个对自己最方便的数**。ReleaseSafe 给 retries 填了 0xAA，给 mode 填了 "fast"，两张支票出自同一支笔，金额却各不相干；ReleaseFast 干脆把隔壁的 3 填了进来。语言文档那句 "could be anything, even something that is nonsense according to the type"，字字都是实指。

所以「ReleaseFast 下 undefined 恰好是零」这句话是错的，错得和「C 的未初始化恰好是零」一模一样——它不是零，也不是任何具体的东西。它什么都不是，正因如此，它才什么都可以是。

## 编译器不查这张契约

看到这里你可能会问：读 undefined 这么危险，编译器为什么不在**编译期**拦住我？我做了最后一个实验，答案是：它不管。

```zig
const std = @import("std");

pub fn main() void {
    const x: usize = undefined;
    std.debug.print("x = {d}\n", .{x});
}
```

`const` 声明，赋值 undefined，然后直接读——这段违约写得明目张胆，编译器一个字的意见都没有，Debug 构建照常打出 `x = 12297829382473034410`，还是那八个 0xAA。静态层面，Zig 对「读 undefined」没有任何检查。它唯一管过的是第一个实验里那个 `var` 从未被写入的报错——但那是变量可变性的检查，不是初始化的检查。

一层层数下来，这张契约的防线是这样的：**语法层没有，类型层没有，Debug/ReleaseSafe 的运行时有一层显影（0xAA 加安全检查），ReleaseFast/Small 什么都没有**。契约的履行完全靠写代码的人自觉，0xAA 只是事后验伤的显影液。文档在这件事上罕见地坦白：0xAA 填充 "is only an implementation feature, not a language semantic"——是实现细节，不是语言承诺。依赖它写的代码，换个后端就可能碎。

## 代价，认真地

**它是货真价实的 UB。** 这一点怎么强调都不过分。undefined 不是「安全的垃圾值」，是 C 意义上的未定义行为，只是被 Zig 拉到了明面上、配了一套调试工具。Rust 处理同一件事用的是 `MaybeUninit`——同样的契约，圈在 `unsafe` 块里，读未初始化内存的代码一眼就能被审计出来。Zig 没有 `unsafe` 关键字，`var x: T = undefined` 和 `var x: T = 0` 在语法上同样无辜。自由是真的，裸奔也是真的。

**显影是有开关的。** 0xAA 和非法 tag 检查只在 Debug 和 ReleaseSafe 里存在，而发布构建通常选 ReleaseFast。上一篇的 use-after-free 是这样，这篇的空白支票也是这样：Debug 下精确报错，ReleaseFast 下编译器替你编一个值继续跑。测试覆盖不到的违约路径，上了线就是定时炸弹——Zig 给了你抓它的工具，没替你保证抓得住。这句话上一篇说过，这篇发现它适用范围比我想的更大。

**契约要自己背全。** 「先写后读」说起来一句话，做起来处处是边角：分支要盖全（这次的 `cfg`）、循环边界要覆盖到每一次读（`buf[0..n]` 的 n 不能大于写入量）、struct 可以只初始化一半字段而另一半全裸。零初始化语言里这些都不用想——代价是 bug 藏得更深。Zig 把「这个变量现在有值吗」从语言的默认知变成了程序员的显式责任。写惯了 Java 的人会觉得烦；写惯了 C 的人会发现，自己一直在承担这份责任，只是从没写在明处。

---

写完这篇，系列可以再合龙一次。comptime 找回的原语是求值时机，错误处理找回的是「错误是值」，分配找回的是「分配是调用方的决策」，这一篇找回的是最朴素的最后一块：**初始化是一份写在明处的契约**。四次做的是同一个动作：把别的语言焊死在语言里、藏进运行时里、或者扔进 UB 深渊里的东西，拆下来，摆到源代码可见的地方。零初始化把「还没有值」伪装成 0，C 把它伪装成「碰巧是 0」，Zig 只是在登记簿上留了一行字：此处尚无值，签字画押，风险自负。

签约自由，违约必究——可惜必究的只有 Debug 构建。夜里跑完最后一轮矩阵，四个可执行文件并排躺在 /tmp 里，四份口供谁也没说谎，它们只是各自解读了同一份契约。窗外没有雨，安静得很。该收笔了。
