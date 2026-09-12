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

```text
packet 的类型 Packet
        ↓
匿名结构体字面量的 result type 是 Packet
        ↓
length 字段的 result type 是 u16
        ↓
@intCast 的目标类型是 u16
```

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
