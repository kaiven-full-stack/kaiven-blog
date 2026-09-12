---
title: Illegal Behavior：Zig 的四种构建模式改变了什么
description: 同一段整数溢出，Debug 与 ReleaseSafe 会 panic，ReleaseFast 与 ReleaseSmall 不再设置运行时检查。这篇讲清 Illegal Behavior 在语言里指什么、四种模式各改变了什么，以及优化器为什么会把「非法路径不会发生」当推理前提。四种模式的输出均来自 Zig 0.16.0 实机。
pubDate: 2026-09-05
category: zig
tags: [Zig, 编程语言]
---

```zig
value += 1;
```

`value` 是 `u8`，此刻等于 `255`。这行加法在数学上得到 256，八个二进制位装不下。用 Zig 的术语说，这是一次 Illegal Behavior。

把这段程序分别交给四种构建模式：Debug 和 ReleaseSafe 执行到加法就停下来，报告 integer overflow；ReleaseFast 和 ReleaseSmall 没有这道运行时检查，我这次实验里它们恰好打印了 `0`。

只看输出，很容易读成四套规则：前两种禁止溢出，后两种允许回绕。但语言规则只有一套。普通整数溢出在四种模式下都是 Illegal Behavior，模式改变的只有两件事：编译器是否在运行时设置检查，以及优化器基于「非法路径不会发生」这个前提会做些什么。

前面几篇已经反复碰到这类现象：数组越界、读错 union 字段、非法 enum tag、use-after-free，都是 Debug 下报警、ReleaseFast 下沉默。这篇把这些观察集中起来，把 Illegal Behavior 本身讲清楚。文中代码与输出都在 Zig 0.16.0 上验证过。

## 四种模式各自做什么

| 模式 | 优化 | 运行时安全检查 | 主要取向 |
| --- | --- | --- | --- |
| Debug | 关闭 | 开启 | 编译快、便于调试 |
| ReleaseSafe | 开启 | 开启 | 优化与运行时检查并存 |
| ReleaseFast | 开启 | 关闭 | 运行性能 |
| ReleaseSmall | 面向体积优化 | 关闭 | 更小的产物 |

`Debug` 是默认模式，其余三种是可复现的发布模式。有一个常见等式要先澄清：

```text
Debug      = 安全
Release    = 不安全
```

Zig 里没有笼统的 "Release" 模式。ReleaseSafe 开着优化，同时保留运行时检查；ReleaseSmall 关掉检查，图的是产物更小，谈不上「为了速度牺牲安全」。所以安全和优化是两个独立的选择，四种模式只是把它们组合了出来：怎么优化，以及要不要为 safety-checked Illegal Behavior 设置运行时检查。

## Illegal Behavior 意味着什么

Zig 0.16.0 的语言参考把 Illegal Behavior 分成两类。

第一类是 **safety-checked Illegal Behavior**。编译器能够在潜在出错的位置插入检查，检查失败时程序 panic。大多数 Illegal Behavior 属于这一类，例如：

- 普通整数运算溢出；
- 数组或切片越界；
- 整数除以零；
- 解开一个错误值或 `null`；
- 访问 union 的非活跃字段；
- 把无对应 tag 的整数转成穷尽 enum；
- `@alignCast` 的地址不满足对齐；
- 控制流抵达 `unreachable`。

第二类是 **unchecked Illegal Behavior**。编译器没有足够信息在运行时检查。比如经过某些指针转换以后，边界、对齐或别名事实已经不在类型里，检查也就无从设置。

这两类一旦真正发生，语言都不再约束程序后果，区别只在于前者通常有机会在发生前被运行时检查按住。

语言参考里还有一句更关键的话：当 safety checks 被关闭，safety-checked Illegal Behavior 会像 unchecked Illegal Behavior 一样处理。

所以 ReleaseFast 撤掉的只是运行时检查，它并没有顺手把溢出定义成回绕、把越界定义成「尽量读一下」。非法行为一旦发生，程序可能直接崩溃，可能打印一个看似合理的数，也可能什么动静都没有、只是悄悄写坏了别处的数据；甚至整条分支都可能被优化器依据「这里不会发生」删掉。语言在 Illegal Behavior 发生之后不再担保任何结果，具体落到哪一种，属于实现行为。

## Debug：把错误钉在它发生的位置

让加法真正发生在运行时：

```zig
const std = @import("std");

pub fn main() void {
    var value: u8 = 255;
    _ = &value;

    value += 1;
    std.debug.print("{d}\n", .{value});
}
```

`_ = &value` 让变量保持运行时可知，避免整段被提前折叠成编译期求值。

Debug 模式执行到加法时停止：

```text
panic: integer overflow
```

换成数组越界：

```zig
var index: usize = 3;
_ = &index;
const bytes = [_]u8{ 10, 20, 30 };
std.debug.print("{d}\n", .{bytes[index]});
```

它会报告：

```text
panic: index out of bounds: index 3, len 3
```

读错 tagged union 字段时，panic 信息会同时列出想读的字段和实际的 active field：

```text
panic: access of union field 'online' while field 'backoff' is active
```

Debug 的价值在这里：错误被固定在第一次可检测的位置。没有这道检查的话，错误会继续传播，等到稍后崩溃时，调用栈和数据都离真正的原因很远了。

一个要交代的细节：undefined 那篇见过的 `0xAA`，只是当前实现用来显影未初始化内存的手段，换一个版本或后端未必还是这个字节。语言保证的是读取 undefined 无效；至于用什么方式让你看见，属于实现的选择。

## ReleaseSafe：优化开着，检查也在

把同一个溢出程序改用 ReleaseSafe 构建：

```text
panic: integer overflow
```

结果相同，但此时编译器已经打开了优化。

对一条运行时普通加法，ReleaseSafe 可能生成近似这样的机器指令：

```asm
add     al, 1
jb      overflow_panic
```

一次加法，一次根据进位标志跳转。检查的成本就在这里：额外分支、panic 路径和相应元数据，在生成代码里看得见，在基准测试里量得到。

所以 ReleaseSafe 是完全正当的发布选择，适合愿意用一部分体积和性能换运行时诊断的生产环境，也适合在 CI 里检验优化后的代码。

不过名字里的 Safe 别读成「程序结果已经安全」，它只表示 Zig 默认保留 safety checks。一段非法行为若不在可检查范围内，ReleaseSafe 一样无能为力；程序把网络输入直接交给 `@enumFromInt`，panic 只是开发错误的暴露，合格的协议拒绝还得自己写；代码逻辑本身把金额算错的话，所有内存访问都可能完全合法。

## ReleaseFast：优化器采信你的前提

ReleaseFast 最容易被理解成「去掉检查后照旧执行」。实际发生的事比这个模型更进一步。

看两个只差一个字符的函数：

```zig
export fn ordinaryIsGreater(x: u32) bool {
    return x + 1 > x;
}

export fn wrappingIsGreater(x: u32) bool {
    return x +% 1 > x;
}
```

普通 `+` 承诺运算不会溢出。于是对所有合法输入，`x + 1 > x` 恒为真，ReleaseFast 可以把第一个函数直接折叠成：

```asm
mov     al, 1
ret
```

`x` 是多少已经不重要。若 `x == maxInt(u32)`，程序早已越过合法语义的边界，编译器不必为这条路径保留回绕后的比较。

`+%` 则明确要求模运算，`maxInt(u32) +% 1 == 0` 是必须保留的语义，所以第二个函数仍要判断最大值，生成近似：

```asm
cmp     edi, -1
setne   al
ret
```

这是 ReleaseFast 真正的风险：优化器会把源码里的承诺当作推理前提，删除只有违约时才可能出现的分支。也因此，ReleaseFast 下偶然看见 `255 + 1` 打印为 `0`，并不能宣布普通 `+` 拥有回绕语义。那只是这份程序、这个目标、这次优化留下的现象；稍微换一个上下文，溢出的值可能根本不会被计算。

## ReleaseSmall：为体积关闭检查

ReleaseSmall 面向产物体积优化，默认同样关闭运行时安全检查。

这一点本身就值得停下来想一想。如果「关闭检查」只能解释为「ReleaseFast 为了速度牺牲安全」，那 ReleaseSmall 就没处安放了：它并不承诺最快，却用了相同的 safety 默认值。实际的关系是：

```text
优化目标 ≠ 安全检查策略
```

本机探针里，同一段除零代码在 ReleaseFast 下恰好打印 `0`，在 ReleaseSmall 下得到另一个无意义数值；命中 `unreachable` 的两个程序都以信号结束。这些输出不能外推成跨版本的结论，因为 Illegal Behavior 本来就没有规定结局。

## 同一段代码的四份输出

把几类 safety-checked Illegal Behavior 放在一起，本机 Zig 0.16.0 的观察如下：

| 行为 | Debug | ReleaseSafe | ReleaseFast | ReleaseSmall |
| --- | --- | --- | --- | --- |
| `u8` 普通加法溢出 | panic | panic | 本次为 `0` | 本次为 `0` |
| 数组越界 | panic | panic | 本次读到旧字节 | 本次为 `0` |
| 非法 enum tag | panic | panic | 本次打印无意义 tag | 本次相同 |
| 整数除零 | panic | panic | 本次为 `0` | 本次为不稳定值 |
| 命中 `unreachable` | panic | panic | 本次收到 SIGSEGV | 本次收到 SIGSEGV |

左边两列可以概括为规范行为：安全检查开启，失败触发 panic。右边两列只能概括出一件事：检查默认关闭，非法行为不受语言约束。表里的 `0`、垃圾值和信号都是这一次的观察结果，别当成语义去依赖。

## 编译期没有模式之分

非法行为若在编译期被求值，构建模式救不了它：

```zig
comptime {
    var value: u8 = 255;
    value += 1;
}
```

四种模式都会拒绝：

```text
error: overflow of integer type 'u8' with value '256'
```

除零、非法 enum tag、命中 `unreachable` 也一样。即使在块里写下：

```zig
@setRuntimeSafety(false);
```

编译期求值发现的 Illegal Behavior 仍然是编译错误。`@setRuntimeSafety` 控制的是运行时检查，不会给非法语义发放豁免；编译器在 comptime 拥有完整的值信息，能直接判定操作不合法，用不着等程序运行。

写实验探针时尤其要留意这一点：输入若全是编译期常量，你以为在对比四种运行时模式，实际测到的可能只是同一份编译错误。前面那些例子里 `_ = &value` 干的就是反向的事——把值留到运行时。

## `@setRuntimeSafety`：作用域级的开关

安全策略可以只对局部生效。Zig 0.16.0 提供：

```zig
@setRuntimeSafety(comptime safety_on: bool) void
```

它影响包含该调用的词法作用域。比如在 ReleaseFast 中局部重新打开检查：

```zig
pub fn main() void {
    @setRuntimeSafety(true);

    var value: u8 = 255;
    _ = &value;
    value += 1;
}
```

即使以 `-O ReleaseFast` 构建，仍会得到：

```text
panic: integer overflow
```

反方向也成立：可以在安全模式的某个作用域里写 `@setRuntimeSafety(false)`，关掉其中的检查。

两个细节值得记住。其一，它是词法作用域，不随调用传播：调用者打开安全检查，并不会让被调用的函数体也打开；内层块结束后，设置恢复到外层状态。要保证某个底层函数自身始终检查，就在那个函数的作用域里声明，别指望调用链上有人替你开。其二，语言参考注明未来计划用 `@optimizeFor` 替代这个内建函数；0.16.0 里它仍可用，但长期维护的库不宜围着当前名字建太多抽象。

局部开关适合测量之后处理明确的热点，也适合在不安全构建里守住特别敏感的边界。满代码地撒，只会让同一个模块的安全策略变得难以追踪。

## `assert`、`unreachable` 与 `panic` 的分工

三种写法都会让安全构建停下来，表达的意思并不相同。

### `unreachable`

```zig
if (state == .impossible) unreachable;
```

它向编译器宣告：合法执行永远不会抵达这里。安全检查开启时，抵达会 panic；检查关闭时，优化器可以直接使用这项前提。

### `std.debug.assert`

```zig
std.debug.assert(count <= capacity);
```

0.16.0 标准库里的 `assert` 在条件失败时本质上抵达 `unreachable`，所以它同样依赖 runtime safety。在 ReleaseFast 和 ReleaseSmall 下，不能把它当作必然执行的业务校验或权限检查。

### `@panic` 与 `std.debug.panic`

```zig
@panic("the invariant failed");
```

这是无条件调用 panic handler，与优化模式和 `@setRuntimeSafety` 都无关，四种模式都会执行它。`std.debug.panic` 在此之上提供格式化消息。

归纳一下：

| 写法 | 表达的意思 | 检查关闭后 |
| --- | --- | --- |
| `unreachable` | 此路径在合法程序中不可能发生 | 成为优化前提 |
| `std.debug.assert(cond)` | `cond` 必须为真，否则抵达 `unreachable` | 不能当作可靠业务检查 |
| `@panic(message)` | 无条件终止并调用 panic handler | 仍然执行 |

选用的标准：要向调用者报告可恢复的失败，返回 error；要无条件终止，就显式 panic；只有真正不可能发生的控制流，才写 `unreachable`。

## 把行为改成四种模式下都成立

前面所有问题的出口是同一个：把含糊或非法的操作改成明确语义。

需要回绕：

```zig
fn wrappingNext(value: u8) u8 {
    return value +% 1;
}
```

需要报告溢出：

```zig
fn checkedNext(value: u8) error{Overflow}!u8 {
    const result = @addWithOverflow(value, 1);
    if (result[1] != 0) return error.Overflow;
    return result[0];
}
```

需要处理外部索引：

```zig
fn parseIndex(text: []const u8, items: []const u8) !u8 {
    const index = try std.fmt.parseInt(usize, text, 10);
    if (index >= items.len) return error.IndexOutOfBounds;
    return items[index];
}
```

这些测试在四种模式下全部通过：

```zig
test "explicit semantics survive every build mode" {
    try std.testing.expectEqual(@as(u8, 0), wrappingNext(255));
    try std.testing.expectError(error.Overflow, checkedNext(255));
    try std.testing.expectError(
        error.IndexOutOfBounds,
        parseIndex("3", "abc"),
    );
}
```

```text
Debug:       All 1 tests passed.
ReleaseSafe: All 1 tests passed.
ReleaseFast: All 1 tests passed.
ReleaseSmall: All 1 tests passed.
```

`+%` 定义了回绕；`@addWithOverflow` 把溢出位变成普通数据；`parseIndex` 这样的边界校验把不可信输入变成业务能处理的 error。这三种写法在四种模式下含义一致，不再依赖检查是否开启。

## 检查依赖类型里保留的信息

运行时安全检查能查什么，取决于类型和操作里还剩多少信息。

切片带长度，所以 `slice[index]` 可以检查边界；取出 `slice.ptr` 之后只剩多项指针，原来的长度不再参与访问：

```zig
const ptr = slice.ptr;
const value = ptr[index];
```

索引若走出实际分配范围，Debug 不一定有足够信息判断。类似地，`@ptrCast` 可以改变指针声称的元素类型；若程序员给出的对齐、位模式或别名事实不成立，有些错误不会在发生点留下可插入的检查。

所以「Debug 能抓住」从来不是内存安全的证明。检查只覆盖语言明确定义为 safety-checked、且编译器仍掌握必要信息的行为。类型越早丢掉边界和对齐信息，检查能做的事就越少；到最后只剩一个裸地址时，再严格的构建模式也无法从数值本身还原它的来历。

## panic 不该进业务流程

假设网络协议用一个字节表示消息类型：

```zig
const Kind = enum(u8) {
    data = 1,
    close = 2,
};
```

下面这行把输入直接转成 enum：

```zig
const kind: Kind = @enumFromInt(input[0]);
```

未知值在 Debug 或 ReleaseSafe 中可能 panic：

```text
panic: invalid enum value
```

这不算自动完成了输入校验。ReleaseFast 默认没有这项检查；而且 malformed packet 本来就是正常业务世界的一部分，把它建模成程序内部的 Illegal Behavior，本身就是错的。正确做法是先验证：

```zig
fn parseKind(raw: u8) error{BadKind}!Kind {
    return switch (raw) {
        1 => .data,
        2 => .close,
        else => error.BadKind,
    };
}
```

panic 用来揭露程序违反自身不变量，error 用来表达调用者可以预见和处理的失败。判断哪个该用，有一条很实际的标准：如果业务正确性依赖某个 safety check 必须存在，那换一种构建模式，业务语义就会随编译选项一起消失。这说明该写的校验还没写进程序，得补的是代码。

## 工程上怎么安排

一种实用的安排：

- 日常开发用 Debug，编译快、检查全；
- CI 同时跑 Debug 和 ReleaseSafe 测试，覆盖优化开启后的安全构建；
- 生产环境按风险和性能测量，在 ReleaseSafe、ReleaseFast、ReleaseSmall 里选；
- 外部输入、权限和协议约束始终显式校验，不依赖 safety checks；
- 确认需要关闭检查的热点，先测量，再尽量局部处理；
- 必须保持检查的边界，当前版本里可以局部用 `@setRuntimeSafety(true)`。

还有一个坑要单独点名：不要只在 ReleaseFast 下运行一条故意触发 Illegal Behavior 的测试，然后以「没有崩溃」判定通过。同一条测试在 Debug 里 panic，在 ReleaseFast 里会显示：

```text
All 1 tests passed.
```

这行输出不代表代码通过了，只代表测试走出了语言能给结论的范围。测试应该验证合法语义：用 `expectError` 检查失败路径，用 `@addWithOverflow` 检查溢出，用显式边界分支检查拒绝路径。若确实要确认安全检查本身的 panic，把它作为工具链行为单独隔离，别让测试继续执行 unchecked Illegal Behavior。

## 结语

四种模式共用一套语言规则。Debug 的 panic 与 ReleaseFast 的沉默描述的是同一次非法行为；构建模式改变的，只是错误何时被看见，以及优化器拿「非法路径不会发生」这个前提做了什么。

落到写代码的优先级上：先把语义写对。需要回绕或需要检测溢出，语言各有对应的运算（`+%`、`@addWithOverflow`）；要拒绝外部输入，就返回 error 让调用方处理。安全检查是开发期的诊断工具，有成本，也有覆盖不到的地方，值得用测量决定取舍。`assert` 和 `unreachable` 是写给编译器的陈述；检查关闭后，它们从报警变成前提，落笔之前多想一秒。

下一篇讲 C 互操作。`[*c]T`、opaque handle、跨语言的生命周期，正好是类型信息不足、检查无从设置的现场。
