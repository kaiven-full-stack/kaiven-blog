---
title: 错误是值，清理是另一件事：Zig 的 errdefer
description: 异常机制想一次解决「错误怎么传播」和「资源怎么清理」两件事，Zig 把它拆回两件。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-04
tags: [Zig, 编程语言]
---

错误处理是门类语言都绕不开的题，但多数语言把两件事搅在一起答了：**错误如何传播**，和**错误发生时资源如何清理**。异常机制是最典型的混合体——`throw` 既传播错误，又顺手展开调用栈触发析构函数，一件事管两件事，听起来很划算。

Zig 的立场是拆开。传播交给 error union 类型和 `try`；清理交给 `defer` 家族，尤其是 `errdefer`。这篇文章讲这个拆分为什么成立，以及它如何在没有析构函数的语言里补上资源管理的洞。代码照例全部在 Zig 0.16.0 上验证过。

## 错误是普通的值

先看传播。Zig 里「可能失败的函数」返回一个 error union：`!T` 展开写是 `E!T`，意思是「要么是 T，要么是错误集 E 里的一个错误」。

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

这里有个容易被略过的细节：`catch |err| switch (err)` 的分支是**穷尽检查**的。漏写一个分支，或者写了不属于这个错误集的分支，编译都过不去。我故意写错试试：

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

这就是上一篇 comptime 的同一个逻辑在错误上的投影：错误集是编译期可见的数据，函数签名里写没写某个错误、调用方处没处理它，都是类型系统在管，不是约定在管。

## 错误集是编译期的数据

顺着这个思路展开看错误集本身。它和类型一样，是 comptime 世界的一等公民：

```zig
const FsError = error{ NotFound, PermissionDenied };
const NetError = error{ Timeout, ConnectionRefused };

const LoadError = FsError || NetError;
```

`||` 在这里不是「或」运算，是集合的并——`LoadError` 有四个成员，可以在编译期用 `@typeInfo` 数出来。子函数的错误集自动并进父函数的推断错误集（`!T` 省略错误集时的行为），所以加一个底层函数、多一种错误，上层签名自动跟上，不需要手工同步。

更值得停一下的是错误的**身份**。Zig 的错误不带负载，它全部的信息就是自己是谁：

```zig
std.debug.print("error.Timeout 全局 ID: {d}\n", .{@intFromError(error.Timeout)});
```

每个错误在整个编译单元里有一个全局 ID，`error.Timeout` 在任何模块里都是同一个值。名字即身份——这个设计下文还会回头讨论，它不是偷懒，是取舍。

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

规则一句话：**`errdefer` 注册的清理只在函数以错误收场时执行**。成功时三块内存都交还给调用方，失败时（无论哪一步失败）已分配的全部释放。顺序自动是逆序的，和 `defer` 一致。

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

三步初始化就要写两层嵌套的清理，每加一个资源，前面所有 catch 块都要跟着改。C 项目里那些「goto cleanup」模式本质上就是在手工模拟 `errdefer`。而 `errdefer` 版本里，**清理代码紧贴着分配代码写**，资源在哪儿申请的、失败时怎么还，两行代码说清，不需要读者在脑子里维护一个「目前已分配清单」。

`errdefer` 还能捕获错误值，清理时可以知道自己是在给哪个错误善后：

```zig
errdefer |err| {
    std.debug.print("清理：连接初始化失败（{s}），释放缓冲区\n", .{@errorName(err)});
    alloc.free(conn);
}
```

## 用实验证明它

「errdefer 保证不泄漏」不该是一句口头的承诺，我写了个测试证明它——用 `std.testing.FailingAllocator`（第 N 次分配注定失败）加 `DebugAllocator`（deinit 时检查泄漏）：

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

第一次分配的 16 字节确实被 `errdefer` 还回去了。这个实验的可信度来自它是可复现的——`FailingAllocator` 让「分配失败」从偶然事故变成可以按次数精确注入的测试条件，错误路径从此可以进单元测试。测试错误路径这件事，大多数语言里要么做不到，要么靠 mock 硬凑。

顺带一提，写这个实验时我第一次跑出的结果是 `leak`——但泄漏不来自 `errdefer`，来自我在另一个「成功路径」的测试里忘了释放内存。`DebugAllocator` 的报告精确到分配处的文件和行号，看一眼就知道错在谁身上。检查工具的诚实，比它的严格更难得。

## 错误不带负载：一个值得较真的取舍

回头看前面埋的线索：Zig 的错误不带负载。`error.PermissionDenied` 不能像异常那样携带「是哪个文件、什么权限位」的信息，也不能像 Rust 的 `Box<dyn Error>` 那样挂一段字符串。这是刻意的设计，理由大致有三：

第一，错误成为普通的值，就可以放进数组、存进结构体、在 comptime 里运算——上一节的集合运算全依赖「错误只是一个小整数」这个前提。带负载的错误做不到这些。

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

错误说「发生了什么」，上下文说「发生在哪」，两者分开传递。啰嗦吗？比起异常自带的富信息确实啰嗦。但换来的是：函数签名诚实地列出了所有可能发生的错误，一个不多一个不少——这件事在带异常的语言里，任何工具都做不到。

## error return trace：默认零开销的调用链

还有最后一个部件。Zig 的错误只有一个整数身份，出错时怎么知道它从哪儿来？答案是 error return trace：调试构建下，编译器在每个可能返回错误的函数里记录一条「错误从此处路过」的轨迹，只在错误真的发生时才收集输出。

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

每一层怎么把错误传上来的，一行一帧。而在 ReleaseFast 构建下，这些记录完全消失，`try` 就是纯粹的比较和跳转——你要诊断信息时有，你要性能时它不在。和 `defer`、`errdefer` 一样，这又是一个「把代价放在明处、把选择权交给你」的设计。

---

上一篇讲 comptime 时说过，Zig 的设计审美是往回找原语。错误处理这边找回去的原语更朴素：**错误就是值，清理就是执行一段代码，两者本就是两件事**。异常把它们焊在一起，RAII 用对象生命周期间接地管清理，Go 把传播显式化但清理仍然要靠手写。Zig 的拆分不见得处处更省事——上下文要自己传，测试要自己写——但每一行代码的代价都是摆在明面上的。

对写惯了析构函数的人，这套机制初看像倒退；写上一阵会发现，它逼着你回答一个 RAII 帮你回避掉的问题：这块资源的失败路径，到底归谁管。想清楚了这个问题，泄漏就不再是深夜的悬疑剧。

窗外起了风，该收笔了。
