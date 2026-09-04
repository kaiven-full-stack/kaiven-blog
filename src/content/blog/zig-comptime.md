---
title: comptime：Zig 用一招，替了三门手艺
description: 宏、模板、反射——别的语言用三套系统各自解决的问题，Zig 用一个「编译期执行」全部接住。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-04
tags: [Zig, 编程语言]
---

判断一门语言的设计品味，我有个偷懒的办法：数它的元编程系统有几套。

C++ 有预处理宏、模板、`constexpr`，静态反射还在标准化的路上；Rust 有 `derive`、`macro_rules!`、过程宏，三套各有各的语法；Java 走了注解处理器这条路；连 JavaScript 都有 babel 插件这门「影子语言」。每多一套系统，就多一套心智模型、一套报错方式、一套调试手段。

Zig 的答案简洁得有点过分：一套都没有。它只有 `comptime`——一个标注，意思是「这段代码在编译期执行」。宏、模板、反射这三门手艺，在 Zig 里全是同一个机制的不同侧面。

这篇文章就把这三个侧面挨个摊开看。文中所有代码都在 Zig 0.16.0 上编译运行过——这门语言还没到 1.0，注明版本不是客套，是必要。

## comptime 不是另一门语言

从最小的例子开始：

```zig
const std = @import("std");

fn factorial(n: u32) u32 {
    return switch (n) {
        0, 1 => 1,
        else => n * factorial(n - 1),
    };
}

pub fn main() !void {
    const f5 = comptime factorial(5);
    std.debug.print("5! = {d}\n", .{f5});
}
```

`comptime factorial(5)` 在编译期算出 120，`f5` 成为一个编译期常量。这个例子平淡，但对比一下 C++ 就不平淡了：在模板元编程里写一个编译期阶乘，用的是另一套语法——模板特化、`template <int N>`、`<>::value`，和运行期代码长得毫无血缘关系。`constexpr` 是后来打的补丁，才让两边勉强共用一套写法。

Zig 里只有一个 `factorial`。想让它编译期跑，调用处标 `comptime`；想运行期跑，直接调用。求值时机是调用方的事，不是函数的事。

这是 comptime 的第一层含义：它不是一个特性，只是求值时机的标注。同一门语言，同一个函数，两个世界。

## 泛型：类型是普通的值

看一个泛型容器：

```zig
fn Stack(comptime T: type) type {
    return struct {
        items: []T = &.{},
        len: usize = 0,

        const Self = @This();

        fn push(self: *Self, item: T) void {
            self.items[self.len] = item;
            self.len += 1;
        }

        fn pop(self: *Self) ?T {
            if (self.len == 0) return null;
            self.len -= 1;
            return self.items[self.len];
        }
    };
}
```

关键在签名：`comptime T: type`。在 Zig 里，`type` 本身就是一种类型——类型可以像整数一样被传递、被存放、被函数返回。所以 `Stack` 不是「模板」，它是一个普通函数：吃进一个类型，吐出一个类型。

这里没有 trait，没有 concept，没有任何前置的约束声明。约束在哪？在函数体里。你写了 `a < b`，`T` 就得支持 `<`；不支持，编译错误直接指向那一行。Rust 把约束前置在签名上（`fn min<T: Ord>(...)`），换来的是签名自解释；Zig 让约束藏在用法里，换来的是少一层概念。两种取向各有拥趸，但「泛型不需要新概念」这件事，Zig 是做到位了的。

顺带一提，`Stack(T)` 是惰性求值的——只有真正调用 `Stack(u8)` 时函数体才执行。类型可以递归定义，链表节点引用自身也不是问题。

## 反射：类型信息是一份数据

这是 comptime 最能打的地方。写一个递归打印任意值的函数：

```zig
fn dump(value: anytype, writer: anytype) !void {
    const T = @TypeOf(value);
    switch (@typeInfo(T)) {
        .int => try writer.print("整型 {d}", .{value}),
        .float => try writer.print("浮点 {d:.2}", .{value}),
        .bool => try writer.print("布尔 {}", .{value}),
        .pointer => |ptr| switch (ptr.size) {
            .slice => {
                if (ptr.child == u8) {
                    try writer.print("文本 \"{s}\"", .{value});
                } else {
                    try writer.print("切片，长度 {d}", .{value.len});
                }
            },
            else => try writer.print("指针", .{}),
        },
        .@"struct" => |info| {
            try writer.writeAll("{ ");
            inline for (info.fields, 0..) |f, i| {
                if (i != 0) try writer.writeAll(", ");
                try writer.print("{s} = ", .{f.name});
                try dump(@field(value, f.name), writer);
            }
            try writer.writeAll(" }");
        },
        else => try writer.print("({s})", .{@typeName(T)}),
    }
}

const Article = struct {
    title: []const u8 = "听雨",
    views: u32 = 1024,
    draft: bool = false,
};
```

调用 `dump(@as(Article, .{}), &w)` 输出：

```text
{ title = 文本 "听雨", views = 整型 1024, draft = 布尔 false }
```

拆开看这段代码里发生了什么：

- `@typeInfo(T)` 返回一个 tagged union，把「类型是什么」变成一份编译期可见的数据；
- `inline for` 在字段的元数据上循环，循环变量 `f` 是「字段」这种 comptime 值；
- `@field(value, f.name)` 按名字取值，然后递归调用 `dump` 自己。

整个过程没有字符串拼接，没有代码生成，没有宏。序列化、配置解析、结构体比较、深拷贝——这些在其他语言里要么手写、要么靠反射框架、要么靠派生宏的能力，在这里都是一个普通函数，恰好运行在编译期。

对照一下：Rust 没有运行时反射，`serde` 的 `#[derive(Serialize)]` 本质是「在编译期读 token 流、生成新代码」来补这个洞，代价是错误信息要从生成的代码里往回追。C++ 的静态反射喊了很多年，至今仍在路上。而 Zig 把反射做成了语言内的普通数据——它甚至没有单独的「反射系统」，就是 `@typeInfo` 一个函数。

## 代码生成：普通的控制流

`inline for` 的语义是把循环在编译期展开。因为「类型组成的列表」只在编译期存在，普通 `for` 遍历不了它，`inline for` 可以：

```zig
pub fn main() !void {
    const types = .{ u8, u16, u32, u64 };
    inline for (types) |T| {
        std.debug.print("{s}: {d} 字节\n", .{ @typeName(T), @sizeOf(T) });
    }
}
```

这件事在 C++ 里叫模板特化加 `if constexpr`，在 Lisp 里叫宏。Zig 的版本没有发明任何新语法——就是 `for` 多一个词。而且因为展开发生在语义分析之后，展开体里出了错，行号还是你写的那个行号。

同一个机制顺手解决了「可变参数」：Zig 的元组是 struct 的特例，每个字段的类型都是 comptime 已知的。所以任意个参数的函数不需要发明可变参数语法，`anytype` 吃一个元组就行。

## 把约定写成编译期的契约

Zig 标准库的格式化打印，格式串是编译期校验的。写错类型：

```zig
const n: u32 = 42;
try w.print("{s}\n", .{n}); // {s} 需要 slice，传了整数
```

编译器输出一句话：

```text
error: invalid format string 's' for type 'u32'
```

没有警告被忽略，没有运行时异常，构建直接失败。这个校验逻辑本身就用普通 Zig 代码写成，跑在编译期——不是什么「格式串检查特性」，是 comptime 顺手的收益。

再进一步，`@compileError` 让库作者把「请勿误用」从文档挪进编译器：

```zig
fn Vec2(comptime T: type) type {
    if (@sizeOf(T) > 8) {
        @compileError("Vec2 只接受不大于 8 字节的标量类型，得到 " ++ @typeName(T));
    }
    return struct {
        x: T,
        y: T,
        fn dot(a: @This(), b: @This()) T {
            return a.x * b.x + a.y * b.y;
        }
    };
}
```

`Vec2(u128)` 会在编译期收到那条中文错误信息。类似 `static_assert`，但更活：`@compileError` 可以出现在任何 comptime 数据流的深处——错误信息本身，是编译期代码算出来的字符串。文档会过时，契约不会。

## 测试也可以搬进编译器

```zig
fn Matrix(comptime N: usize) type {
    return struct {
        data: [N * N]f32,

        fn identity() @This() {
            var m = @This(){ .data = undefined };
            @setEvalBranchQuota(10_000);
            for (0..N) |i| m.data[i * N + i] = 1.0;
            return m;
        }
    };
}

test "identity 矩阵在编译期生成" {
    const m = comptime Matrix(4).identity();
    try std.testing.expect(m.data[0] == 1.0);
    try std.testing.expect(m.data[5] == 1.0);
}
```

几个值得停一下的细节。

`@setEvalBranchQuota` 暴露了 comptime 的实现本质：编译器里住着一个 Zig 解释器，comptime 代码是解释执行的，有指令配额（默认 1000 次分支），超了就报错。这个设计至少保证编译期代码会终止——你不会因为一个手滑的死循环把编译器挂死。

而我在这段代码上真实踩过一个坑：最初我断言非对角线元素等于 0，测试失败。因为 `identity()` 只写了对角线，其余是 `undefined`——**comptime 的 undefined 依然是 undefined，不是零**。「编译期执行」管得了求值时机，管不了「未初始化内存」的语义，这两个概念在 Zig 里分得很清，撞上一次就记住了。

收益也实在：能搬进编译期的测试，通过之后不会在二进制里留下任何字节。「零成本抽象」推到极致，连测试都可以零成本——当然，只有纯计算性质的测试能这么搬，涉及 IO 和内存分配行为的，还是得留给运行期。

## 横着看一眼

| 能力 | C++ | Rust | Zig |
| --- | --- | --- | --- |
| 泛型容器 | 模板 | 泛型 + trait bound | 返回 `type` 的普通函数 |
| 派生实现（序列化等） | 手写或外部代码生成 | `derive` 过程宏 | `@typeInfo` + `inline for` |
| 编译期校验 | `static_assert`、`constexpr` | const 泛型、过程宏 | 普通函数 + `@compileError` |
| 编译期执行 | `constexpr` / `consteval` | `const fn` | `comptime` |
| 语法级变换 | 预处理宏 | `macro_rules!`、过程宏 | 刻意不支持 |

最后一行值得单独说。Zig 刻意不支持「发明新语法」级别的宏——你不能像 Lisp 那样定义新的控制流结构。这是立场，不是能力缺失：语法面永远统一，读任何 Zig 代码都不用先问一句「这用了哪个方言」。代价是某些 DSL 确实做不了。Zig 的判断是，当你需要发明新语法时，多数时候是语言本身缺了一个正交的特性——补特性，而不是开侧门。

## 代价，认真地

comptime 不是免费的午餐。

**编译时间。** comptime 是解释执行，比运行期机器码慢一到两个数量级。滥用 comptime 的代码库会让构建明显变慢。配额机制保证编译期代码会终止，但不保证它快。

**调试。** 运行期代码可以打印、可以断点；comptime 代码出了问题，主要靠读编译器输出和 `@compileLog`。解释器级别的调试体验，还远远比不上运行期。

**稳定性。** 语言没到 1.0，这不是一句免责声明。写这篇文章用的 0.16.0 里，标准库的 `Writer` 刚从 `std.io.Writer` 挪到 `std.Io.Writer`，接口整个换过一轮——我的示例代码就真的撞上了这个改动。comptime 这个机制本身已经稳定多年，但你的 comptime 代码所依赖的标准库形状，会跟着版本动。生产环境使用，要有锁定版本的心理准备。

**错误信息的量。** `inline for` 展开后的引用链可以很长。好在每一段都是真实的 Zig 调用栈，读起来仍然是 Zig——比起 C++ 模板实例化的错误，是从「考古」降级成「读日志」。

---

回到设计本身。好的语言设计和好的水墨有一个共同点：不靠笔触的数量，靠每一笔的位置。多数语言往里加系统——宏、模板、反射，一套不够再加一套；Zig 往回找——找到一个原语，让别的特性显得多余。comptime 就是那次回找的结果。宏、模板、反射，三门手艺，一招替了。

这一招是否真的足够，要等这门语言走到 1.0 之后由生态来回答。但作为一个观察者，能看到「做减法」被当作设计纲领认真执行，本身就是件稀罕的事。

雨停了，收笔。
