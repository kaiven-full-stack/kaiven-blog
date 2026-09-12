---
title: 测试是语言，不是框架：Zig 的 test 块与它的三件工具
description: 不装测试库，不写配置文件，test 块就是语法，std.testing 就是标准库。从断言家族、泄漏即测试失败，到 FailingAllocator 注入故障与 Smith 模糊测试，验证这件事在 Zig 里是一等公民。输出均来自 Zig 0.16.0 实跑。
pubDate: 2026-09-09
category: zig
tags: [Zig, 编程语言]
---

从 pytest 或 JUnit 过来的人，写完第一个 Zig 函数后会开始找：测试框架装哪个？`package.json` 里加什么依赖？配置文件放哪、命名什么？

全都找不到。因为测试不是框架，是语言本身：

```zig
const std = @import("std");

fn add(a: i32, b: i32) i32 {
    return a + b;
}

test "加法" {
    try std.testing.expectEqual(@as(i32, 5), add(2, 3));
}
```

```console
$ zig test t1.zig
1/1 t1.test.加法...OK
All 1 tests passed.
```

没有依赖可装，没有 fixture 可配，没有 runner 可选。`test` 是关键字，测试块就是语法；`std.testing` 是标准库，断言就是普通函数。项目里则用工具链那篇讲过的 `zig build test`，`zig init` 生成的 build.zig 自带 test step，把模块里的测试块编成测试二进制跑一遍。

这一篇把这些拆开看：断言家族长什么样，测试里的内存怎么查，故障怎么注入，以及一个容易被低估的能力，模糊测试。实验都以 Zig 0.16.0 为准。

## 断言：普通函数，普通错误

最常用的两个。`expect` 收布尔：

```zig
test "期望 true" {
    try std.testing.expect(2 + 2 == 4);
}
```

失败时它返回 `error.TestUnexpectedResult`。注意，不是抛异常，不是宏展开，就是一次普通的错误值。`try` 把它传播出去，测试框架接住，记一次失败。错误处理那篇讲的错误传播机制，测试里原样使用。

`expectEqual` 收期望值和实际值，失败时的输出值得看一眼：

```zig
test "期望 5 得到 6" {
    try std.testing.expectEqual(@as(i32, 5), add(2, 4));
}
```

```text
1/1 t2.test.期望 5 得到 6...expected 5, found 6
FAIL (TestExpectedEqual)
```

期望在前，实际在后，类型参与比较，这一点有个刚出锅的实证。把期望值写成超出实际类型范围的数：

```zig
try std.testing.expectEqual(256, @as(u8, 1));
```

这不是运行期失败，是编译错误：

```text
error: type 'u8' cannot represent integer value '256'
```

期望值必须在实际类型的世界里说得通，否则比较本身就没有意义。Zig 连这个都放到了编译期。而两个指针比较时，`expectEqual` 比的是地址，报错会把两个地址打出来（`expected u32@7ffd8d6ad000, found u32@7ffd8d6ad004`），想比内容请用 `expectEqualBytes` 一族。

一族专用的断言各管一摊：

```zig
try std.testing.expectEqualStrings("听雨", s);          // 字符串按内容
try std.testing.expectEqualSlices(u8, &a, &b);          // 切片按内容
try std.testing.expectError(error.NotFound, fetch("")); // 错误值
try std.testing.expectApproxEqAbs(@as(f64, 3.14), x, 1e-6); // 浮点带容差
```

字符串那篇讲过的「比较语义要显式」在这里兑现：每种值都有对应的断言，没有万能的 `assertEquals` 在背后猜你想要什么。

跑不过的测试可以显式跳过，跑一部分可以过滤：

```zig
test "跳过" {
    if (true) return error.SkipZigTest;
}
```

```text
1 passed; 1 skipped; 0 failed.
```

```console
$ zig test t10.zig --test-filter 常规
```

## 泄漏是测试失败，不是事后报告

测试代码里最重要的一个名字是 `std.testing.allocator`。它是带检查的分配器，每个测试结束后核对一遍账目，漏了内存，这个测试就判失败：

```zig
test "故意泄漏" {
    var list: std.ArrayList(u8) = .empty;
    try list.appendSlice(std.testing.allocator, "听雨");
    // 忘了 deinit
}
```

```text
All 2 tests passed.
1 errors were logged.
1 tests leaked memory.
error: the following test command failed with exit code 1
```

值得细看的是这个输出：两个测试都「passed」，但有一个「leaked memory」，泄漏独立于断言记账。报告还带完整的分配栈，行号指向 `std.ArrayList` 内部的 `ensureTotalCapacityPrecise`，顺着引用链就能找到你代码里的分配现场。

这就是对象模型那篇 `init`/`deinit` 惯例的另一半：那篇演示了 `DebugAllocator` 在 `main` 里怎么事后报告，而测试里用 `std.testing.allocator`，检查变成自动的、逐测试的。写一个类型，测试里忘了 `deinit`，CI 立刻红，不用等「也许哪天内存涨」。

分配器那篇讲过 `DebugAllocator` 的原理，这里不重讲；只需要记住分工：`std.testing.allocator` 管测试，`DebugAllocator` 管生产代码的调试构建。

## 故障注入：FailingAllocator

错误处理那篇埋过一条线：`errdefer` 的失败路径「不该是口头的承诺」，当时用测试证明了它。这次把那件工具讲全：`FailingAllocator`，一个把「第 N 次分配注定失败」做成参数的分配器：

```zig
fn build(allocator: std.mem.Allocator) ![]u8 {
    const a = try allocator.alloc(u8, 10);
    errdefer allocator.free(a);
    const b = try allocator.alloc(u8, 10);
    errdefer allocator.free(b);
    const merged = try allocator.alloc(u8, 20);
    errdefer allocator.free(merged);
    @memcpy(merged[0..10], a);
    @memcpy(merged[10..], b);
    allocator.free(a);
    allocator.free(b);
    return merged;
}
```

三次分配、三个 `errdefer`。要验证「第三次分配失败时前两次的清理真的执行了」，不用制造真实的内存压力：

```zig
test "第 3 次分配失败时也不漏" {
    var failing = std.testing.FailingAllocator.init(
        std.testing.allocator,
        .{ .fail_index = 2 },
    );
    const result = build(failing.allocator());
    try std.testing.expectError(error.OutOfMemory, result);
}
```

`fail_index = 2` 让第 3 次分配（索引从 0 数）返回 `OutOfMemory`。测试通过的前提有两个：函数正确返回了错误（`expectError` 验证），且失败路径上的内存全部还清，后者由外层的 `std.testing.allocator` 在测试结束时核对。

故障注入在别的语言里常要 mock 框架或依赖注入容器；在 Zig 里它是一个分配器参数。还是那套哲学：分配是调用方传入的能力，换一个实现就换一种行为。失败路径从祈祷变成逐条测试。

## 测试跟着安全模式走

安全模式那篇的核心结论是：安全检查是策略，随构建模式开关。在测试这里有一个直接推论：同一个测试，不同模式下可能行为不同。

运行期越界访问，Debug 下测试直接崩溃，报告精确到行：

```text
thread panic: index out of bounds: index 6, len 3
t16.zig:13:31: in test.运行期越界
```

同一测试换 `-OReleaseFast`，护栏拆了，不崩溃了，但这个例子读到了 `undefined` 的值，`expect` 判 false，测试以另一种方式失败。也有更阴的情况：ReleaseFast 下非法访问碰巧没影响断言结果，测试就「通过」了。

所以该在什么模式下跑测试，是个真实的决策：Debug 跑全部测试抓安全违约，发布前用 `-Doptimize=ReleaseFast` 再跑一遍 `zig build test` 验证发布形态的行为。这不是 Zig 特有的焦虑，C++ 的 UB 在不同优化级别下同样变脸；但 Zig 把模式差异写在明面上（工具链那篇的 `-Doptimize`），测试跟着走就是了。

## 模糊测试：性质写一次，输入来一千个

前三节是常见语言的测试都有的东西，这一节是 0.16.0 的新故事，也是 `zig init` 模板里直接送你的东西：

```zig
test "fuzz example" {
    try std.testing.fuzz({}, testOne, .{});
}

fn testOne(context: void, smith: *std.testing.Smith) !void {
    _ = context;
    const gpa = std.testing.allocator;
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(gpa);
    while (!smith.eos()) switch (smith.value(enum { add_data, dup_data })) {
        .add_data => {
            const slice = try list.addManyAsSlice(gpa, smith.value(u4));
            smith.bytes(slice);
        },
        .dup_data => { ... },
    };
}
```

`std.testing.fuzz` 把你的测试函数交给模糊测试引擎。引擎给你的不是随机字节流，而是一个 `Smith`，一个「值生成器」：`smith.value(enum {...})` 生成一个枚举值，`smith.value(u4)` 生成一个半字节，`smith.slice(&buf)` 往缓冲区里填一段字节并返回长度。你用它描述「输入长什么样」，引擎负责构造各种刁钻的输入组合。

与 pytest 的 `@pytest.mark.parametrize` 或 Rust 的 `proptest` 对照一下定位：`parametrize` 是你枚举输入，`proptest` 是你声明输入规格它随机采样，`std.testing.fuzz` 是你声明输入规格、引擎做覆盖引导的搜索，「覆盖引导」这几个字的分量后面会说到。

适合模糊测试的是性质：不变量在任意输入下成立。比如 trim 的幂等性，trim 一次和 trim 两次结果必须相同，无论输入是什么：

```zig
test "trim 的性质：幂等" {
    try std.testing.fuzz({}, testIdempotent, .{});
}

fn testIdempotent(context: void, smith: *std.testing.Smith) !void {
    _ = context;
    var buf: [64]u8 = undefined;
    const len = smith.slice(&buf);
    const input = buf[0..len];
    const once = normalize(input);
    const twice = normalize(once);
    if (!std.mem.eql(u8, once, twice)) return error.TestUnexpectedResult;
}
```

```text
All 1 tests passed.
1 fuzz tests found.
```

注意输出：普通模式下它只跑一遍（当作普通测试），尾部报告「1 fuzz tests found」。真正的模糊测试要加 `--fuzz`：build 系统接管，起 web 界面观察进度，语料库进缓存，下次增量继续。所谓覆盖引导，就是引擎盯着哪些输入走到了代码的哪些分支，优先生成能探索新分支的输入。不是盲目的随机，是带着地图的搜索。

要如实交代一件事：我这台机器上的 0.16.0 发行版，`--fuzz` 模式在重建测试二进制时触发了标准库自身的类型不匹配（`test_runner.zig` 里 `debug.StackTrace` 与 `builtin.StackTrace` 合不上），普通模式一切正常。这类「新特性在特定版本翻车」的事故本身就是 1.0 之前生态的日常，哪篇文章都得注明版本，这里是活例子。写这篇文章时最新版可能已修，但教训稳定：模糊测试是真实可用的能力，也是真实的移动靶。

还有一条 `zig init` 模板里明写的提示：`testOne` 的 `while (!smith.eos())` 循环构造的数据，模板故意留了一个会让 fuzz 找到的 bug，注释原文写着「试试 `--fuzz` 能不能让它失败」。教程在教工具的同时教你被工具咬一口，这个品味我喜欢。

## comptime 测试，一句话回链

测试块里可以 `comptime` 执行断言，通过后零字节进二进制，这条 comptime 那篇讲透了（包括 `@setEvalBranchQuota` 配额和 comptime undefined 依然是 undefined 的陷阱），不重讲。只补一个衔接：纯计算的属性测试适合往上搬一层，做成 `comptime { if (不满足) @compileError(...); }`，违约直接变成编译失败。

## 跨文件：测试跟着模块走

测试块写在源文件里，紧挨着被测代码，`zig test` 单文件就能跑。多文件项目里，别的模块的测试不会自动执行，测试发现靠引用，不靠扫描。惯用的做法是在测试入口把依赖模块的声明都引用一遍：

```zig
const std = @import("std");
const lib = @import("lib.zig");

test "跨文件调用" {
    try std.testing.expectError(error.Empty, lib.parse(""));
}

comptime {
    std.testing.refAllDecls(lib);
}
```

```text
2/2 lib.test.库内测试...OK
All 2 tests passed.
```

`refAllDecls` 引用了 `lib` 的全部公开声明，`lib` 里的 `test` 块因此被纳入编译。大型项目里通常由 build.zig 把各模块的测试统一组织，工具链那篇的 test step 就是干这个的。测试跟着模块走、入口显式声明，还是那个立场：没有隐式的全局魔法，文件的边界就是模块的边界（对象模型那篇的 `pub` 边界，在这里又一次生效）。

## 这套测试设施的代价

没有 mock 生态，测试替身全靠手写。故障注入有 `FailingAllocator` 这种利器，但「模拟一个还没写好的依赖」「替换网络层」这类需求，Zig 没有现成的 mock 框架。惯用做法是把依赖做成参数（分配器就是范本），测试时传一个手写的假实现，`anytype` 让这件事不难，但样板代码得自己写。

测试代码同样面对安全模式的两面性。Debug 下测试帮你抓非法行为，ReleaseFast 下同样的测试可能静默变绿。多模式跑测试是纪律，不是自动保障。安全模式那篇的结论在测试上原样成立。

模糊测试的范式转换是真实成本。写「输入-期望」的例子测试人人会；把期望改写成「任意输入下成立的不变量」是另一种思维。不是所有测试都值得这么写。解析器、序列化、压缩这类「输入空间巨大、性质明确」的代码是主战场，业务逻辑多数时候例子测试就够。

标准库断言没有快照、参数化这些高级功能。快照测试、数据驱动测试、属性生成器，别的生态里框架提供的东西，这里要么手写循环，要么引第三方。语言内置的测试赢在零配置与无处不在，功能广度上确实比不过成熟的框架生态。

`--fuzz` 还是移动靶。上面那个版本事故说明：模糊测试基础设施还在快速演化，接口和行为可能随版本变。用它，但把 fuzz 测试和普通测试的边界划清楚：前者是探索，后者是承诺。

---

回头数一遍这一篇收的线：断言用的是错误处理篇的 `try` 和错误值；`std.testing.allocator` 是分配器篇 `DebugAllocator` 在测试里的化身；`FailingAllocator` 兑现了 errdefer 那条「失败路径要测过」的承诺；安全模式篇的模式差异决定了测试的运行策略；工具链篇的 `zig build test` 是这一切的入口。

测试是这些机制的汇流处，而它自己几乎没有新机制：没有框架要装，没有 DSL 要学，有的只是「test 是关键字，断言是函数，分配器可替换，构建模式影响一切」这四件已经在这系列里出现过的事。

别的语言里，测试框架是生态的选择题；Zig 把它做成了语言的填空题。写完这一篇我发现，这大概是「没有 string」「没有 install」「没有 class」之外最讨人喜欢的一次「没有」：语言自己把测试管了，框架就不需要了。
