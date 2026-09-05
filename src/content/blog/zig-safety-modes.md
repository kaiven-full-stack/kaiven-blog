---
title: 法条只有一部，法庭有四座：Zig 的 Illegal Behavior
description: 同一段非法代码交给 Debug、ReleaseSafe、ReleaseFast 与 ReleaseSmall，会得到四份不同证词；不同的却是执法与优化，不是语言法条。本文从整数溢出、越界、unreachable 与局部安全开关出发，辨清 panic、沉默和优化器推理各自意味着什么。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-05
tags: [Zig, 编程语言]
---

一场审判，四种程序。

被告席上坐着的不是人，是一段代码。它说了一句看似寻常的话：

```zig
value += 1;
```

只是 `value` 已经等于 `255`，类型是 `u8`。这句加法没有地方可去。

把同一份源码交给 Zig 的四种构建模式，会得到不同结果。Debug 当庭中止，指出整数溢出；ReleaseSafe 一边优化，一边保留同样的检查；ReleaseFast 与 ReleaseSmall 不再设置这道运行时护栏。本机实验里，后两者恰好打印了 `0`。

若只看输出，很容易把四种模式误解为四部法律：有的禁止溢出，有的准许回绕。可 Zig 的法条从未改变。普通整数溢出在四种模式下都是 Illegal Behavior；变化的只是编译器是否在运行时设置检查，以及它会基于“非法路径不会发生”作出怎样的优化。

这个系列此前已经见过多次类似判词：越界访问、读错 union 字段、非法 enum tag、use-after-free。它们常在 Debug 下高声报警，在 ReleaseFast 下沉默。今天不再调查看见了什么，而是正式审理：Illegal Behavior 究竟意味着什么，四种模式各自做了什么，以及为什么“ReleaseFast 更快，所以不安全”只说中了表面。

案内代码与输出，均在 Zig 0.16.0 上复核。

## 开庭：四种模式不是一条安全滑杆

Zig 的四种优化模式可以先列成一张表：

| 模式 | 优化 | 运行时安全检查 | 主要取向 |
| --- | --- | --- | --- |
| Debug | 关闭 | 开启 | 编译快、便于调试 |
| ReleaseSafe | 开启 | 开启 | 优化与运行时检查并存 |
| ReleaseFast | 开启 | 关闭 | 运行性能 |
| ReleaseSmall | 面向体积优化 | 关闭 | 更小的产物 |

`Debug` 是默认模式。其余三种都是可复现构建模式，但 ReleaseSafe 与另外两种在安全检查上分道而行。

这里首先要拆掉一个常见等式：

```text
Debug      = 安全
Release    = 不安全
```

Zig 没有一个笼统的 “Release” 模式。ReleaseSafe 明明打开优化，也明明保留运行时安全检查；ReleaseSmall 关闭检查，目的却不是追求最快速度。

因此，安全检查与优化不是同一只旋钮。ReleaseSafe 已经证明，两者可以同时打开；ReleaseSmall 又证明，关闭检查并不只服务于“更快”。

四种模式真正组成的是两条轴：怎样优化，以及是否为 safety-checked Illegal Behavior 设置运行时检查。

## 法条原文：Illegal Behavior 不是“必然崩溃”

Zig 0.16.0 的语言参考把 Illegal Behavior 分成两类。

第一类是 **safety-checked Illegal Behavior**。编译器能够在潜在出错的位置插入检查；检查失败时，程序 panic。大多数 Illegal Behavior 属于这一类，例如：

- 普通整数运算溢出；
- 数组或切片越界；
- 整数除以零；
- 解开一个错误值或 `null`；
- 访问 union 的非活跃字段；
- 把无对应 tag 的整数转成穷尽 enum；
- `@alignCast` 的地址不满足对齐；
- 控制流抵达 `unreachable`。

第二类是 **unchecked Illegal Behavior**。编译器没有足够信息在运行时检查。例如经过某些指针转换以后，边界、对齐或别名事实已经不在类型里，检查也就无从设置。

这两类一旦真正发生，语言都不再约束程序后果。区别只在于前者通常有机会在发生前被运行时检查按住。

语言参考还有一句更关键的话：当 safety checks 被关闭，safety-checked Illegal Behavior 会像 unchecked Illegal Behavior 一样处理。

所以 ReleaseFast 并不是把溢出改成“允许回绕”，也不是把越界改成“尽量读一下”。它只撤掉运行时检查。非法行为一旦发生，可能崩溃，可能打印一个似乎合理的数，可能破坏别处数据，也可能被优化器改写成完全出人意料的控制流。

非法行为不是一种确定的坏结果，而是语言停止担保结果的边界。

## 第一位证人：Debug 当场指出违约

让加法在运行时发生：

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

读错 tagged union 字段，则会精确列出想读的字段和实际 active field：

```text
panic: access of union field 'online' while field 'backoff' is active
```

Debug 的价值不只在于程序停了，还在于错误被固定在第一次可检测的违约处。没有这道检查，错误可能继续传播，等到稍后崩溃时，调用栈和数据都已离真正原因很远。

但 Debug 也不是语言保证本身。此前 `undefined` 文章里见过的 `0xAA`，只是当前实现用于显影未初始化内存的手段；换一个版本或后端，未必仍用同样的字节。法条保证的是读取无效，制服是什么颜色，则属于实现。

## 第二位证人：ReleaseSafe 一边优化，一边执法

把同一个溢出程序改用 ReleaseSafe：

```text
panic: integer overflow
```

判词没有改变。区别在于编译器已经打开优化。

对一条运行时普通加法，ReleaseSafe 可能生成近似这样的机器指令：

```asm
add     al, 1
jb      overflow_panic
```

一次加法，一次根据进位标志跳转。检查有成本，而且成本并不神秘：额外分支、panic 路径和相应元数据，都可以在生成代码中看见，也可以在基准测试里测量。

这使 ReleaseSafe 成为完全正当的发布模式，而非“带着训练轮的 Debug”。它适合那些愿意以部分体积和性能换取运行时诊断的生产环境，也适合 CI 中检验优化后代码。

不过名字里的 Safe 不能被读成“程序结果已经安全”。它只表示 Zig 默认保留 safety checks。

若一段非法行为不在可检查范围内，ReleaseSafe 仍无能为力；若程序把网络输入直接交给 `@enumFromInt`，panic 也只是开发错误暴露，不是合格的协议拒绝；若代码逻辑本身把金额算错，所有内存访问都可能完全合法。

程序正义只能审理它有管辖权的条款。

## 第三位证人：ReleaseFast 会采信你的前提

ReleaseFast 最容易被误解成“去掉检查后照旧执行”。这个模型不够准确。

看两个只差一个字符的函数：

```zig
export fn ordinaryIsGreater(x: u32) bool {
    return x + 1 > x;
}

export fn wrappingIsGreater(x: u32) bool {
    return x +% 1 > x;
}
```

普通 `+` 承诺运算不会溢出。于是对所有合法输入，`x + 1 > x` 恒为真。ReleaseFast 可以把第一个函数折叠成：

```asm
mov     al, 1
ret
```

`x` 是多少已经不重要。若 `x == maxInt(u32)`，程序早已越过合法语义的边界；编译器不必为这条路径保留回绕后的比较。

`+%` 则明确要求模运算。`maxInt(u32) +% 1 == 0` 是合法且必须保留的语义，所以第二个函数仍要判断最大值，生成近似：

```asm
cmp     edi, -1
setne   al
ret
```

危险因此不只是“没人检查伪证”。优化器还会把源码中的承诺当成推理前提，删除那些只有违约时才可能出现的分支。

这也是为什么 ReleaseFast 下偶然看见 `255 + 1` 打印为 `0`，不能宣布普通 `+` 拥有回绕语义。那只是这份程序、这个目标、这次优化留下的现象。稍微换一个上下文，溢出的值可能根本不会被计算。

## 第四位证人：ReleaseSmall 撤掉护栏，不是为了最快

ReleaseSmall 面向产物体积优化，默认同样关闭运行时安全检查。

这点很有解释力。如果问题只是“ReleaseFast 为了速度牺牲安全”，ReleaseSmall 便显得无处安放：它并不承诺最快，却采用相同的 safety 默认值。

真正的关系是：

```text
优化目标 ≠ 安全检查策略
```

本机探针中，同一段除零代码在 ReleaseFast 下恰好打印 `0`，在 ReleaseSmall 下却得到另一个无意义数值；命中 `unreachable` 的两个程序都以信号结束。这些输出不能成为跨版本结论，恰恰因为 Illegal Behavior 没有规定结局。

ReleaseSmall 的价值在于揭穿一个过分顺口的故事：不安全不是“跑得更快”的另一种说法。它来自对运行时检查的选择，也来自优化器对合法程序前提的使用。

## 交叉质证：同一段代码的四份输出

把几类 safety-checked Illegal Behavior 放在一起，本机 Zig 0.16.0 的观察如下：

| 行为 | Debug | ReleaseSafe | ReleaseFast | ReleaseSmall |
| --- | --- | --- | --- | --- |
| `u8` 普通加法溢出 | panic | panic | 本次为 `0` | 本次为 `0` |
| 数组越界 | panic | panic | 本次读到旧字节 | 本次为 `0` |
| 非法 enum tag | panic | panic | 本次打印无意义 tag | 本次相同 |
| 整数除零 | panic | panic | 本次为 `0` | 本次为不稳定值 |
| 命中 `unreachable` | panic | panic | 本次收到 SIGSEGV | 本次收到 SIGSEGV |

左两列可以概括为规范行为：安全检查开启，失败触发 panic。

右两列只能概括为一件事：安全检查默认关闭，非法行为不再受语言约束。表中的 `0`、垃圾值和信号都是观察，不是承诺。

四份证词看似互相冲突，其实冲突来自一个错误问题。若问“非法代码应当输出什么”，语言没有答案；若问“哪种模式默认设置检查”，答案则十分明确。

不要从一次非法执行里归纳新语义。现象不是判例。

## 编译期：四座法庭共用一道门槛

若非法行为在编译期被求值，构建模式救不了它：

```zig
comptime {
    var value: u8 = 255;
    value += 1;
}
```

Debug、ReleaseSafe、ReleaseFast 与 ReleaseSmall 都会拒绝：

```text
error: overflow of integer type 'u8' with value '256'
```

除零、非法 enum tag 和命中 `unreachable` 也一样。即使在块中写下：

```zig
@setRuntimeSafety(false);
```

编译期求值发现的 Illegal Behavior 仍然是编译错误。

这是因为 `@setRuntimeSafety` 控制运行时检查，不是给非法语义发放特赦。编译器在 comptime 拥有更完整的值信息，能够直接判定操作不合法，自然无需等程序运行后再插入护栏。

写测试探针时尤其要留意这一点。若输入是编译期常量，原本想观察四种运行时模式，最后测到的可能只是同一份编译错误。要检验运行时检查，必须让关键值真正留到运行时。

## 局部开庭：`@setRuntimeSafety`

安全策略不必只能按整个产物选择。Zig 0.16.0 提供：

```zig
@setRuntimeSafety(comptime safety_on: bool) void
```

它影响包含该调用的词法作用域。例如在 ReleaseFast 中局部重新打开检查：

```zig
pub fn main() void {
    @setRuntimeSafety(true);

    var value: u8 = 255;
    _ = &value;
    value += 1;
}
```

即使用 `-O ReleaseFast` 构建，仍会得到：

```text
panic: integer overflow
```

反方向也成立：可以在安全模式的某个作用域内写 `@setRuntimeSafety(false)`，关闭其中的检查。

但它是词法作用域，不是动态上下文。调用者打开安全检查，不会自动让另一个函数体也打开；内层块结束后，设置恢复到外层状态。若要保证某个底层函数自身始终检查，应在那个函数的作用域中声明，而不是寄望调用栈上传来一项气氛。

语言参考还注明，未来计划由 `@optimizeFor` 替代 `@setRuntimeSafety`。0.16.0 中它仍可用，但长期维护的库不宜围绕当前名字建立过多抽象。

局部开关适合经过测量后处理明确热点，也适合在不安全构建里守住特别敏感的边界。它不适合撒遍代码，令同一个模块的安全策略变成难以追踪的暗线。

## `assert`、`unreachable` 与 `panic` 不是同一句话

三种写法都会让安全构建停下来，却表达不同含义。

### `unreachable`

```zig
if (state == .impossible) unreachable;
```

它向编译器宣告：合法执行永远不会抵达这里。安全检查开启时，抵达会 panic；检查关闭时，优化器可以直接使用这项前提。

### `std.debug.assert`

```zig
std.debug.assert(count <= capacity);
```

0.16.0 标准库中的 `assert` 本质上在条件失败时抵达 `unreachable`。因此它同样依赖 runtime safety。ReleaseFast 与 ReleaseSmall 下，不应把它当作必然执行的业务校验或权限检查。

### `@panic` 与 `std.debug.panic`

```zig
@panic("the invariant failed");
```

这是无条件调用 panic handler，与优化模式以及 `@setRuntimeSafety` 无关。四种模式都会执行它。`std.debug.panic` 则提供格式化消息。

可以简要归纳：

| 写法 | 表达的意思 | 检查关闭后 |
| --- | --- | --- |
| `unreachable` | 此路径在合法程序中不可能发生 | 成为优化前提 |
| `std.debug.assert(cond)` | `cond` 必须为真，否则抵达 `unreachable` | 不能当作可靠业务检查 |
| `@panic(message)` | 无条件终止并调用 panic handler | 仍然执行 |

需要向调用者报告可恢复失败，就返回 error；需要无条件终止，就显式 panic；只有真正不可能发生的控制流，才写 `unreachable`。

## 改写证词：让行为在四种模式下都合法

最可靠的修正，不是选择一座更严格的法庭，而是把含糊或非法的操作改成明确语义。

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

`+%` 并不是“关闭溢出检查的普通加法”，而是另一种合法运算；`@addWithOverflow` 也不是等待 panic，而是把溢出位变成普通数据。边界校验返回 error，则把不可信输入转成业务可以处理的结果。

安全检查适合发现程序员违反前提，显式语义负责定义前提不成立时该怎么办。

## 证据一旦被抹去，Debug 也无法追问

运行时安全检查依赖类型与操作中仍保留的信息。

切片拥有长度，所以 `slice[index]` 可以检查边界；取出 `slice.ptr` 以后，只剩多项指针，原来的长度不再参与访问：

```zig
const ptr = slice.ptr;
const value = ptr[index];
```

若索引走出实际分配范围，Debug 不一定有足够信息判断。

类似地，`@ptrCast` 可以改变指针所声称的元素类型；若程序员提供的对齐、有效位模式或别名事实不成立，有些错误不会在发生点留下可插入的检查。

所以“Debug 能抓住”从来不是内存安全证明。检查只覆盖语言明确定义为 safety-checked、且编译器仍掌握必要信息的行为。

类型越早丢失边界与对齐信息，法庭能调取的证据就越少。最后只剩一个裸地址时，再严厉的运行模式也无法从数值本身还原它的来历。

## 不要让 panic 进入业务流程

假设网络协议用一个字节表示消息类型：

```zig
const Kind = enum(u8) {
    data = 1,
    close = 2,
};
```

下面的代码把输入直接转成 enum：

```zig
const kind: Kind = @enumFromInt(input[0]);
```

未知值在 Debug 或 ReleaseSafe 中可能 panic：

```text
panic: invalid enum value
```

这不是“自动完成了输入校验”。ReleaseFast 默认没有这项检查，而且 malformed packet 本来就是正常业务世界的一部分，不应被描述成程序内部的 Illegal Behavior。

正确做法是先验证：

```zig
fn parseKind(raw: u8) error{BadKind}!Kind {
    return switch (raw) {
        1 => .data,
        2 => .close,
        else => error.BadKind,
    };
}
```

panic 用来揭露程序违反自身不变量；error 用来表达调用者可以预见和处理的失败。两者都可能终止当前路径，却属于完全不同的控制流契约。

如果业务正确性依赖某个 safety check 必须存在，那么换一种构建模式时，业务语义就会随编译选项一起消失。这通常说明该写的校验尚未写进程序。

## 四种模式，怎样进入工程流程

一种实用安排是：

- 日常开发使用 Debug，获得快速编译和完整检查；
- CI 同时运行 Debug 与 ReleaseSafe 测试，覆盖优化开启后的安全构建；
- 生产环境按风险与性能测量，在 ReleaseSafe、ReleaseFast 或 ReleaseSmall 中选择；
- 对外部输入、权限和协议约束始终显式校验，不依赖 safety checks；
- 对确认需要关闭检查的热点，先测量，再尽量局部处理；
- 对必须保持检查的边界，可在当前版本中局部使用 `@setRuntimeSafety(true)`。

尤其不要只在 ReleaseFast 下运行一条故意触发 Illegal Behavior 的测试，然后以“没有崩溃”判定通过。相同测试在 Debug 中可能 panic，在 ReleaseFast 中却显示：

```text
All 1 tests passed.
```

那不是代码通过了审理，而是测试主动走出了语言能给结论的范围。

测试应验证合法语义：用 `expectError` 检查失败，用 `@addWithOverflow` 检查溢出，用显式边界分支检查拒绝路径。若需要确认安全检查本身的 panic，应把它作为工具链行为单独隔离，不让测试继续执行 unchecked Illegal Behavior。

## 判决之前

**四种模式共用一部语言规则。** Debug 的 panic 与 ReleaseFast 的沉默不代表同一操作忽然合法。构建模式选择的是优化和执法方式，不是重写整数范围、数组边界与 active field。

**ReleaseSafe 的 Safe 有范围。** 它保留 safety checks，不保证业务正确，不补回已经被指针转换丢掉的信息，也不替外部输入生成 error。

**ReleaseFast 的危险不止是少了检查。** 优化器可以把“非法行为不会发生”作为推理前提，删除只在违约路径上有意义的代码。偶然回绕、偶然崩溃和偶然正常都不能成为依赖。

**显式语义比构建模式可靠。** `+%`、`@addWithOverflow`、普通 error 与边界判断在四种模式下仍有同一含义。它们解决的是程序要做什么，而不是出错以后谁来报警。

**安全检查有成本，也有管辖边界。** 应测量成本，而不是凭习惯拆除；也应承认它无法检查已经失去类型证据的错误。护栏很有价值，却从来不是道路本身。

---

庭审记录最后没有选出一座永远正确的法庭。

Debug 提供最直接的现场，ReleaseSafe 让优化与检查同席，ReleaseFast 接受更强的合法性前提，ReleaseSmall 则把体积放在首位。四种程序各有用途，但没有任何一种能把非法行为变成可靠技巧。

真正的判决往往早在运行以前写进源码。普通 `+` 说溢出不会发生，`+%` 说溢出必须回绕；`unreachable` 说控制流绝不会抵达，error 则说失败本来就在预料之中。编译器只是按这些陈述继续推理。

若陈述真实，优化与检查各尽其职；若陈述虚假，换一座法庭只能改变错误何时被看见，不能改变它已经越过语言边界的事实。

书记员合上记录。最后一行只写了一句话：安全模式决定是否当庭报警，程序员决定有没有作出一份可以兑现的陈述。
