---
title: comptime：Zig 的元编程只有一个机制
description: 别的语言用宏、模板、反射三套系统分头解决的问题，Zig 交给同一个机制：编译期执行。文中示例以 Zig 0.16.0 为准。
pubDate: 2026-09-04
category: zig
tags: [Zig, 编程语言]
---

判断一门语言的设计品味，我有个偷懒的办法：数它的元编程系统有几套。

C++ 有预处理宏、模板、`constexpr`；Rust 有 `derive`、`macro_rules!`、过程宏；Java 靠注解处理器；连 JavaScript 都有 babel 插件这门「影子语言」。系统每多一套，使用者就要多学一套心智模型、多适应一套报错方式。

Zig 的答案简洁得有点过分：一套都没有。它只有 `comptime`，一个标注，意思是「这段代码在编译期执行」。宏、模板、反射这三件事，在 Zig 里全是同一个机制的不同侧面。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="一个机制三个侧面：comptime 编译期执行居中，向左展开为泛型（类型是普通值，Stack 是接收类型返回类型的函数），向中展开为反射（typeInfo 把类型信息变成编译期数据，field 按名取值），向右展开为代码生成与检查（inline for 展开、compileError 守卫、格式串编译期校验）" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ctA1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="210" y="16" width="240" height="48" rx="6" fill="#ece9e2" stroke="#6b675e" stroke-width="1.5"/>
<text class="t" x="330" y="37" text-anchor="middle" font-size="12" fill="#2b2a26">comptime · 编译期执行</text>
<text class="ts" x="330" y="55" text-anchor="middle" font-size="9" fill="#6b675e">编译器里住着一个 Zig 解释器</text>
<line class="fl" x1="260" y1="64" x2="128" y2="100" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA1)"/>
<line class="fl" x1="330" y1="64" x2="330" y2="100" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA1)"/>
<line class="fl" x1="400" y1="64" x2="532" y2="100" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA1)"/>
<rect class="bx-q" x="20" y="104" width="200" height="92" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="120" y="126" text-anchor="middle" font-size="11" fill="#2b2a26">泛型</text>
<text class="ts" x="120" y="146" text-anchor="middle" font-size="9" fill="#6b675e">type 是普通的值</text>
<text class="ts" x="120" y="162" text-anchor="middle" font-size="9" fill="#6b675e">fn Stack(comptime T: type) type</text>
<text class="ts" x="120" y="178" text-anchor="middle" font-size="9" fill="#6b675e">接收类型、返回类型的函数</text>
<rect class="bx-q" x="230" y="104" width="200" height="92" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="330" y="126" text-anchor="middle" font-size="11" fill="#2b2a26">反射</text>
<text class="ts" x="330" y="146" text-anchor="middle" font-size="9" fill="#6b675e">@typeInfo(T)</text>
<text class="ts" x="330" y="162" text-anchor="middle" font-size="9" fill="#6b675e">类型信息 = 编译期数据</text>
<text class="ts" x="330" y="178" text-anchor="middle" font-size="9" fill="#6b675e">@field 按名字取值</text>
<rect class="bx-q" x="440" y="104" width="200" height="92" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="540" y="126" text-anchor="middle" font-size="11" fill="#2b2a26">代码生成与检查</text>
<text class="ts" x="540" y="146" text-anchor="middle" font-size="9" fill="#6b675e">inline for 编译期展开</text>
<text class="ts" x="540" y="162" text-anchor="middle" font-size="9" fill="#6b675e">@compileError 守卫误用</text>
<text class="ts" x="540" y="178" text-anchor="middle" font-size="9" fill="#6b675e">格式串在编译期校验</text>
<text class="ts" x="330" y="224" text-anchor="middle" font-size="10" fill="#6b675e">别的语言分三套系统的事，这里是同一个解释器的三种用法</text>
</svg>
</figure>

这篇把三个侧面挨个看一遍。文中代码都在 Zig 0.16.0 上编译运行过；语言没到 1.0，版本必须写明。

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

`comptime factorial(5)` 在编译期算出 120，`f5` 成为一个编译期常量。例子本身平淡，对比 C++ 才看出差别：模板元编程里写一个编译期阶乘，要用模板特化、`template <int N>`、`<>::value` 这套独立语法，和运行期代码长得毫无血缘关系。`constexpr` 是后来打的补丁，才让两边勉强共用一套写法。

Zig 里只有一个 `factorial`。想让它编译期跑，调用处标 `comptime`；想运行期跑，直接调用。求值时机由调用方定，函数自己不做主张。

这是 comptime 的第一层含义：它算不上一个特性，只是求值时机的标注。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="同一个 factorial 两条调用路：标注 comptime 时在编译期由解释器算出 120，二进制里只剩常量；直接调用时生成普通机器码在运行期执行；函数自己不变，求值时机由调用方决定" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ctA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="220" y="16" width="220" height="42" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="34" text-anchor="middle" font-size="10.5" fill="#2b2a26">fn factorial(n: u32) u32</text>
<text class="ts" x="330" y="50" text-anchor="middle" font-size="9" fill="#6b675e">只写一份，不做主张</text>
<line class="fl" x1="270" y1="58" x2="150" y2="92" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA2)"/>
<line class="fl" x1="390" y1="58" x2="510" y2="92" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA2)"/>
<rect class="bx-q" x="30" y="96" width="240" height="42" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="150" y="114" text-anchor="middle" font-size="10" fill="#2b2a26">comptime factorial(5)</text>
<text class="ts" x="150" y="130" text-anchor="middle" font-size="9" fill="#6b675e">编译期由解释器执行</text>
<rect class="bx-q" x="390" y="96" width="240" height="42" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="510" y="114" text-anchor="middle" font-size="10" fill="#2b2a26">factorial(n)</text>
<text class="ts" x="510" y="130" text-anchor="middle" font-size="9" fill="#6b675e">运行期普通机器码</text>
<text class="tc" x="150" y="166" text-anchor="middle" font-size="10" fill="#b03a2e">f5 = 120：二进制里只剩常量</text>
<text class="ts" x="510" y="166" text-anchor="middle" font-size="10" fill="#6b675e">n 运行期才知道，照常在运行时算</text>
</svg>
</figure>

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

关键在签名：`comptime T: type`。在 Zig 里，`type` 本身就是一种类型，可以像整数一样被传递、被存放、被函数返回。所以 `Stack` 不是模板，是一个普通函数，接收一个类型，返回一个类型。

这里没有 trait，没有 concept，没有前置的约束声明。约束写在函数体里：你写了 `a < b`，`T` 就得支持 `<`；不支持，编译错误直接指向那一行。Rust 把约束前置在签名上（`fn min<T: Ord>(...)`），换来签名自解释；Zig 让约束留在用法里，换来少一层概念。两种取向各有道理，但「泛型不需要新概念」这件事，Zig 做到了。

顺带一提，`Stack(T)` 是惰性求值的，只有真正调用 `Stack(u8)` 时函数体才执行。类型可以递归定义，链表节点引用自身也不是问题。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 158" role="img" aria-label="泛型即普通函数：类型值 u8 作为实参传进 Stack，函数体在编译期惰性执行，返回一个全新的 struct 类型；换一个 T 就再执行一次，得到另一个互不相干的类型" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ctA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="20" y="40" width="160" height="52" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="100" y="61" text-anchor="middle" font-size="10" fill="#2b2a26">类型值：u8</text>
<text class="ts" x="100" y="79" text-anchor="middle" font-size="9" fill="#6b675e">type 也能当实参传</text>
<line class="fl" x1="180" y1="66" x2="226" y2="66" stroke="#6b675e" stroke-width="1.3" marker-end="url(#ctA3)"/>
<rect class="bx" x="230" y="40" width="200" height="52" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="61" text-anchor="middle" font-size="10" fill="#2b2a26">Stack(comptime T: type)</text>
<text class="ts" x="330" y="79" text-anchor="middle" font-size="9" fill="#6b675e">普通函数 · 调用才执行</text>
<line class="fl" x1="430" y1="66" x2="476" y2="66" stroke="#6b675e" stroke-width="1.3" marker-end="url(#ctA3)"/>
<rect class="bx-q" x="480" y="40" width="160" height="52" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="560" y="61" text-anchor="middle" font-size="10" fill="#2b2a26">返回一个新类型</text>
<text class="ts" x="560" y="79" text-anchor="middle" font-size="9" fill="#6b675e">Stack(u8) 专属 struct</text>
<text class="ts" x="20" y="128" font-size="10" fill="#6b675e">换 T 再调用就再执行一次：Stack(u8) 与 Stack(u32) 是两个互不相干的类型</text>
<text class="ts" x="20" y="148" font-size="9.5" fill="#a29d90">约束不写在签名上：函数体里用了 a &lt; b，T 就得支持 &lt;，不支持错到那一行</text>
</svg>
</figure>

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

拆开看：

- `@typeInfo(T)` 返回一个 tagged union，把「类型是什么」变成一份编译期可见的数据；
- `inline for` 在字段的元数据上循环，循环变量 `f` 是「字段」这种 comptime 值；
- `@field(value, f.name)` 按名字取值，然后递归调用 `dump` 自己。

整个过程没有字符串拼接，也没有代码生成和宏。序列化、配置解析、结构体比较、深拷贝，这些能力在别的语言里要靠手写、反射框架或派生宏，在这里就是一个普通函数，恰好运行在编译期。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="dump 的反射三步：typeInfo 把类型 T 变成 tagged union 数据；inline for 在字段元数据上编译期循环；field 按名字取出字段值并递归调用 dump 自己，直到标量分支打印为止" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ctA4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="ctA4c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<rect class="bx-q" x="20" y="24" width="240" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="140" y="42" text-anchor="middle" font-size="10" fill="#2b2a26">@typeInfo(T)</text>
<text class="ts" x="140" y="58" text-anchor="middle" font-size="9" fill="#6b675e">「类型是什么」变成一份数据</text>
<line class="fl" x1="260" y1="45" x2="296" y2="45" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA4)"/>
<rect class="bx-q" x="300" y="24" width="300" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="450" y="42" text-anchor="middle" font-size="10" fill="#2b2a26">结果是 tagged union</text>
<text class="ts" x="450" y="58" text-anchor="middle" font-size="9" fill="#6b675e">.int / .@"struct" / .pointer … 逐支 switch</text>
<rect class="bx-q" x="20" y="84" width="240" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="140" y="102" text-anchor="middle" font-size="10" fill="#2b2a26">inline for (info.fields)</text>
<text class="ts" x="140" y="118" text-anchor="middle" font-size="9" fill="#6b675e">在字段元数据上编译期循环</text>
<line class="fl" x1="260" y1="105" x2="296" y2="105" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ctA4)"/>
<rect class="bx-q" x="300" y="84" width="300" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="450" y="102" text-anchor="middle" font-size="10" fill="#2b2a26">@field(value, f.name)</text>
<text class="ts" x="450" y="118" text-anchor="middle" font-size="9" fill="#6b675e">名字是编译期字符串，取值是普通调用</text>
<path class="flc" d="M 600 105 C 640 105 640 45 604 45" fill="none" stroke="#b03a2e" stroke-width="1.3" marker-end="url(#ctA4c)"/>
<text class="tc" x="628" y="140" text-anchor="middle" font-size="9.5" fill="#b03a2e">字段值递归 dump</text>
<rect class="bx" x="20" y="146" width="580" height="38" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="310" y="170" text-anchor="middle" font-size="9.5" fill="#2b2a26">Article → { title = 文本 "听雨", views = 整型 1024, draft = 布尔 false }</text>
</svg>
</figure>

对照一下：Rust 没有运行时反射，`serde` 的 `#[derive(Serialize)]` 本质是在编译期读 token 流、生成新代码，代价是错误信息要从生成的代码里往回追。C++ 的静态反射喊了很多年，至今仍在路上。Zig 这边没有单独的「反射系统」，反射就是 `@typeInfo` 一个函数。

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

这件事在 C++ 里叫模板特化加 `if constexpr`，在 Lisp 里叫宏。Zig 的版本没有新语法，`for` 多一个词而已。展开发生在语义分析之后，所以展开体里出了错，行号还是你写的那个行号。

同一个机制顺手解决了可变参数：Zig 的元组是 struct 的特例，字段类型都是 comptime 已知的，所以任意个参数的函数不需要专门的可变参数语法，`anytype` 接一个元组就行。

## 把约定变成编译期检查

Zig 标准库的格式化打印，格式串是编译期校验的。写错类型：

```zig
const n: u32 = 42;
try w.print("{s}\n", .{n}); // {s} 需要 slice，传了整数
```

编译器输出一句话：

```text
error: invalid format string 's' for type 'u32'
```

没有警告被忽略，没有运行时异常，构建直接失败。这个校验逻辑本身就用普通 Zig 代码写成，跑在编译期；语言没有为它单开一个「格式串检查特性」，它只是 comptime 顺手的收益。

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

`Vec2(u128)` 会在编译期收到那条中文错误信息。它类似 `static_assert`，但更灵活：`@compileError` 可以出现在 comptime 数据流的任何深处，消息文本本身就是编译期代码算出来的字符串。这类检查跟着代码走，不会像文档那样过时。

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

`@setEvalBranchQuota` 暴露了 comptime 的实现本质：编译器里住着一个 Zig 解释器，comptime 代码是解释执行的，有指令配额（默认 1000 次分支），超了就报错。这个设计至少保证编译期代码会终止，一个手滑的死循环不会把编译器挂死。

我在这段代码上真实踩过一个坑：最初断言非对角线元素等于 0，测试失败。原因是 `identity()` 只写了对角线，其余位置是 `undefined`，而 **comptime 的 undefined 依然是 undefined，不会变成零**。「编译期执行」管得了求值时机，管不了「未初始化内存」的语义，这两个概念在 Zig 里分得很清，撞上一次就记住了。

收益也实在：能搬进编译期的测试，通过之后不会在二进制里留下任何字节。当然，只有纯计算性质的测试能这么搬；涉及 IO 和内存分配行为的，还是得留给运行期。

## 与 C++、Rust 的对照

| 能力 | C++ | Rust | Zig |
| --- | --- | --- | --- |
| 泛型容器 | 模板 | 泛型 + trait bound | 返回 `type` 的普通函数 |
| 派生实现（序列化等） | 手写或外部代码生成 | `derive` 过程宏 | `@typeInfo` + `inline for` |
| 编译期校验 | `static_assert`、`constexpr` | const 泛型、过程宏 | 普通函数 + `@compileError` |
| 编译期执行 | `constexpr` / `consteval` | `const fn` | `comptime` |
| 语法级变换 | 预处理宏 | `macro_rules!`、过程宏 | 刻意不支持 |

最后一行值得单独说。Zig 刻意不支持「发明新语法」级别的宏，你没法像 Lisp 那样定义新的控制流结构。这是立场而非能力缺失：语法面永远统一，读任何 Zig 代码都不用先问一句「这用了哪个方言」。代价是某些 DSL 确实做不了。Zig 的判断是：需要发明新语法的时候，多数是语言本身缺了一个正交的特性，该补的是特性，不该开侧门。

## comptime 的代价

代价主要有四项。

编译时间。comptime 是解释执行，比运行期机器码慢一到两个数量级，滥用的代码库会让构建明显变慢。配额机制保证编译期代码会终止，但不保证它快。

调试。运行期代码可以打印、可以断点；comptime 代码出了问题，主要靠读编译器输出和 `@compileLog`，体验还远远比不上运行期。

稳定性。语言没到 1.0，这不是一句免责声明。写这篇文章用的 0.16.0 里，标准库的 `Writer` 刚从 `std.io.Writer` 挪到 `std.Io.Writer`，接口整个换过一轮，我的示例代码就真的撞上了这个改动。comptime 机制本身已经稳定多年，但它依赖的标准库形状会跟着版本动，生产环境使用要有锁定版本的准备。

错误信息。`inline for` 展开后的引用链可以很长，好在每一段都是真实的 Zig 调用栈。比起 C++ 模板实例化的错误，读起来更像日志，不像考古。

---

回到设计本身。多数语言解决元编程的思路是往里加系统：宏、模板、反射，一套不够再加一套。Zig 往回找，找到一个原语，让别的特性显得多余。comptime 就是结果：编译期执行这一个机制，顶下了宏、模板、反射三摊事。

这一招是否足够，要等语言走到 1.0 之后由生态来回答。能看到「做减法」被当成设计纲领认真执行，已经不多见。

下一篇讲错误处理。comptime 管求值时机，错误处理管失败传播；Zig 在那边做的是同一件事，把异常机制拆回「错误是值」和「清理是代码」两半。
