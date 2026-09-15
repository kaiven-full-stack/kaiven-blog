---
title: 错误是值，清理是另一件事：Zig 的 errdefer
description: 异常机制想一次解决「错误怎么传播」和「资源怎么清理」两件事，Zig 把它拆回两件。示例出自 Zig 0.16.0 实测。
pubDate: 2026-09-04
category: zig
tags: [Zig, 编程语言]
---

错误处理是每门语言都要解的题，但多数语言把两件事搅在一起答了：错误如何传播，和错误发生时资源如何清理。异常机制是最典型的混合体，`throw` 既传播错误，又顺手展开调用栈触发析构函数，一件事管两件事，听起来很划算。

Zig 的立场是分开。传播交给 error union 类型和 `try`；清理交给 `defer` 家族，尤其是 `errdefer`。这篇讲这个拆分为什么成立，以及它如何在没有析构函数的语言里补上资源管理的洞。代码全部在 Zig 0.16.0 上验证过。

## 错误是普通的值

从传播说起。Zig 里「可能失败的函数」返回一个 error union：`!T` 展开写是 `E!T`，意思是「要么是 T，要么是错误集 E 里的一个错误」。

```zig
const std = @import("std");

fn fetchConfig(path: []const u8) error{ NotFound, PermissionDenied }![]const u8 {
    if (std.mem.eql(u8, path, "secret")) return error.PermissionDenied;
    if (path.len == 0) return error.NotFound;
    return "title: 听雨";
}

pub fn main() !void {
    const config = try fetchConfig("blog.conf");

    const fallback = fetchConfig("") catch "title: 未命名";

    const config2 = fetchConfig("secret") catch |err| switch (err) {
        error.PermissionDenied => "无权读取",
        error.NotFound => "文件不存在",
    };

    std.debug.print("{s} | {s} | {s}\n", .{ config, fallback, config2 });
}
```

三行展示了三种处理方式：`try` 把错误继续往上抛；`catch` 给默认值；`catch |err|` 捕获后按错误类型分支。`try` 只是 `catch |err| return err` 的语法糖，没有任何隐藏机制。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="error union 解剖：签名 error{NotFound,PermissionDenied}![]const u8 表示要么成功给出切片值，要么失败给出错误集里的一个错误；三种处理是 try 继续上抛、catch 提供默认值、catch 捕获后穷尽 switch 分支" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ehA1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="120" y="14" width="420" height="40" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="31" text-anchor="middle" font-size="9.5" fill="#2b2a26">error{ NotFound, PermissionDenied }![]const u8</text>
<text class="ts" x="330" y="47" text-anchor="middle" font-size="9" fill="#6b675e">error union：二选一的返回</text>
<line class="fl" x1="250" y1="54" x2="180" y2="80" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ehA1)"/>
<line class="fl" x1="410" y1="54" x2="480" y2="80" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ehA1)"/>
<rect class="bx-q" x="50" y="84" width="260" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="180" y="101" text-anchor="middle" font-size="9.5" fill="#2b2a26">成功：[]const u8 的值</text>
<text class="ts" x="180" y="117" text-anchor="middle" font-size="9" fill="#6b675e">"title: 听雨"</text>
<rect class="bx-sick" x="350" y="84" width="260" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="480" y="101" text-anchor="middle" font-size="9.5" fill="#b03a2e">失败：错误集里的一个成员</text>
<text class="ts" x="480" y="117" text-anchor="middle" font-size="9" fill="#6b675e">一个指针大小的整数，不带负载</text>
<rect class="bx-q" x="20" y="148" width="196" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="118" y="166" text-anchor="middle" font-size="9.5" fill="#2b2a26">try</text>
<text class="ts" x="118" y="182" text-anchor="middle" font-size="8.5" fill="#6b675e">继续上抛 = catch |err| return err</text>
<rect class="bx-q" x="232" y="148" width="196" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="330" y="166" text-anchor="middle" font-size="9.5" fill="#2b2a26">catch 默认值</text>
<text class="ts" x="330" y="182" text-anchor="middle" font-size="8.5" fill="#6b675e">就地兜底，函数不再失败</text>
<rect class="bx-q" x="444" y="148" width="196" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="542" y="166" text-anchor="middle" font-size="9.5" fill="#2b2a26">catch |err| switch</text>
<text class="ts" x="542" y="182" text-anchor="middle" font-size="8.5" fill="#6b675e">按错误分支 · 穷尽检查</text>
</svg>
</figure>

这里有个容易被略过的细节：`catch |err| switch (err)` 的分支是穷尽检查的。漏写一个分支，或者写了不属于这个错误集的分支，编译都过不去。我故意写错试试：

```zig
const n = read() catch |err| switch (err) {
    error.DiskCorrupted => 0,
};
```

编译器立刻指出两处问题：

```text
error: expected type 'error{EndOfFile}', found 'error{DiskCorrupted}'
note: 'error.DiskCorrupted' not a member of destination error set
```

上一篇 comptime 的逻辑在这里重现：错误集是编译期可见的数据，签名里写没写某个错误、调用方处没处理它，都由类型系统把守，不靠约定。

## 错误集是编译期的数据

顺着这个思路看错误集本身。它和类型一样，是 comptime 世界的一等公民：

```zig
const FsError = error{ NotFound, PermissionDenied };
const NetError = error{ Timeout, ConnectionRefused };

const LoadError = FsError || NetError;
```

`||` 在这里不是「或」运算，是集合的并：`LoadError` 有四个成员，可以在编译期用 `@typeInfo` 数出来。子函数的错误集自动并进父函数的推断错误集（`!T` 省略错误集时的行为），所以加一个底层函数、多一种错误，上层签名自动跟上，不需要手工同步。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 176" role="img" aria-label="错误集的并集运算：FsError 含 NotFound 与 PermissionDenied，NetError 含 Timeout 与 ConnectionRefused，双竖线把两个集合合并成 LoadError，共四个成员，编译期可以用 typeInfo 数出来" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ehA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="20" y="20" width="220" height="68" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="130" y="40" text-anchor="middle" font-size="10" fill="#2b2a26">FsError</text>
<text class="ts" x="130" y="60" text-anchor="middle" font-size="9" fill="#6b675e">NotFound</text>
<text class="ts" x="130" y="76" text-anchor="middle" font-size="9" fill="#6b675e">PermissionDenied</text>
<rect class="bx-q" x="420" y="20" width="220" height="68" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="530" y="40" text-anchor="middle" font-size="10" fill="#2b2a26">NetError</text>
<text class="ts" x="530" y="60" text-anchor="middle" font-size="9" fill="#6b675e">Timeout</text>
<text class="ts" x="530" y="76" text-anchor="middle" font-size="9" fill="#6b675e">ConnectionRefused</text>
<text class="tc" x="330" y="52" text-anchor="middle" font-size="16" fill="#b03a2e">||</text>
<text class="ts" x="330" y="72" text-anchor="middle" font-size="9" fill="#6b675e">集合并，不是布尔或</text>
<line class="fl" x1="130" y1="88" x2="270" y2="114" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ehA3)"/>
<line class="fl" x1="530" y1="88" x2="390" y2="114" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ehA3)"/>
<rect class="bx" x="180" y="118" width="300" height="44" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="136" text-anchor="middle" font-size="10" fill="#2b2a26">LoadError · 四个成员</text>
<text class="ts" x="330" y="153" text-anchor="middle" font-size="9" fill="#6b675e">编译期数据：可数、可并、可穷尽检查</text>
</svg>
</figure>

更值得停一下的是错误的身份。Zig 的错误不带负载，它全部的信息就是自己是谁：

```zig
std.debug.print("error.Timeout 全局 ID: {d}\n", .{@intFromError(error.Timeout)});
```

每个错误在整个编译单元里有一个全局 ID，`error.Timeout` 在任何模块里都是同一个值。名字即身份。这个设计下文还会回头讨论，它不是偷懒，是取舍。

## errdefer：错误路径上的清理

现在到第二件事：清理。这是 Zig 错误处理真正的深水区。

没有析构函数的语言里，构造到一半失败怎么办？看一个惯用的初始化函数：

```zig
const std = @import("std");
const Allocator = std.mem.Allocator;

const Reader = struct {
    index: []u8,
    body: []u8,
    notes: []u8,

    fn init(alloc: Allocator) !Reader {
        const index = try alloc.alloc(u8, 16);
        errdefer alloc.free(index);

        const body = try alloc.alloc(u8, 64);
        errdefer alloc.free(body);

        const notes = try alloc.alloc(u8, 8);
        errdefer alloc.free(notes);

        return .{ .index = index, .body = body, .notes = notes };
    }
};
```

规则一句话：`errdefer` 注册的清理只在函数以错误收场时执行。成功时三块内存都交还给调用方，失败时（无论哪一步失败）已分配的全部释放。顺序自动是逆序的，和 `defer` 一致。

这个模式解决了 C 语言的老大难。同样逻辑不用 `errdefer` 手写一遍：

```zig
fn initManual(alloc: Allocator) !Reader {
    const index = try alloc.alloc(u8, 16);

    const body = alloc.alloc(u8, 64) catch |err| {
        alloc.free(index);
        return err;
    };

    const notes = alloc.alloc(u8, 8) catch |err| {
        alloc.free(body);
        alloc.free(index);
        return err;
    };

    return .{ .index = index, .body = body, .notes = notes };
}
```

三步初始化就要写两层嵌套的清理，每加一个资源，前面所有 catch 块都要跟着改。C 项目里那些「goto cleanup」模式本质上就是在手工模拟 `errdefer`。而 `errdefer` 版本里，清理代码紧贴着分配代码写，资源在哪儿申请的、失败时怎么还，两行代码说清，读者不需要在脑子里维护一份「目前已分配清单」。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 306" role="img" aria-label="Reader.init 的 errdefer 登记与两种结局：三次分配各自紧跟一条 errdefer 清理登记；全部成功时直接返回结构体，一条 errdefer 都不执行；第三步注入 OutOfMemory 失败时，已登记的清理按逆序执行，free body 再 free index，错误返回" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ehA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">Reader.init 内部：清理紧贴着分配登记</text>
<rect class="bx-q" x="20" y="32" width="310" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="34" y="53" font-size="9.5" fill="#2b2a26">① index = try alloc.alloc(u8, 16)</text>
<rect class="bx-gone" x="40" y="70" width="290" height="28" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="54" y="89" font-size="9" fill="#6b675e">errdefer alloc.free(index)</text>
<rect class="bx-q" x="20" y="106" width="310" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="34" y="127" font-size="9.5" fill="#2b2a26">② body = try alloc.alloc(u8, 64)</text>
<rect class="bx-gone" x="40" y="144" width="290" height="28" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="54" y="163" font-size="9" fill="#6b675e">errdefer alloc.free(body)</text>
<rect class="bx-q" x="20" y="180" width="310" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="34" y="201" font-size="9.5" fill="#2b2a26">③ notes = try alloc.alloc(u8, 8)</text>
<rect class="bx-gone" x="40" y="218" width="290" height="28" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="54" y="237" font-size="9" fill="#6b675e">errdefer alloc.free(notes)</text>
<line class="fl" x1="330" y1="120" x2="376" y2="86" stroke="#6b675e" stroke-width="1.3" marker-end="url(#ehA2)"/>
<text class="ts" x="346" y="88" font-size="9" fill="#6b675e">全部成功</text>
<rect class="bx-q" x="380" y="40" width="260" height="76" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="510" y="62" text-anchor="middle" font-size="10" fill="#2b2a26">return .{ index, body, notes }</text>
<text class="ts" x="510" y="82" text-anchor="middle" font-size="9" fill="#6b675e">三块内存整体交给调用方</text>
<text class="ts" x="510" y="100" text-anchor="middle" font-size="9" fill="#6b675e">errdefer 一条都不执行</text>
<line class="flc" x1="330" y1="196" x2="376" y2="216" stroke="#b03a2e" stroke-width="1.3" marker-end="url(#ehA2)"/>
<text class="tc" x="340" y="222" font-size="9" fill="#b03a2e">③ 处失败</text>
<rect class="bx-sick" x="380" y="160" width="260" height="100" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="ts" x="510" y="182" text-anchor="middle" font-size="10" fill="#b03a2e">OutOfMemory 向上传</text>
<text class="ts" x="510" y="202" text-anchor="middle" font-size="9" fill="#6b675e">逆序执行已登记的清理：</text>
<text class="ts" x="510" y="220" text-anchor="middle" font-size="9" fill="#6b675e">free(body) → free(index)</text>
<text class="ts" x="510" y="242" text-anchor="middle" font-size="9" fill="#6b675e">③ 自己没分配成，无须清理</text>
<text class="ts" x="20" y="290" font-size="10" fill="#6b675e">登记顺序就是逆序保证：新增资源只加两行，旧代码一行不动</text>
</svg>
</figure>

`errdefer` 还能捕获错误值，清理时可以知道自己是在给哪个错误善后：

```zig
errdefer |err| {
    std.debug.print("清理：连接初始化失败（{s}），释放缓冲区\n", .{@errorName(err)});
    alloc.free(conn);
}
```

## 用实验证明它

「errdefer 保证不泄漏」不该是一句口头的承诺，我写了个测试证明它，用 `std.testing.FailingAllocator`（第 N 次分配注定失败）加 `DebugAllocator`（deinit 时检查泄漏）：

```zig
test "第二次分配失败时，已分配的资源全部释放" {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer {
        const status = gpa.deinit();
        std.debug.print("泄漏检查: {s}\n", .{@tagName(status)});
    }

    var failing = std.testing.FailingAllocator.init(gpa.allocator(), .{ .fail_index = 1 });
    const result = Reader.init(failing.allocator());
    try std.testing.expectError(error.OutOfMemory, result);
}
```

第二次分配被注入 `OutOfMemory`，`init` 失败返回，`DebugAllocator` 在 defer 里报告：

```text
泄漏检查: ok
```

第一次分配的 16 字节确实被 `errdefer` 还回去了。这个实验的可信度来自可复现：`FailingAllocator` 让「分配失败」从偶然事故变成可以按次数精确注入的测试条件。测试错误路径这件事，大多数语言里要么做不到，要么靠 mock 硬凑。

顺带一提，写这个实验时我第一次跑出的结果是 `leak`，但泄漏不来自 `errdefer`，来自我在另一个「成功路径」的测试里忘了释放内存。`DebugAllocator` 的报告精确到分配处的文件和行号，看一眼就知道错在谁身上。

## 错误不带负载：一个值得较真的取舍

回头看前面埋的线索：Zig 的错误不带负载。`error.PermissionDenied` 不能像异常那样携带「是哪个文件、什么权限位」，也不能像 Rust 的 `Box<dyn Error>` 那样挂一段字符串。这是刻意的设计，理由大致有三。

第一，错误成为普通的值，就可以放进数组、存进结构体、在 comptime 里运算。上一节的集合运算全依赖「错误只是一个小整数」这个前提，带负载的错误做不到这些。

第二，错误集是函数签名的一部分。穷尽检查、自动并集，都建立在「错误身份在编译期完全确定」之上；一旦错误可以携带运行时数据，签名能承诺的就只剩「一个错误」这个空壳。

第三，性能。不带负载的错误是一个指针大小的值，`try` 展开后就是一次比较和跳转，没有栈展开，没有堆分配。错误路径和成功路径一样可以放进最热的数据结构操作里。

代价也真实存在：需要上下文的场景要自己动手。惯用的补偿模式是把状态放进调用方持有的结构体：

```zig
const Parser = struct {
    ctx: ParseContext = .{}, // 记录 line / column
    last_error: ?anyerror = null,

    fn parse(p: *Parser, text: []const u8) !void { ... }
};

const result = p.parse("title: 听雨");
if (result) |_| {} else |err| {
    std.debug.print("解析失败: {s}，位于 {d}:{d}\n", .{ @errorName(err), p.ctx.line, p.ctx.column });
}
```

```text
解析失败: UnexpectedToken，位于 3:17
```

错误说「发生了什么」，上下文说「发生在哪」，两者分开传递。啰嗦吗？比起异常自带的富信息确实啰嗦。但换来的是：函数签名诚实地列出了所有可能发生的错误，一个不多一个不少。这件事在带异常的语言里，任何工具都做不到。

## error return trace：默认零开销的调用链

还有最后一个部件：error return trace。Zig 的错误只有一个整数身份，调试构建下，编译器在每个可能返回错误的函数里记录一条「错误从此处路过」的轨迹，只在错误真的发生时才收集输出。

```zig
fn parseHeader(line: []const u8) !u32 {
    if (line.len == 0) return error.EmptyHeader;
    return 42;
}

fn parseRequest(buf: []const u8) !u32 {
    return parseHeader(buf[0..0]);
}

fn handleConnection() !u32 {
    return parseRequest("");
}
```

三层调用，`main` 里捕获后重新抛出，程序结束时的输出：

```text
连接失败: EmptyHeader
error: EmptyHeader
trace.zig:4 in parseHeader — return error.EmptyHeader
trace.zig:9 in parseRequest — return parseHeader(...)
trace.zig:13 in handleConnection — return parseRequest("")
trace.zig:19 in main — return err
```

每一层怎么把错误传上来的，一行一帧。而在 ReleaseFast 构建下，这些记录完全消失，`try` 就是纯粹的比较和跳转。诊断信息的成本摆在台面上，要不要它由构建模式决定，和 `defer`、`errdefer` 是同一种思路。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 246" role="img" aria-label="error return trace：main 调 handleConnection 调 parseRequest 调 parseHeader，EmptyHeader 沿原路逐层上抛，Debug 构建在每层留下一条路过记录，错误真正发生时才收集输出；ReleaseFast 下记录全部消失，try 只剩比较和跳转" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ehA4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="ehA4c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<rect class="bx-q" x="40" y="20" width="220" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="150" y="42" text-anchor="middle" font-size="10" fill="#2b2a26">main</text>
<rect class="bx-q" x="40" y="70" width="220" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="150" y="92" text-anchor="middle" font-size="10" fill="#2b2a26">handleConnection</text>
<rect class="bx-q" x="40" y="120" width="220" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="150" y="142" text-anchor="middle" font-size="10" fill="#2b2a26">parseRequest</text>
<rect class="bx-sick" x="40" y="170" width="220" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="ts" x="150" y="192" text-anchor="middle" font-size="10" fill="#b03a2e">parseHeader：return error.EmptyHeader</text>
<line class="fl" x1="90" y1="54" x2="90" y2="66" stroke="#6b675e" stroke-width="1.1" marker-end="url(#ehA4)"/>
<line class="fl" x1="90" y1="104" x2="90" y2="116" stroke="#6b675e" stroke-width="1.1" marker-end="url(#ehA4)"/>
<line class="fl" x1="90" y1="154" x2="90" y2="166" stroke="#6b675e" stroke-width="1.1" marker-end="url(#ehA4)"/>
<line class="flc" x1="230" y1="170" x2="230" y2="58" stroke="#b03a2e" stroke-width="1.5" marker-end="url(#ehA4c)"/>
<text class="tc" x="240" y="118" font-size="9.5" fill="#b03a2e">错误原路上抛</text>
<text class="ts" x="240" y="134" font-size="9" fill="#6b675e">每层留一条「路过」记录</text>
<rect class="bx-q" x="380" y="40" width="260" height="70" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="510" y="62" text-anchor="middle" font-size="10" fill="#2b2a26">Debug / ReleaseSafe</text>
<text class="ts" x="510" y="82" text-anchor="middle" font-size="9" fill="#6b675e">trace 记录在案，错误真发生时才输出</text>
<text class="ts" x="510" y="99" text-anchor="middle" font-size="9" fill="#6b675e">一行一帧：trace.zig:4 → :9 → :13 → :19</text>
<rect class="bx-gone" x="380" y="130" width="260" height="70" rx="5" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="510" y="152" text-anchor="middle" font-size="10" fill="#6b675e">ReleaseFast / ReleaseSmall</text>
<text class="ts" x="510" y="172" text-anchor="middle" font-size="9" fill="#6b675e">记录全部消失</text>
<text class="ts" x="510" y="189" text-anchor="middle" font-size="9" fill="#6b675e">try = 一次比较 + 一次跳转</text>
<text class="ts" x="40" y="232" font-size="9.5" fill="#6b675e">成功路径上，trace 一个字节的成本都不产生</text>
</svg>
</figure>

---

上一篇讲 comptime 时说过，Zig 的设计思路是往回找原语。错误处理这边找回去的原语更朴素：错误就是值，清理就是执行一段代码，两者本就是两件事。异常把它们绑在一起，RAII 用对象生命周期间接地管清理，Go 把传播显式化但清理仍然要靠手写。Zig 的分开不见得处处更省事，上下文要自己传，测试要自己写，但每行代码的成本在源码里看得见。

对写惯了析构函数的人，这套机制初看像倒退；写上一阵会发现，它逼着你回答一个 RAII 帮你回避掉的问题：这块资源的失败路径，到底归谁管。想清楚了这个问题，泄漏发生时就有处可查。

下一篇讲 Allocator。`errdefer` 管的是「失败时怎么还」，下一问自然是「平时从哪儿拿」，Zig 把这件事也做成了一个参数。
