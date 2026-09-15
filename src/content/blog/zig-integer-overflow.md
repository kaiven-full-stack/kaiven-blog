---
title: 255 + 1 等于什么：Zig 怎么处理整数溢出
description: 数学里是 256，u8 只有八位。Zig 没有替所有加法规定同一种结局，而是把回绕、饱和与越界检查分别写进操作符。示例都在 Zig 0.16.0 上跑过。
pubDate: 2026-09-04
category: zig
tags: [Zig, 编程语言]
---

`u8` 能表示的最大值是 255。再往前一步，数学仍有路，机器留给它的八个二进制位却已经走完了。那么，`255 + 1` 应该等于什么？

256，是数学的回答；0，是回绕算术的回答；255，是饱和算术的回答；「这里不该继续」，也是一种回答。它们都自有道理。真正危险的，是代码已经替你选了其中一种，写代码的人却不知道。

Zig 在这件事上的做法，是把三种结局分别写进三枚操作符。普通加法、回绕加法、饱和加法，各有各的写法；你想走哪条路，要在源码上写清楚。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="255 + 1 的四种答案：数学纸面上是 256，comptime_int 装得下；回绕算术给 0，对应百分号操作符；饱和算术停在 255，对应竖线操作符；普通加号宣称不该越过，安全检查开启时 panic，关闭时是非法行为" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ioA1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="240" y="14" width="180" height="40" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.5"/>
<text class="t" x="330" y="40" text-anchor="middle" font-size="13" fill="#2b2a26">u8: 255 + 1 = ?</text>
<line class="fl" x1="270" y1="54" x2="100" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ioA1)"/>
<line class="fl" x1="310" y1="54" x2="252" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ioA1)"/>
<line class="fl" x1="350" y1="54" x2="408" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ioA1)"/>
<line class="fl" x1="390" y1="54" x2="562" y2="86" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ioA1)"/>
<rect class="bx-q" x="20" y="90" width="148" height="80" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="94" y="114" text-anchor="middle" font-size="13" fill="#2b2a26">256</text>
<text class="ts" x="94" y="134" text-anchor="middle" font-size="9" fill="#6b675e">数学纸面的答案</text>
<text class="ts" x="94" y="150" text-anchor="middle" font-size="9" fill="#6b675e">comptime_int 装得下</text>
<rect class="bx-q" x="178" y="90" width="148" height="80" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="252" y="114" text-anchor="middle" font-size="13" fill="#2b2a26">0</text>
<text class="ts" x="252" y="134" text-anchor="middle" font-size="9" fill="#6b675e">回绕算术 · a +% b</text>
<text class="ts" x="252" y="150" text-anchor="middle" font-size="9" fill="#6b675e">按位宽取模，从头再来</text>
<rect class="bx-q" x="336" y="90" width="148" height="80" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="410" y="114" text-anchor="middle" font-size="13" fill="#2b2a26">255</text>
<text class="ts" x="410" y="134" text-anchor="middle" font-size="9" fill="#6b675e">饱和算术 · a +| b</text>
<text class="ts" x="410" y="150" text-anchor="middle" font-size="9" fill="#6b675e">停在上限不动</text>
<rect class="bx-sick" x="494" y="90" width="148" height="80" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="568" y="114" text-anchor="middle" font-size="11" fill="#b03a2e">不该继续</text>
<text class="ts" x="568" y="134" text-anchor="middle" font-size="9" fill="#6b675e">普通 a + b 的承诺</text>
<text class="ts" x="568" y="150" text-anchor="middle" font-size="9" fill="#6b675e">安全构建 panic</text>
<text class="ts" x="20" y="198" font-size="10" fill="#6b675e">四种答案都自有道理，危险的是代码替你选了一种而你不知道：Zig 要求把选择写进操作符</text>
</svg>
</figure>

上一篇写 `undefined`，谈的是一个值尚未来到以前，那块内存算什么；这一篇往后跨一步：值已经在手里，却要越过类型的边界，又该算什么。代码全部在 Zig 0.16.0 上验证过。

## 八位装不下第九位

先写最寻常的加法。为了不让编译器提前算出答案，`x` 从命令行读进来：

```zig
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    var args = init.minimal.args.iterate();
    _ = args.next();
    const text = args.next() orelse "255";
    const x = try std.fmt.parseInt(u8, text, 10);
    const y = x + 1;
    std.debug.print("{d} + 1 = {d}\n", .{ x, y });
}
```

Debug 构建下运行：

```text
$ zig run overflow.zig -O Debug -- 255
thread panic: integer overflow
overflow.zig:8:17: in main
    const y = x + 1;
                ^
```

ReleaseSafe 也是同样的结局。这枚小小的 `+` 自带一份承诺：结果必须仍能由操作数的类型表示。255 加一不再属于 `u8`，承诺当场破裂，安全检查就在越界处把程序按住。

把四种构建模式都跑一遍，本机的结果是这样的：

| 构建模式 | 本机现象 | 语言层面的结论 |
| --- | --- | --- |
| Debug | panic: integer overflow | 开启运行时安全检查，越界被捕获 |
| ReleaseSafe | panic: integer overflow | 开启运行时安全检查，越界被捕获 |
| ReleaseFast | 本机打印成了 `000`，连格式也已不可信 | 安全检查关闭，普通整数溢出是非法行为 |
| ReleaseSmall | 打印出 0 | 安全检查关闭，普通整数溢出是非法行为 |

后两行最容易诱人写下一句错话：「ReleaseFast 里的 `+` 会回绕。」

不会。至少，Zig 从未给过这份保证。

0 只是这台机器、这个版本、这段上下文里的一次现象。程序既然踏进了非法行为，编译器便可以相信那一步永远不会发生，并据此改写后面的路。上一篇的 `undefined` 像一张空白支票；这里的普通溢出更像越过地图边缘——地图背面没有另一片叫作 0 的土地，只是语言不再替你标路。

若你确实要回到 0，应该把这件事写出来。

## 三枚操作符，三种语义

Zig 给整数加法备了三枚操作符：

| 写法 | 名字 | 越界时发生什么 |
| --- | --- | --- |
| `a + b` | 普通加法 | 溢出是非法行为；安全检查开启时 panic |
| `a +% b` | 回绕加法 | 按二进制补码截回类型位宽 |
| `a +| b` | 饱和加法 | 停在类型能够表示的上限或下限 |

把三条路放在一起看：

```zig
const std = @import("std");

pub fn main() void {
    const x: u8 = 255;

    std.debug.print("wrap: {d}\n", .{x +% 1});
    std.debug.print("saturate: {d}\n", .{x +| 1});
}
```

输出没有悬念：

```text
wrap: 0
saturate: 255
```

`%` 很小，但它的信息量不小：这次归零是有意为之，作者知道会越界，准许它从头再来。

这种语义在序列号、环形计数器、哈希算法和密码学代码里并不少见。机器整数本来就是有限位宽，回绕有时恰恰是算法的一部分。Zig 不反对回绕；它反对的是一段代码发生了回绕，源码上却看不出这一点。

`+|` 是另一种语义。音量已经到 100，再按一次加号仍是 100；游戏角色的生命值已经加满，再多一瓶药也不能冲破上限。对有符号整数，两端都守得住：

```zig
const hi: i8 = 127;
const lo: i8 = -128;

std.debug.print("{d} {d}\n", .{ hi +| 1, lo -| 1 });
```

```text
127 -128
```

回绕、饱和、普通加法，三个符号各对应一种数学。减法和乘法也各有同一套家族：`-%`、`*%` 负责回绕，`-|`、`*|` 负责饱和。左移稍有不同：普通 `<<` 本来就会截掉越过位宽的高位，需要饱和时才另有 `<<|`。Zig 没有发明溢出，只是不再让它藏在默认规则里。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 206" role="img" aria-label="u8 数轴上的三种加法：从 255 出发，回绕加法沿顶部弧线回到 0；饱和加法停在 255 原地；普通加法不许越线，安全构建下 panic，检查关闭时是非法行为" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ioA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="ioA2c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="40" y="24" font-size="10.5" fill="#6b675e">u8 的值域：0 .. 255</text>
<line class="axis" x1="40" y1="112" x2="620" y2="112" stroke="#a29d90" stroke-width="1.4"/>
<line class="axis" x1="60" y1="106" x2="60" y2="118" stroke="#a29d90" stroke-width="1.4"/>
<text class="ts" x="60" y="134" text-anchor="middle" font-size="10" fill="#2b2a26">0</text>
<line class="axis" x1="580" y1="106" x2="580" y2="118" stroke="#a29d90" stroke-width="1.4"/>
<text class="ts" x="580" y="134" text-anchor="middle" font-size="10" fill="#2b2a26">255</text>
<path class="fl" d="M 574 100 C 420 30 180 30 68 100" fill="none" stroke="#6b675e" stroke-width="1.4" marker-end="url(#ioA2)"/>
<text class="ts" x="320" y="44" text-anchor="middle" font-size="10" fill="#2b2a26">+% 回绕：255 的下一步是 0</text>
<path class="fl" d="M 588 104 C 626 92 626 140 592 142" fill="none" stroke="#6b675e" stroke-width="1.3" marker-end="url(#ioA2)"/>
<text class="ts" x="500" y="160" text-anchor="middle" font-size="10" fill="#2b2a26">+| 饱和：停在 255</text>
<line class="flc" x1="566" y1="120" x2="500" y2="182" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ioA2c)"/>
<text class="tc" x="300" y="188" font-size="10" fill="#b03a2e">普通 +：这条线不该被越过 —— 安全构建 panic，检查关闭即非法行为</text>
</svg>
</figure>

## 既要结果，也要知道越过了线

还有一种场景，不肯在回绕和报错之间二选一：结果照常取回，但边界是否被越过，也要记一笔。

`@addWithOverflow` 做的正是这件事：

```zig
const std = @import("std");

fn advance(seq: *u8) bool {
    const next = @addWithOverflow(seq.*, 1);
    seq.* = next[0];
    return next[1] == 1;
}

pub fn main() void {
    var seq: u8 = 254;
    for (0..3) |_| {
        const crossed = advance(&seq);
        std.debug.print("seq={d}, crossed={any}\n", .{ seq, crossed });
    }
}
```

输出：

```text
seq=255, crossed=false
seq=0, crossed=true
seq=1, crossed=false
```

它返回的是 `struct { u8, u1 }`：第一项是回绕后的结果，第二项是一位宽的溢出标志。边界没有被藏起来，也没有擅自替你 panic；函数拿到两份事实，接下来是报错、计数、重试，还是容许序列号翻篇，都由调用方决定。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="addWithOverflow 的返回结构：u8 的回绕结果加 u1 的溢出标志；seq 从 254 起步三轮演示，254 加 1 得 255 标志 0，255 加 1 回绕成 0 标志 1，0 加 1 得 1 标志 0" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="ioA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="20" y="24" width="220" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="130" y="44" text-anchor="middle" font-size="9.5" fill="#2b2a26">@addWithOverflow(seq.*, 1)</text>
<text class="ts" x="130" y="62" text-anchor="middle" font-size="9" fill="#6b675e">结果与事实一起交回</text>
<line class="fl" x1="240" y1="48" x2="286" y2="48" stroke="#6b675e" stroke-width="1.3" marker-end="url(#ioA3)"/>
<rect class="bx" x="290" y="20" width="200" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="390" y="40" text-anchor="middle" font-size="9.5" fill="#2b2a26">struct { u8, u1 }</text>
<text class="ts" x="390" y="57" text-anchor="middle" font-size="9" fill="#6b675e">[0] 回绕后的结果</text>
<text class="ts" x="390" y="71" text-anchor="middle" font-size="9" fill="#6b675e">[1] 越界标志，只占一位</text>
<text class="ts" x="510" y="42" font-size="9" fill="#6b675e">越界这件事</text>
<text class="ts" x="510" y="58" font-size="9" fill="#6b675e">成了一个普通的值</text>
<rect class="bx-q" x="20" y="110" width="190" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="115" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">seq 254 → 255</text>
<text class="ts" x="115" y="146" text-anchor="middle" font-size="9" fill="#6b675e">crossed = false</text>
<line class="fl" x1="210" y1="132" x2="236" y2="132" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ioA3)"/>
<rect class="bx-sick" x="240" y="110" width="190" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="335" y="128" text-anchor="middle" font-size="9.5" fill="#b03a2e">seq 255 → 0</text>
<text class="ts" x="335" y="146" text-anchor="middle" font-size="9" fill="#6b675e">crossed = true</text>
<line class="fl" x1="430" y1="132" x2="456" y2="132" stroke="#6b675e" stroke-width="1.2" marker-end="url(#ioA3)"/>
<rect class="bx-q" x="460" y="110" width="180" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="550" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">seq 0 → 1</text>
<text class="ts" x="550" y="146" text-anchor="middle" font-size="9" fill="#6b675e">crossed = false</text>
<text class="ts" x="20" y="184" font-size="9.5" fill="#6b675e">序列号翻篇还是当场报错，标志只报告事实，决定权在业务</text>
</svg>
</figure>

这和前几篇看见的思路是同一脉。错误是值，Allocator 是参数，`undefined` 是契约；到了整数这里，连「越界过没有」也可以只是一个值。语言提供原语，业务判断留给调用方。

## 编译期没有侥幸

如果两个数在编译期已知，编译器不会等到程序运行再处理。

```zig
const x: u8 = 255;
const y = x + 1;

pub fn main() void {
    _ = y;
}
```

编译直接失败：

```text
error: overflow of integer type 'u8' with value '256'
const y = x + 1;
          ~~^~~
```

这里有一层容易混淆的差别。Zig 的整数字面量起初是 `comptime_int`，没有固定的机器位宽：

```zig
const mathematical = 255 + 1;
```

这个结果安然无恙，仍是 256。编译器没有变宽容；`mathematical` 还活在编译期整数的广阔纸面上。等你写下 `const x: u8 = 255`，边界才真正划定；随后那个普通 `+` 必须服从 `u8` 的范围。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 170" role="img" aria-label="同一笔 255+1 的两种处境：写在 comptime_int 上，纸面没有位宽，结果 256 安然无恙；一旦标注 u8，边界划在八位，普通加号在编译期直接报 overflow 错误" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<rect class="bx-q" x="20" y="26" width="300" height="92" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="170" y="48" text-anchor="middle" font-size="10" fill="#2b2a26">comptime_int · 纸面没有位宽</text>
<text class="ts" x="170" y="72" text-anchor="middle" font-size="9.5" fill="#6b675e">const mathematical = 255 + 1;</text>
<text class="ts" x="170" y="94" text-anchor="middle" font-size="10" fill="#2b2a26">= 256 ✓</text>
<rect class="bx-sick" x="350" y="26" width="290" height="92" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="495" y="48" text-anchor="middle" font-size="10" fill="#b03a2e">u8 · 边界划在八位</text>
<text class="ts" x="495" y="72" text-anchor="middle" font-size="9.5" fill="#6b675e">const x: u8 = 255; const y = x + 1;</text>
<text class="ts" x="495" y="94" text-anchor="middle" font-size="9" fill="#b03a2e">error: overflow of 'u8' with value '256'</text>
<text class="ts" x="20" y="148" font-size="10" fill="#6b675e">同样是 255 + 1：一个还写在纸上，一个已经住进八位的格子；类型标注划定边界的那一刻，检查随之生效</text>
</svg>
</figure>

这也意味着两个 `u8` 相加，结果仍是 `u8`，不会像 C 的整数提升那样先偷偷扩成 `int`。若结果本来就可能需要第九位，类型应当先把位置让出来：

```zig
const a: u8 = 200;
const b: u8 = 100;
const sum: u16 = @as(u16, a) + @as(u16, b);
```

结果需要多宽，源码先说；编译器不替你临时征地。

## u3：位宽贴着问题定

八位、十六位、三十二位，是硬件留下的整齐刻度，却不一定是问题本身的刻度。三个二进制位能表示 0 到 7，Zig 就允许类型写成 `u3`：

```zig
var n: u3 = 0;
for (0..10) |_| {
    std.debug.print("{d} ", .{n});
    n +%= 1;
}
```

```text
0 1 2 3 4 5 6 7 0 1
```

边界和回绕都清清楚楚：不用先拿一个 `u8`，再靠注释提醒「这里只用低三位」；类型本身就是三位，操作符本身就说会回绕。Zig 支持一直到 65535 位的有符号和无符号整数，协议字段、位图、硬件寄存器因此可以按真实宽度建模。

不过，位宽不等于普通内存里的占用。这个实验同样重要：

```zig
std.debug.print("bits={d}, size={d}\n", .{
    @bitSizeOf(u3),
    @sizeOf(u3),
});
```

```text
bits=3, size=1
```

`u3` 的值域只有三位，单独存放时仍占一个字节。要让字段在内存里真正逐位紧挨，需要 `packed struct`：

```zig
const Header = packed struct {
    kind: u3,
    urgent: u1,
    length: u12,
};

std.debug.print("bits={d}, size={d}\n", .{
    @bitSizeOf(Header),
    @sizeOf(Header),
});
```

```text
bits=16, size=2
```

整数宽度负责表达值域，是否紧密排布则是内存布局的事。两件相邻的事，Zig 没有替你混成一件。

## 一条加法，在汇编里留下什么

显式通常要付语法的价，未必总要付运行时的价。我把三种 `u32` 加法单独编成函数，用 ReleaseFast 看了反汇编：

```zig
export fn wrappingAdd(a: u32, b: u32) u32 {
    return a +% b;
}

export fn saturatingAdd(a: u32, b: u32) u32 {
    return a +| b;
}

export fn ordinaryAdd(a: u32, b: u32) u32 {
    return a + b;
}
```

`wrappingAdd` 和关闭安全检查的 `ordinaryAdd` 都落成同一条有效加法：

```asm
lea eax, [rdi + rsi]
ret
```

CPU 的寄存器本来就会截掉装不下的高位，`+%` 没有为了「显式」多付一轮判断。它只是把硬件原本会做的事，提升成语言保证。

饱和加法多了条件选择：

```asm
add   edi, esi
mov   eax, -1
cmovae eax, edi
ret
```

先做加法；若无进位，取正常结果；若有进位，留下 `0xffffffff`，也就是 `u32` 的上限。语义确实更多，指令也如实更多。

ReleaseSafe 下的普通 `+` 则是另一份账：

```asm
add edi, esi
jb  overflow_panic
```

一条加法，一次溢出分支。护栏有价格，但没有隐藏价格。选择 ReleaseFast，拆掉的是这段检查，不是把 `+` 的承诺改写成 `+%`。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 238" role="img" aria-label="三种加法在汇编里的账单：回绕加法与关闭检查的普通加法都只落成一条 lea；饱和加法多一条 add 与条件选择 cmovae；ReleaseSafe 的普通加法多一条越界跳转 jb overflow_panic" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<rect class="bx-q" x="20" y="20" width="200" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="38" text-anchor="middle" font-size="9.5" fill="#2b2a26">a +% b · ReleaseFast</text>
<text class="ts" x="120" y="54" text-anchor="middle" font-size="8.5" fill="#6b675e">回绕</text>
<rect class="bx-q" x="240" y="20" width="400" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="256" y="38" font-size="9" fill="#2b2a26">lea eax, [rdi + rsi] · ret</text>
<text class="ts" x="256" y="54" font-size="8.5" fill="#6b675e">一条有效指令：硬件截断正好就是回绕语义</text>
<rect class="bx-q" x="20" y="70" width="200" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="88" text-anchor="middle" font-size="9.5" fill="#2b2a26">a + b · ReleaseFast</text>
<text class="ts" x="120" y="104" text-anchor="middle" font-size="8.5" fill="#6b675e">普通（检查已关）</text>
<rect class="bx-sick" x="240" y="70" width="400" height="42" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/>
<text class="ts" x="256" y="88" font-size="9" fill="#b03a2e">lea eax, [rdi + rsi] · ret</text>
<text class="ts" x="256" y="104" font-size="8.5" fill="#6b675e">与 +% 一字不差：拆掉的是检查，不是把承诺改成回绕</text>
<rect class="bx-q" x="20" y="120" width="200" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="138" text-anchor="middle" font-size="9.5" fill="#2b2a26">a +| b · ReleaseFast</text>
<text class="ts" x="120" y="154" text-anchor="middle" font-size="8.5" fill="#6b675e">饱和</text>
<rect class="bx-q" x="240" y="120" width="400" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="256" y="138" font-size="9" fill="#2b2a26">add edi, esi · mov eax, -1 · cmovae eax, edi · ret</text>
<text class="ts" x="256" y="154" font-size="8.5" fill="#6b675e">有进位就留 0xffffffff：语义更多，指令如实更多</text>
<rect class="bx-q" x="20" y="170" width="200" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="188" text-anchor="middle" font-size="9.5" fill="#2b2a26">a + b · ReleaseSafe</text>
<text class="ts" x="120" y="204" text-anchor="middle" font-size="8.5" fill="#6b675e">普通（检查开启）</text>
<rect class="bx" x="240" y="170" width="400" height="42" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="256" y="188" font-size="9" fill="#2b2a26">add edi, esi · jb overflow_panic</text>
<text class="ts" x="256" y="204" font-size="8.5" fill="#6b675e">一次加法，一次按进位标志的越界跳转</text>
</svg>
</figure>

## 编译器真的相信你不会越界

非法行为之所以不能当作「大概回绕」，不只因为规范措辞严厉，优化器会把这份承诺当真。

看两个几乎一样的函数：

```zig
export fn ordinaryIsGreater(x: u32) bool {
    return x + 1 > x;
}

export fn wrappingIsGreater(x: u32) bool {
    return x +% 1 > x;
}
```

ReleaseFast 下，第一份函数直接返回 true：

```asm
mov al, 1
ret
```

编译器推理得很干脆：普通 `x + 1` 若合法，当然大于 `x`；若 `x` 已经是最大值，那次加法本就不允许发生。因此，不需要真的加。

第二份函数却必须检查 `x` 是否等于 `0xffffffff`：

```asm
cmp   edi, -1
setne al
ret
```

因为 `+%` 明白承认了回绕。当 `x` 走到尽头，下一步就是 0，`0 > x` 自然为假。

两个操作符只差一个 `%`，优化器眼里的世界却不同：一个世界里越界的路径不存在，另一个世界里它不仅存在，而且有确切的去处。源码上写下的选择，机器也读懂了。

## 别的语言把答案放在哪里

各门语言都得处置这一步，只是答案放在不同的地方。

C 的无符号整数按模回绕，有符号溢出则是未定义行为。两个看起来相似的 `+`，规则要去类型和标准里找。Java 为整数规定了二进制补码回绕，日常写起来省心，代价是本来应该报错的金额和长度也会安静地绕过去。Rust 已有 `wrapping_add`、`saturating_add`、`checked_add` 等显式方法，但普通 `+` 是否检查溢出又受编译选项影响。

Zig 的取舍不是前所未有，特点在于把差异压进了操作符本身。读到 `+%`，无需追问构建配置，也无需猜作者是否知道这里可能越界；读到 `+|`，上限就是算法的一部分；读到普通 `+`，便知道这条路径声称结果一定装得下。

它没有消灭溢出，只是让溢出难以乔装成一场意外。

## 这套设计的代价

符号变多了。`+%`、`+|`、`-%`、`-|`、`*%`、`*|`，初见时像一桌相貌相近的生字。显式语义提高了审计能力，也提高了入门和阅读成本。一个普通业务函数若同时出现回绕、饱和和 checked arithmetic，读者必须真的懂得三者之别，不能再凭一个加号囫囵带过。

普通加法的护栏有开关。Debug 和 ReleaseSafe 会报告越界，ReleaseFast 和 ReleaseSmall 通常不会。若程序依赖一次 panic 来维护安全边界，换构建模式就可能把最后一道门撤掉。需要在所有模式下处置溢出时，应使用 `@addWithOverflow`、预先检查，或者返回错误；不要把安全构建的 panic 当成业务逻辑。

显式不等于正确。`+%` 写得再清楚，也可能选错语义。订单总额回绕成零，不会因为作者用了正确的 wrapping 操作符就变得合理；生命值饱和在上限也许合适，财务余额饱和却可能把错误悄悄吞掉。Zig 能逼你写明选择，不能替你判断选得对不对。

窄位宽有边角。`u3` 很适合表达三位字段，却不代表它单独放在内存里只占三位。跨 ABI、做原子操作、映射硬件布局时，还要继续考虑对齐、端序和 packed 布局。精确类型给了你一把刻度更细的尺，不会自动替你量完所有东西。

有时宽一点反而更清楚。若业务真正需要 0 到 510，就应把两个 `u8` 提升到 `u16` 后相加，而不是先让它们在 `u8` 里打转，再补救溢出。操作符能描述边界处的政策，类型才决定边界画在哪里。只盯着 `+%` 与 `+|`，容易忘了更早的那个问题：这块地是否本来就划小了。

---

回到开头的问题。`255 + 1` 在数学纸面上是 256；在 `u8` 的回绕算术里是 0；在饱和算术里是 255；在普通 Zig 加法里，是一条不该被越过的界线。答案不只取决于两个数，也取决于写代码的人愿意作出哪一种承诺。

这个系列一路写来，Zig 做的似乎总是同一件事：`comptime` 把求值时机交还调用方，错误联合把失败显式成值，Allocator 把分配策略变成参数，`undefined` 把未初始化的真空标出来。如今轮到加法——回绕、饱和、还是不许越界，选择权也交还给源码。写下去容易；算到尽头时后果归谁，就都写在纸上了。

下一篇讲指针家族。整数的边界靠位宽作答，内存的边界靠什么作答——Zig 给地址准备了一整套类型，比这里的加法还要多几种写法。
