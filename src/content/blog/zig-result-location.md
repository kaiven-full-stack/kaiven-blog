---
title: Zig 的 Result Location：类型与地址从外层流向表达式
description: 在 Zig 里，外层上下文可以先告诉表达式它该是什么类型、该把值直接写到哪里。这篇从匿名字面量、聚合赋值与 return 出发，分清语言语义、编译器 lowering、ABI 与优化器各自管到哪里。文中代码以 Zig 0.16.0 编译验证。
pubDate: 2026-09-05
category: zig
tags: [Zig, 编程语言]
---

读一行这样的代码时，多数人脑中的模型是：函数先在自己的地方造出结果，交给调用者，调用者接过来放进变量——

```zig
const value = makeValue();
```

右边仿佛先有一份完整的值，然后越过等号，落到左边。

Zig 把另一种次序写进了语言。外层上下文可以先告诉表达式「你应当成为什么类型」；如果已经有一处存储，还可以告诉它「请直接写在这里」。这套规则叫 **Result Location Semantics**。

上一篇讲内存布局，看一个值落成以后字段如何各归其位；这一篇往前一步，看值落成以前，类型和位置怎样从外层传到每个子表达式。代码全部在 Zig 0.16.0 上验证过。

## 类型先从左边递过来

先看一行再寻常不过的代码：

```zig
const count: u32 = 42;
```

整数文字 `42` 本来是 `comptime_int`。它在这里成为 `u32`，并不是先造出一个无穷精度整数、再在末尾临时猜一次转换；左边的类型标注早已把 `u32` 递给了右边。

类似的事情还会穿过结构体字面量：

```zig
const Packet = struct {
    length: u16,
};

const wide: u64 = 513;
const packet: Packet = .{
    .length = @intCast(wide),
};
```

`@intCast` 没有明写目标类型，仍知道该把 `wide` 变成 `u16`。这条线索的来路是：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 226" role="img" aria-label="result type 向内流动：packet 的标注类型 Packet 传给匿名结构体字面量，字面量把 length 字段的类型 u16 传给字段初始化表达式，@intCast 由此得知目标类型是 u16" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="rlA1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<line class="fl" x1="80" y1="30" x2="80" y2="190" stroke="#6b675e" stroke-width="1.3" marker-end="url(#rlA1)"/>
<text class="ts" x="68" y="110" text-anchor="middle" font-size="9.5" fill="#6b675e" transform="rotate(-90 68 110)">传播方向：从外层到内层</text>
<rect class="bx" x="120" y="20" width="420" height="38" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="44" text-anchor="middle" font-size="10.5" fill="#2b2a26">const packet: Packet — 标注写下 Packet</text>
<line class="fl" x1="330" y1="58" x2="330" y2="70" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA1)"/>
<rect class="bx-q" x="120" y="74" width="420" height="38" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="98" text-anchor="middle" font-size="10.5" fill="#2b2a26">匿名字面量 .{ … } 的 result type = Packet</text>
<line class="fl" x1="330" y1="112" x2="330" y2="124" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA1)"/>
<rect class="bx-q" x="120" y="128" width="420" height="38" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="152" text-anchor="middle" font-size="10.5" fill="#2b2a26">.length 字段初始化式的 result type = u16</text>
<line class="fl" x1="330" y1="166" x2="330" y2="178" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA1)"/>
<rect class="bx-sick" x="120" y="182" width="420" height="38" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="330" y="206" text-anchor="middle" font-size="10.5" fill="#b03a2e">@intCast(wide) 的目标类型 = u16</text>
</svg>
</figure>

这就是 Result Location Semantics 的第一半：**result type**。类型不一定只从表达式内部向外推断，也可以从外层上下文向内流动。

## result type 与 result location

Zig 0.16.0 的语言参考这样开篇：

> During compilation, every Zig expression and sub-expression is assigned optional result location information.

这里的 result location information 有两部分：

- **result type**：这个表达式应当产生什么类型；
- **result location**：这个值应当直接写到哪一处内存，是一枚指向目的地的指针。

两者都是可选的。表达式可能只知道类型、不知道位置；也可能从外层收到一处位置，再把更细的位置递给子表达式。若写成：

```zig
_ = .{ 1, 2 };
```

下划线既不提供具体类型，也不提供真实的存储位置，右边只能凭自身内容推断。

语言参考紧接着特意说明：

> This is not an implementation detail.

这句话很要紧。Result Location Semantics 不是某次 Release 构建碰巧做出的优化，也不是看见汇编里少了一条 `memcpy` 之后才起的名字；它是 Zig 的语义，也是这门语言类型推断的主要机制，规定了聚合值初始化时子表达式怎样得知自己的落点。只把它译成「返回值优化」，会漏掉大半个机制。

## 匿名字面量逐字段写进目的地

来看 result location 怎样工作：

```zig
const Pair = struct {
    left: u32,
    right: u32,
};

fn fill(out: *Pair) void {
    out.* = .{
        .left = 21,
        .right = 34,
    };
}
```

赋值左边是 `out.*`，所以右边匿名结构体字面量得到的 result location 是 `out`。它又把位置继续分给两个字段：

```text
.left  得到 &out.left
.right 得到 &out.right
```

这段代码在语义上近似于：

```zig
out.left = 21;
out.right = 34;
```

程序并不先在别处造出一个 `Pair`，再把整块字节搬给 `out.*`；匿名字面量直接实例化外层交来的位置，各字段写进各自的格子。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="result location 的拆分传递：out.* 赋值把 out 交给匿名字面量作为 result location，字面量再把 out.left 的地址交给 .left = 21，把 out.right 的地址交给 .right = 34，两个值分别直写目的格子，没有中间副本" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="rlA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">out.* = .{ .left = 21, .right = 34 }</text>
<rect class="bx-q" x="30" y="40" width="230" height="96" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="145" y="62" text-anchor="middle" font-size="10" fill="#2b2a26">匿名结构体字面量</text>
<text class="ts" x="145" y="80" text-anchor="middle" font-size="9" fill="#6b675e">result location = out</text>
<text class="ts" x="60" y="106" font-size="9.5" fill="#2b2a26">.left = 21</text>
<text class="ts" x="60" y="126" font-size="9.5" fill="#2b2a26">.right = 34</text>
<rect class="bx" x="420" y="40" width="210" height="96" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="525" y="62" text-anchor="middle" font-size="10" fill="#2b2a26">out: *Pair</text>
<rect class="bx-q" x="436" y="74" width="84" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="478" y="91" text-anchor="middle" font-size="9" fill="#6b675e">left</text>
<text class="ts" x="478" y="107" text-anchor="middle" font-size="10" fill="#2b2a26">21</text>
<rect class="bx-q" x="530" y="74" width="84" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="572" y="91" text-anchor="middle" font-size="9" fill="#6b675e">right</text>
<text class="ts" x="572" y="107" text-anchor="middle" font-size="10" fill="#2b2a26">34</text>
<line class="fl" x1="260" y1="102" x2="430" y2="92" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA2)"/>
<text class="ts" x="345" y="88" text-anchor="middle" font-size="8.5" fill="#6b675e">&amp;out.left</text>
<line class="fl" x1="260" y1="122" x2="524" y2="108" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA2)"/>
<text class="ts" x="400" y="124" text-anchor="middle" font-size="8.5" fill="#6b675e">&amp;out.right</text>
<text class="ts" x="30" y="166" font-size="10" fill="#6b675e">位置像类型一样可以拆：外层交给字面量，字面量按字段继续分</text>
<text class="ts" x="30" y="186" font-size="9.5" fill="#a29d90">全程没有一份完整的临时 Pair</text>
</svg>
</figure>

我把它放进测试：

```zig
test "anonymous literal initializes the destination" {
    var pair: Pair = undefined;
    fill(&pair);

    try std.testing.expectEqual(@as(u32, 21), pair.left);
    try std.testing.expectEqual(@as(u32, 34), pair.right);
}
```

Zig 0.16.0 回答：

```text
OK
```

这里值得记住的是位置传播的次序：外层先把位置交给字面量，字面量再按字段拆分，递给每一个子表达式。

## 类型和位置的传播边界

result type 与 result location 常常同行，却是两件事，Zig 对哪些表达式继续传递它们有明确规则。取几种常见写法并排看：

| 写法 | 子表达式得到 result type | 子表达式得到 result location |
| --- | --- | --- |
| `const value: T = x` | `T` | `&value` |
| `value = x` | `@TypeOf(value)` | `&value` |
| `.{ .field = x }` | 字段类型 | `&ptr.field` |
| `@as(T, x)` | `T` | 不传递 |
| `f(x)` | 形参类型 | 不传递 |
| `T{ .field = x }` | 字段类型 | 不传递 |
| `&x` | 由指针结果推得 | 不传递 |

匿名初始化器 `.{ ... }` 是这套机制最顺的通道：自身若收到位置，就把字段位置继续交给里面的表达式。

但 `@as(T, x)` 不会把自己收到的位置传给 `x`；函数调用只用形参约束实参的类型，不会把调用表达式最终要去的地址塞进参数；带类型的初始化器 `T{ ... }` 同样不给字段子表达式传递外层位置。所以 `@as(T, x)` 里的 `x` 知道自己该是什么类型，却不知道自己要写到哪里。

这处差别平日不显眼；一旦表达式同时读取和改写同一个聚合值，就会直接改变结果。

## 一行交换写出两个 2

试着交换数组里的两个元素：

```zig
const std = @import("std");

test "aggregate assignment writes fields in order" {
    var pair = [_]u32{ 1, 2 };
    pair = .{ pair[1], pair[0] };

    try std.testing.expectEqual([_]u32{ 2, 1 }, pair);
}
```

按「先算右边，再整体赋给左边」的直觉，答案应该是 `{ 2, 1 }`。测试失败：期望 `{ 2, 1 }`，实际得到 `{ 2, 2 }`。

原因正在 result location。右边匿名数组字面量拿到 `&pair`，再把两个元素的位置分别递下去，整句近似展开成：

```zig
pair[0] = pair[1];
pair[1] = pair[0];
```

第一行写完，`pair` 已经变成 `{ 2, 2 }`；第二行再读 `pair[0]`，读到的当然也是 `2`。

这不是优化器把程序改坏了，也不是 Debug 模式的一次怪事。Zig 的官方语言参考就用这个例子说明：result location 会干预这种看似同时、实则逐项发生的交换。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 262" role="img" aria-label="一行交换的两种展开：就地写入时 pair 收到自己的地址，第一步 pair[0] = pair[1] 把数组变成 2,2，第二步 pair[1] = pair[0] 读到的已是 2，结果两个 2；加一层 @as 或临时变量后，右边先在独立位置算出 2,1，再整体赋值，交换正确" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="rlA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="11" fill="#b03a2e">pair = .{ pair[1], pair[0] } · 位置就是 pair 自己</text>
<rect class="bx-q" x="24" y="40" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="42" y="61" text-anchor="middle" font-size="11" fill="#2b2a26">1</text>
<rect class="bx-q" x="62" y="40" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="80" y="61" text-anchor="middle" font-size="11" fill="#2b2a26">2</text>
<line class="fl" x1="110" y1="56" x2="146" y2="56" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA3)"/>
<text class="ts" x="128" y="44" text-anchor="middle" font-size="8.5" fill="#6b675e">pair[0] = pair[1]</text>
<rect class="bx-sick" x="150" y="40" width="36" height="32" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="168" y="61" text-anchor="middle" font-size="11" fill="#b03a2e">2</text>
<rect class="bx-q" x="188" y="40" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="206" y="61" text-anchor="middle" font-size="11" fill="#2b2a26">2</text>
<line class="fl" x1="236" y1="56" x2="272" y2="56" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA3)"/>
<text class="ts" x="254" y="44" text-anchor="middle" font-size="8.5" fill="#6b675e">pair[1] = pair[0]</text>
<rect class="bx-sick" x="276" y="40" width="36" height="32" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="294" y="61" text-anchor="middle" font-size="11" fill="#b03a2e">2</text>
<rect class="bx-sick" x="314" y="40" width="36" height="32" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="332" y="61" text-anchor="middle" font-size="11" fill="#b03a2e">2</text>
<text class="tc" x="372" y="61" font-size="10" fill="#b03a2e">读到的 pair[0] 已经是新值：两个 2</text>
<text class="ts" x="20" y="124" font-size="11" fill="#2b2a26">pair = @as([2]u32, .{ pair[1], pair[0] }) · @as 截断位置</text>
<rect class="bx-q" x="24" y="140" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="42" y="161" text-anchor="middle" font-size="11" fill="#2b2a26">1</text>
<rect class="bx-q" x="62" y="140" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="80" y="161" text-anchor="middle" font-size="11" fill="#2b2a26">2</text>
<line class="fl" x1="110" y1="156" x2="146" y2="156" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA3)"/>
<text class="ts" x="128" y="144" text-anchor="middle" font-size="8.5" fill="#6b675e">先在独立位置算</text>
<rect class="bx-q" x="150" y="140" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="168" y="161" text-anchor="middle" font-size="11" fill="#2b2a26">2</text>
<rect class="bx-q" x="188" y="140" width="36" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="206" y="161" text-anchor="middle" font-size="11" fill="#2b2a26">1</text>
<line class="fl" x1="236" y1="156" x2="272" y2="156" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA3)"/>
<text class="ts" x="254" y="144" text-anchor="middle" font-size="8.5" fill="#6b675e">再整体赋值</text>
<rect class="bx" x="276" y="140" width="36" height="32" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="294" y="161" text-anchor="middle" font-size="11" fill="#2b2a26">2</text>
<rect class="bx" x="314" y="140" width="36" height="32" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="332" y="161" text-anchor="middle" font-size="11" fill="#2b2a26">1</text>
<text class="ts" x="372" y="161" font-size="10" fill="#6b675e">读写分开，次序恢复熟悉的样子</text>
<text class="ts" x="20" y="208" font-size="10" fill="#6b675e">两条路只差一件事：右边有没有拿到左边那块内存的地址</text>
<text class="ts" x="20" y="232" font-size="9.5" fill="#a29d90">临时变量 swapped 与 @as 同理：都是给右半边一处独立的落脚点</text>
</svg>
</figure>

## 正确写法：独立位置，或 `@as` 边界

正确的交换需要一个独立位置：

```zig
test "a temporary location makes swapping explicit" {
    var pair = [_]u32{ 1, 2 };

    const swapped: [2]u32 = .{
        pair[1],
        pair[0],
    };
    pair = swapped;

    try std.testing.expectEqual([_]u32{ 2, 1 }, pair);
}
```

`swapped` 是一个独立变量：两个元素先从旧 `pair` 读出，新数组完整写成后再赋给 `pair`。测试通过：

```text
OK
```

也可以用 `@as` 截断位置的传播：

```zig
test "a conversion creates a location boundary" {
    var pair = [_]u32{ 1, 2 };

    pair = @as([2]u32, .{
        pair[1],
        pair[0],
    });

    try std.testing.expectEqual([_]u32{ 2, 1 }, pair);
}
```

外层赋值把 `&pair` 交给 `@as`，但 `@as` 只把 `[2]u32` 这个 result type 递给里面的字面量，不把 `&pair` 递进去；右边先形成一个独立的数组值，交换恢复了熟悉的次序。这与上一节的传播规则正好对上：`@as` 不传递位置。

少一次中间存储不总是更好。源和目的地重叠时，就地写入会改变后续读取；这时用一个独立的临时值，是把读和写分开，不是笨拙。

## return 的值走到哪里

现在回到最初那行函数调用：

```zig
const Big = struct {
    a: u64,
    b: u64,
    c: u64,
    d: u64,
};

fn makeBig() Big {
    return .{
        .a = 1,
        .b = 2,
        .c = 3,
        .d = 4,
    };
}

pub fn main() void {
    const value = makeBig();
    _ = value;
}
```

`return` 后面的匿名字面量知道函数返回类型是 `Big`，四个整数分别得到字段类型——这是 result type 在做事。至于四个字段最终写在哪里，要分三层说。

第一层是**语言语义**。Result Location Semantics 允许聚合值直接写入既定位置，避免为了初始化数据结构而制造无谓的中间副本；这是 Zig 明文规定这套机制的理由之一。

第二层是**编译器实现**。Zig 0.16.0 会在内部使用返回位置来降低这类代码。对上面的较大结构体，我在这台 x86_64 机器上查看生成代码，可以看到 `makeBig` 直接向调用方提供的返回槽逐字段写入，没有先在自己的栈上造一份完整 `Big` 再整体搬走。

第三层是**目标 ABI**。某些聚合体通过隐藏的返回地址传递，常被称为 `sret`；较小的值又可能直接走寄存器。具体界线由架构、调用约定、类型和构建方式决定。

三层彼此相关，但不是同一回事：Result Location Semantics 是语言怎样理解表达式，返回槽是编译器的一种 lowering，`sret` 是 ABI 怎样让函数交付聚合值。把三者都叫「返回值优化」，等于把语义、实现和调用约定混成一行。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 212" role="img" aria-label="return 的三层：语言语义层 Result Location Semantics 规定表达式知道类型与写入位置；编译器 lowering 层用返回槽逐字段直写；目标 ABI 层决定聚合值经寄存器还是 sret 隐藏指针跨越调用边界；三层稳定范围各不相同" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="rlA5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="110" y="20" width="420" height="46" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="320" y="39" text-anchor="middle" font-size="10.5" fill="#2b2a26">语言语义 · Result Location Semantics</text>
<text class="ts" x="320" y="57" text-anchor="middle" font-size="9" fill="#6b675e">表达式知道什么类型、值该写到哪 · Zig 语言规则</text>
<line class="fl" x1="320" y1="66" x2="320" y2="80" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA5)"/>
<rect class="bx-q" x="110" y="84" width="420" height="46" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="320" y="103" text-anchor="middle" font-size="10.5" fill="#2b2a26">编译器 lowering · 返回槽</text>
<text class="ts" x="320" y="121" text-anchor="middle" font-size="9" fill="#6b675e">makeBig 逐字段直写调用方给的槽 · 随 Zig 版本与后端变</text>
<line class="fl" x1="320" y1="130" x2="320" y2="144" stroke="#6b675e" stroke-width="1.2" marker-end="url(#rlA5)"/>
<rect class="bx-q" x="110" y="148" width="420" height="46" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="320" y="167" text-anchor="middle" font-size="10.5" fill="#2b2a26">目标 ABI · sret 或寄存器</text>
<text class="ts" x="320" y="185" text-anchor="middle" font-size="9" fill="#6b675e">聚合值怎样跨调用边界 · 由平台与调用约定决定</text>
<text class="ts" x="546" y="48" font-size="9" fill="#a29d90">最稳定</text>
<text class="ts" x="546" y="112" font-size="9" fill="#a29d90">随实现</text>
<text class="ts" x="546" y="176" font-size="9" fill="#a29d90">随平台</text>
</svg>
</figure>

## 汇编里没看到 `memcpy`，说明不了什么

若在 Release 汇编里没找到 `memcpy`，最多说明这一次构建没有留下那种形式的复制。优化器还可能：

- 内联整个函数；
- 把字段常量直接送进寄存器；
- 消除从未被观察的对象；
- 把若干标量组合成向量写入；
- 重新安排本来存在的 load 与 store。

反过来，Debug 构建里出现一次搬运，也不能据此宣布 Result Location Semantics 失效。语言规定的是表达式收到什么类型与位置、初始化如何展开；它不许诺每种类型在每个目标上必然对应某一种机器指令。

界线可以列成一张表：

| 层次 | 回答的问题 | 稳定范围 |
| --- | --- | --- |
| Result Location Semantics | 表达式知道什么类型，值应直接写到哪里 | Zig 语言规则 |
| 编译器 lowering | 语义怎样变成中间表示和机器操作 | Zig 版本与后端 |
| ABI 返回约定 | 值经寄存器还是隐藏指针跨过调用边界 | 目标平台与调用约定 |
| 优化器 | 哪些搬运最终被合并或删除 | 构建模式与具体程序 |

写性能敏感的代码，当然可以查看汇编、测量吞吐；只是测量回答的是「这次生成了什么」，语言参考回答的是「源码意味着什么」。两个问题各有各的答案，别混在一起。

## result location 不是所有权保证

语言参考说，result location 对必须拥有固定内存地址的 pinned types 很重要：直写最终位置，能避免先在临时处构造、再留下指向旧处的内部指针。

但 Zig 不会因此替类型建立「不可移动」的保证。例如，函数局部变量在自己的初始化表达式里还不在作用域中：

```zig
const Node = struct {
    value: u32,
    self: *const Node,
};

fn init() void {
    var node: Node = .{
        .value = 1,
        .self = &node,
    };
}
```

编译器会拒绝：

```text
error: use of undeclared identifier 'node'
```

可以在函数内先声明，再就地赋值：

```zig
fn init() void {
    var node: Node = undefined;
    node = .{
        .value = 1,
        .self = &node,
    };
}
```

此时 `node.self` 指向最终的 `node`。然而后续若把 `node` 按值复制到别处，内部指针不会跟着改指新副本；若原地址失效，指针照样悬空。

result location 只回答这一次求值写在哪里。它不追踪所有权，不证明生命周期，也不禁止未来的按值复制。

## MMIO 边界：先形成完整值

上一篇谈 packed struct 时提到硬件寄存器，result location 在这里还有一条很实际的边界。

设寄存器由 packed struct 表示：

```zig
const Control = packed struct(u32) {
    enable: bool,
    mode: u3,
    reserved: u28,
};
```

若手中是一枚 volatile 指针，不应想当然地把匿名字面量直接赋给它：

```zig
const reg: *volatile Control = getRegister();

reg.* = .{
    .enable = true,
    .mode = 3,
    .reserved = 0,
};
```

聚合赋值可以逐字段直接写向 result location；而硬件寄存器往往要求一次完整宽度的 volatile 写入，字段级的读—改—写也可能具有完全不同的设备语义。

应先在普通内存里形成完整值，再整体写入：

```zig
const next: Control = .{
    .enable = true,
    .mode = 3,
    .reserved = 0,
};

reg.* = next;
```

这里的中间变量是故意留的。对普通内存，省去中间值常是好事；到了 MMIO 边界，写几次、以多大宽度写，本身就是程序含义。涉及 volatile、原子操作或外设副作用时，不能想当然地认为机器会替你一笔写完。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="MMIO 边界两种写法：把匿名字面量直接赋给 volatile 寄存器指针，聚合赋值可能逐字段落到设备上，写入次数与宽度由 lowering 决定；先在普通内存形成完整 Control 值再整体赋给寄存器，才保证一次完整宽度的 volatile 写入" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="rlA6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="tc" x="20" y="26" font-size="11" fill="#b03a2e">✗ 直接赋字面量</text>
<rect class="bx-q" x="20" y="36" width="270" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="155" y="56" text-anchor="middle" font-size="9.5" fill="#2b2a26">reg.* = .{ .enable = true,</text>
<text class="ts" x="155" y="72" text-anchor="middle" font-size="9.5" fill="#2b2a26">.mode = 3, .reserved = 0 }</text>
<line class="fl" x1="290" y1="60" x2="346" y2="60" stroke="#6b675e" stroke-width="1.3" marker-end="url(#rlA6)"/>
<rect class="bx-sick" x="350" y="36" width="290" height="48" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="ts" x="495" y="56" text-anchor="middle" font-size="9.5" fill="#b03a2e">逐字段直写 result location</text>
<text class="ts" x="495" y="72" text-anchor="middle" font-size="9" fill="#6b675e">写几次、多宽，由 lowering 决定</text>
<text class="tc" x="350" y="104" font-size="9.5" fill="#b03a2e">设备可能看到多次半成品写入：语义变了</text>
<text class="ts" x="20" y="140" font-size="11" fill="#2b2a26">✓ 先形成完整值</text>
<rect class="bx-q" x="20" y="150" width="270" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="155" y="170" text-anchor="middle" font-size="9.5" fill="#2b2a26">const next: Control = .{ … }</text>
<text class="ts" x="155" y="186" text-anchor="middle" font-size="9" fill="#6b675e">普通内存里把值拼完整</text>
<line class="fl" x1="290" y1="174" x2="346" y2="174" stroke="#6b675e" stroke-width="1.3" marker-end="url(#rlA6)"/>
<rect class="bx" x="350" y="150" width="290" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="495" y="170" text-anchor="middle" font-size="9.5" fill="#2b2a26">reg.* = next</text>
<text class="ts" x="495" y="186" text-anchor="middle" font-size="9" fill="#6b675e">一次完整宽度的 volatile 写入</text>
<text class="ts" x="20" y="218" font-size="9.5" fill="#6b675e">副作用边界上，中间变量不是浪费，是协议的一部分</text>
</svg>
</figure>

## 收束：读 Zig 时多问的两个问题

全文可以收成两条线：

| 线索 | 它告诉表达式什么 | 最常见的来处 |
| --- | --- | --- |
| result type | 应产生哪一种类型 | 类型标注、赋值左侧、函数形参、字段类型 |
| result location | 应直接写入哪一处内存 | 变量初始化、赋值左侧、匿名聚合初始化器 |

result type 让 `@intCast`、枚举字面量和匿名聚合值不必把类型处处写满；result location 让匿名字面量能够逐字段写进目的地，不必先造出一份完整副本。两者都从上下文向表达式内部传播，却会在不同的语法边界停下：`@as`、函数调用、取地址和带类型初始化器，都可能继续传类型而不继续传位置。

于是读一段 Zig 时，除了问「这个表达式算出什么」，还值得多问两句：

1. 外层给了它什么 result type？
2. 外层是否也给了它 result location，它又把位置递给了谁？

这两问能解释许多看似分散的现象：为何 `@intCast` 可以省略目标类型，为何匿名字面量能直写字段，为何一行数组交换会得到两个 `2`，也为何加一层 `@as` 或临时变量，程序就改了次序。

## 这套语义的代价

隐式数据流并不总是容易看见。类型与位置从外层向内传播，代码因此简洁，却也让局部表达式的含义依赖上下文；读匿名字面量时不能只盯着花括号里的几行，左边的类型与地址也在参与求值。

就地写入会让别名真正介入次序。`pair = .{ pair[1], pair[0] }` 不是智力题，而是提醒：源与目的地重叠时，每一次字段写入都可能改变后续读取。需要快照语义，就明明白白地建立独立值。

少一次副本也不是永恒的性能承诺。调用约定、内联、寄存器分配与优化等级仍会影响最终机器代码；这套语义提供的是基础，不是「任何大结构体都零复制」的广告词。

固定地址仍由程序员守护。原地构造可以让值从一开始落在正确地址，但不会建立 Rust 式借用检查，也不禁止后续移动；自引用对象一旦被复制，内部指针依旧要自己料理。

副作用边界要比语法更受尊重。volatile、MMIO、原子内存与并发代码关心的不只是最终值是否相同，还包括写入次数、顺序和宽度。该先在别处形成完整值时，不要为了省一个中间变量，把半成品直接落到寄存器上。

---

等号右边那份想象中的临时副本，到这里可以收起来了。有些值确实会经过寄存器、返回槽和优化器的反复裁并，那是实现走的路；在语言这一层，外层先给类型、给地址，内层表达式再依次求值。目的地若已经在场，值可以在那里出生；读取与写入若彼此干扰，就老老实实先写进一个独立值。

下一篇讲切片的生命周期。位置回答值写在哪里，不回答那块内存归谁、能活多久——后面这两个问题，是下一篇的主角。
