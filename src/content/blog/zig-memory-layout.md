---
title: Zig 的内存布局：struct、extern struct 与 packed struct
description: 字段写在源码里的次序，未必是它们落进内存的次序；字段大小逐项相加，也未必等于结构体最终占的空间。这篇讲清三种结构体各自的承诺：普通 struct 只保证对齐，extern struct 匹配 C ABI，packed struct 精确到每一位。布局数字均实测于 Zig 0.16.0。
pubDate: 2026-09-04
category: zig
tags: [Zig, 编程语言]
---

字段写在源码里的次序，不一定是它们落进内存的次序；字段大小逐项相加，也不一定等于结构体最终占去的空间。那些看不见、摸不着、不能直接访问的字节，人们叫它 padding。

Zig 对这件事没有给出一种答案，它给了三种结构体：

```zig
struct
extern struct
packed struct
```

它们语法相近，作出的保证却完全不同。普通 `struct` 把布置权交给编译器，`extern struct` 遵从目标平台的 C ABI，`packed struct` 把每一位都编入一枚整数。选错一种，轻则多占几个字节，重则把文件、网络包和外部函数解释成另一副模样。

上一篇写指针，问一枚地址究竟带着多少边界信息；这一篇循着地址进门，看字段如何落座、空白为何存在，以及每一位都写清以后，仍有哪些事不能想当然。代码全部在 Zig 0.16.0 上验证过。

## 普通 struct：编译器自己安排

先看一份故意把大小字段交错书写的结构体：

```zig
const Record = struct {
    a: u32,
    b: u8,
    c: u32,
    d: u8,
};
```

若按声明顺序排下去，很容易想象成这样：

```text
aaaa b... cccc d...
0    4    8    12
```

`b` 后面补三个字节，`c` 才能落在四字节对齐的地址；`d` 后面再补三个字节，整个结构体共 16 字节。

但 Zig 0.16.0 在这台 x86_64 机器上给出的实际结果是：

```zig
const std = @import("std");

pub fn main() void {
    std.debug.print("size={d}, align={d}\n", .{
        @sizeOf(Record),
        @alignOf(Record),
    });

    inline for (std.meta.fields(Record)) |field| {
        std.debug.print("{s}: offset={d}\n", .{
            field.name,
            @offsetOf(Record, field.name),
        });
    }
}
```

```text
size=12, align=4
a: offset=0
b: offset=8
c: offset=4
d: offset=9
```

声明在第三位的 `c` 被放到了 `b` 前面。两个 `u32` 连在一起，两个 `u8` 随后落座，尾部再留两字节 padding，总大小从想象中的 16 收到了 12。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="Record 布局对照：按声明顺序摆放需要 16 字节，a 占 0 到 3，b 占 4 后面补三字节，c 占 8 到 11，d 占 12 后面再补三字节；Zig 0.16.0 实际把两个 u32 排在一起，a 占 0 到 3，c 占 4 到 7，b 占 8，d 占 9，尾部补两字节，共 12 字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="11" fill="#6b675e">想象中：按声明顺序（16 字节）</text>
<rect class="bx-q" x="60" y="34" width="136" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="128" y="56" text-anchor="middle" font-size="10" fill="#2b2a26">a · u32</text>
<rect class="bx-q" x="196" y="34" width="34" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="213" y="56" text-anchor="middle" font-size="10" fill="#2b2a26">b</text>
<rect class="bx-gone" x="230" y="34" width="102" height="34" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="281" y="56" text-anchor="middle" font-size="9" fill="#a29d90">padding ×3</text>
<rect class="bx-q" x="332" y="34" width="136" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="400" y="56" text-anchor="middle" font-size="10" fill="#2b2a26">c · u32</text>
<rect class="bx-q" x="468" y="34" width="34" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="485" y="56" text-anchor="middle" font-size="10" fill="#2b2a26">d</text>
<rect class="bx-gone" x="502" y="34" width="102" height="34" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="553" y="56" text-anchor="middle" font-size="9" fill="#a29d90">padding ×3</text>
<text class="ts" x="60" y="86" font-size="9" fill="#a29d90">0</text>
<text class="ts" x="196" y="86" font-size="9" fill="#a29d90">4</text>
<text class="ts" x="332" y="86" font-size="9" fill="#a29d90">8</text>
<text class="ts" x="468" y="86" font-size="9" fill="#a29d90">12</text>
<text class="ts" x="592" y="86" font-size="9" fill="#a29d90">16</text>
<text class="ts" x="20" y="124" font-size="11" fill="#6b675e">实际：Zig 0.16.0 自己安排（12 字节）</text>
<rect class="bx-q" x="60" y="134" width="136" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="128" y="156" text-anchor="middle" font-size="10" fill="#2b2a26">a · u32</text>
<rect class="bx" x="196" y="134" width="136" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="264" y="156" text-anchor="middle" font-size="10" fill="#2b2a26">c · u32</text>
<rect class="bx-q" x="332" y="134" width="34" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="349" y="156" text-anchor="middle" font-size="10" fill="#2b2a26">b</text>
<rect class="bx-q" x="366" y="134" width="34" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="383" y="156" text-anchor="middle" font-size="10" fill="#2b2a26">d</text>
<rect class="bx-gone" x="400" y="134" width="68" height="34" rx="2" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="434" y="156" text-anchor="middle" font-size="9" fill="#a29d90">pad ×2</text>
<text class="ts" x="60" y="186" font-size="9" fill="#a29d90">0</text>
<text class="ts" x="196" y="186" font-size="9" fill="#a29d90">4</text>
<text class="ts" x="332" y="186" font-size="9" fill="#a29d90">8</text>
<text class="ts" x="400" y="186" font-size="9" fill="#a29d90">10</text>
<text class="ts" x="458" y="186" font-size="9" fill="#a29d90">12</text>
<text class="tc" x="492" y="156" font-size="10.5" fill="#b03a2e">同一份声明，省出 4 字节</text>
<text class="ts" x="60" y="214" font-size="9.5" fill="#6b675e">重排是本次构建的事实：普通 struct 不承诺字段顺序，这份布局不能写进磁盘格式</text>
</svg>
</figure>

这不能当成「Zig 总会按大小排序」来依赖。语言参考的原话更直接：

> Zig gives no guarantees about the order of fields and the size of the struct, but the fields are guaranteed to be ABI-aligned.

普通 `struct` 不保证字段顺序，也不保证结构体大小；它只保证每个字段满足自己的 ABI 对齐要求。今天观察到 `c` 在 offset 4，是本次编译的事实，不是可以写进磁盘格式的规矩。`@offsetOf` 当然可以查询普通结构体，只是答案属于这一份构建，不能拿去约束明天的编译器、另一个目标平台或另一门语言。

这也是为什么下面的代码会被拒绝：

```zig
const bits: u96 = @bitCast(record);
```

```text
error: cannot @bitCast from 'Record'; struct does not have a guaranteed in-memory layout
```

字段都有值，不等于字段之间的每一位都成了语言承诺。普通结构体首先描述「有什么」，要拿一张可以跨边界流通的字节图，得用另外两种。

## 对齐：padding 为什么存在

对齐的意思，可以先说得朴素些：若一种类型要求四字节对齐，那么装载或存储它的地址，就应当能被四整除。

```zig
std.debug.print("u8  align={d}\n", .{@alignOf(u8)});
std.debug.print("u32 align={d}\n", .{@alignOf(u32)});
std.debug.print("u64 align={d}\n", .{@alignOf(u64)});
```

在本机输出：

```text
u8  align=1
u32 align=4
u64 align=8
```

数值依赖目标架构，不应抄成宇宙常数；规则却很稳定：结构体字段必须落在符合自身要求的位置上。若前一个字段结束得不巧，编译器或 ABI 就在中间留出 padding。

尾部为什么也常有空白？因为结构体不会只住一次。看一个数组：

```zig
const Cell = extern struct {
    tag: u8,
    value: u32,
};

var cells: [2]Cell = undefined;
const first = @intFromPtr(&cells[0]);
const second = @intFromPtr(&cells[1]);
std.debug.print("stride={d}\n", .{second - first});
```

在本机，`Cell` 的 `tag` 在 offset 0，`value` 在 offset 4，总大小是 8。前三个 padding 字节让 `value` 对齐；而结构体大小本身取 8，保证数组里第二个 `Cell` 的起点仍满足四字节对齐。

所以 padding 不只是编译器浪费的边角：它不直接承载业务数据，却让每一次访问都落在机器期待的位置上。代价也很实在——结构体很多、字段很碎时，空白会随数组一份份复制。普通 `struct` 可以借重排减少浪费；一旦布局必须向外部世界固定下来，这份自由就要交出去。

## extern struct：匹配 C ABI

`extern struct` 的承诺是：内存布局匹配当前目标的 C ABI。

把同一组字段改成：

```zig
const Record = extern struct {
    a: u8,
    b: u64,
    c: u8,
    d: u32,
    e: u16,
};
```

本机 Zig 的结果：

```text
size=32, align=8
a: offset=0
b: offset=8
c: offset=16
d: offset=20
e: offset=24
```

我又写了等价的 C：

```c
struct Record {
    uint8_t  a;
    uint64_t b;
    uint8_t  c;
    uint32_t d;
    uint16_t e;
};

printf("%zu %zu %zu %zu %zu %zu %zu\n",
    sizeof(struct Record),
    _Alignof(struct Record),
    offsetof(struct Record, a),
    offsetof(struct Record, b),
    offsetof(struct Record, c),
    offsetof(struct Record, d),
    offsetof(struct Record, e));
```

GCC 在同一台机器上打印：

```text
32 8 0 8 16 20 24
```

大小、对齐、五个偏移逐项一致。字段不再被 Zig 自行重排，声明顺序就是 C 看见的顺序；该留的 padding 也一字节不少。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 168" role="img" aria-label="extern struct Record 的 32 字节图：a 是 u8 占偏移 0，1 到 7 是 padding，b 是 u64 占偏移 8 到 15，c 是 u8 占偏移 16，17 到 19 是 padding，d 是 u32 占偏移 20 到 23，e 是 u16 占偏移 24 到 25，26 到 31 是尾部 padding；与 GCC 的 sizeof 和 offsetof 完全一致" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">extern struct Record · size = 32 · align = 8（1 格 = 1 字节）</text>
<rect class="bx-q" x="60" y="34" width="17" height="40" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="68" y="24" text-anchor="middle" font-size="9" fill="#2b2a26">a</text>
<rect class="bx-gone" x="77" y="34" width="119" height="40" rx="1" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="136" y="58" text-anchor="middle" font-size="9" fill="#a29d90">padding ×7</text>
<rect class="bx" x="196" y="34" width="136" height="40" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="264" y="58" text-anchor="middle" font-size="10" fill="#2b2a26">b · u64</text>
<rect class="bx-q" x="332" y="34" width="17" height="40" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="340" y="24" text-anchor="middle" font-size="9" fill="#2b2a26">c</text>
<rect class="bx-gone" x="349" y="34" width="51" height="40" rx="1" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="374" y="58" text-anchor="middle" font-size="8.5" fill="#a29d90">pad ×3</text>
<rect class="bx-q" x="400" y="34" width="68" height="40" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="434" y="58" text-anchor="middle" font-size="10" fill="#2b2a26">d · u32</text>
<rect class="bx-q" x="468" y="34" width="34" height="40" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="485" y="90" text-anchor="middle" font-size="9" fill="#2b2a26">e</text>
<rect class="bx-gone" x="502" y="34" width="102" height="40" rx="1" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="553" y="58" text-anchor="middle" font-size="9" fill="#a29d90">padding ×6</text>
<line class="axis" x1="60" y1="102" x2="604" y2="102" stroke="#a29d90" stroke-width="1"/>
<text class="ts" x="60" y="118" text-anchor="middle" font-size="9" fill="#6b675e">0</text>
<text class="ts" x="196" y="118" text-anchor="middle" font-size="9" fill="#6b675e">8</text>
<text class="ts" x="332" y="118" text-anchor="middle" font-size="9" fill="#6b675e">16</text>
<text class="ts" x="400" y="118" text-anchor="middle" font-size="9" fill="#6b675e">20</text>
<text class="ts" x="468" y="118" text-anchor="middle" font-size="9" fill="#6b675e">24</text>
<text class="ts" x="604" y="118" text-anchor="middle" font-size="9" fill="#6b675e">32</text>
<text class="ts" x="60" y="148" font-size="9.5" fill="#6b675e">GCC 打印 32 8 0 8 16 20 24：两侧逐字节相同 · 换 ABI 数值可能再变</text>
</svg>
</figure>

所以 `extern` 不是「压紧」，更不是「取消 padding」，它的意思是遵从当前目标的 C ABI——换一个 ABI，具体数值仍可能变化。若你要和 C 函数、系统调用或外部库交换结构体，它正是该用的类型；若你要定义一个跨平台文件格式，`extern struct` 仍不是天然答案，因为 C ABI 从未许诺所有平台长得一样。

它对字段类型也更挑剔。普通 `struct`、切片、非指针 optional、error union 等没有稳定 C 内存表示的类型，不能随意塞进去：

```zig
const Bad = extern struct {
    bytes: []const u8,
};
```

```text
error: extern structs cannot contain fields of type '[]const u8'
note: slices have no guaranteed in-memory representation
```

一旦声称「外部可见」，字段也得拿出外部世界认得的身份证明。

## padding 里没有可供信赖的值

`extern struct` 有布局，不等于 padding 有值。

仍用刚才 32 字节的 `Record`，给五个字段都赋上容易辨认的数字，再把整块内存按字节打印。本机一次运行得到：

```text
11 c8 8a 1a fe 7f 00 00 22 22 22 22 22 22 22 22
33 c8 8a 1a 44 44 44 44 55 55 1d 01 00 00 00 00
```

`11`、八个 `22`、`33`、四个 `44`、两个 `55` 都如约而至；夹在它们之间的字节却带着栈上的旧痕。这些位置属于结构体大小，却不属于任何字段，Zig 没有答应替你初始化。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 156" role="img" aria-label="32 字节内存转储着色图：字段字节 11、八个 22、33、四个 44、两个 55 按偏移落座；其余 14 个字节是 padding，内容是栈上旧痕，未初始化且不可信赖" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="20" font-size="10.5" fill="#6b675e">偏移 0..15</text>
<rect class="bx-q" x="20" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="38" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">11</text>
<rect class="bx-sick" x="58" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="76" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">c8</text>
<rect class="bx-sick" x="96" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="114" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">8a</text>
<rect class="bx-sick" x="134" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="152" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">1a</text>
<rect class="bx-sick" x="172" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="190" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">fe</text>
<rect class="bx-sick" x="210" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="228" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">7f</text>
<rect class="bx-sick" x="248" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="266" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">00</text>
<rect class="bx-sick" x="286" y="28" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="304" y="46" text-anchor="middle" font-size="9" fill="#b03a2e">00</text>
<rect class="bx-q" x="324" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="342" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="362" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="380" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="400" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="418" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="438" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="456" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="476" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="494" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="514" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="532" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="552" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="570" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<rect class="bx-q" x="590" y="28" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="608" y="46" text-anchor="middle" font-size="9" fill="#2b2a26">22</text>
<text class="ts" x="20" y="76" font-size="10.5" fill="#6b675e">偏移 16..31</text>
<rect class="bx-q" x="20" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="38" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">33</text>
<rect class="bx-sick" x="58" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="76" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">c8</text>
<rect class="bx-sick" x="96" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="114" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">8a</text>
<rect class="bx-sick" x="134" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="152" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">1a</text>
<rect class="bx-q" x="172" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="190" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">44</text>
<rect class="bx-q" x="210" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="228" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">44</text>
<rect class="bx-q" x="248" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="266" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">44</text>
<rect class="bx-q" x="286" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="304" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">44</text>
<rect class="bx-q" x="324" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="342" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">55</text>
<rect class="bx-q" x="362" y="84" width="36" height="28" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="380" y="102" text-anchor="middle" font-size="9" fill="#2b2a26">55</text>
<rect class="bx-sick" x="400" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="418" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">1d</text>
<rect class="bx-sick" x="438" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="456" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">01</text>
<rect class="bx-sick" x="476" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="494" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">00</text>
<rect class="bx-sick" x="514" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="532" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">00</text>
<rect class="bx-sick" x="552" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="570" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">00</text>
<rect class="bx-sick" x="590" y="84" width="36" height="28" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="608" y="102" text-anchor="middle" font-size="9" fill="#b03a2e">00</text>
<rect class="bx-q" x="20" y="128" width="16" height="12" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="44" y="138" font-size="9.5" fill="#6b675e">字段值：a、b、c、d、e 如约落座</text>
<rect class="bx-sick" x="270" y="128" width="16" height="12" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="294" y="138" font-size="9.5" fill="#6b675e">padding：14 个字节是栈上旧痕，memcmp 与序列化都不可信</text>
</svg>
</figure>

因此，不能把含 padding 的结构体拿来做朴素的逐字节相等判断，也不能因为字段逐个相等，就断定 `memcmp` 一定返回零。更不能把整块对象原样写进文件或网络：除了端序与 ABI 问题，你还可能把未定义的 padding 一并送出去，既不稳定，也可能泄露旧内存。

布局保证管的是字段坐在哪里，空椅子上摆着什么，它不管。

## packed struct：精确到每一位

不需要与 C 对话、只想把每一位精确表达出来的任务，Zig 还有另一种结构体：

```zig
const Flags = packed struct(u8) {
    ready: bool,
    mode: u2,
    count: u5,
};
```

这里的 `u8` 叫 backing integer。三个字段恰好占 `1 + 2 + 5 = 8` 位，不能多，也不能少。若写成 `packed struct(u16)` 却只声明八位字段，编译器不会替你补八位 padding，而是直接拒绝：

```text
error: backing integer bit width does not match total bit width of fields
```

普通结构体会在字段之间留白，packed struct 没有 padding。它和 backing integer 具有相同的 ABI，字段按声明顺序从最低有效位向最高有效位排开：

```zig
const Pair = packed struct(u8) {
    low: u3,
    high: u5,
};

const pair: Pair = .{
    .low = 0b101,
    .high = 0b10011,
};
const raw: u8 = @bitCast(pair);
std.debug.print("0x{x}\n", .{raw});
```

```text
0x9d
```

低三位是 `101`，高五位是 `10011`，合起来正是 `10011101`。这个排法不是编译器的巧合，是 packed struct 的布局保证。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="Pair 的位布局：u8 的 bit0 到 bit2 是 low 字段值 101，bit3 到 bit7 是 high 字段值 10011，字段从最低有效位向最高有效位排开，整字节读出 0x9d" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">packed struct(u8) 的八个位 · 字段从最低有效位排起</text>
<rect class="bx-q" x="60" y="34" width="66" height="42" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="93" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">1</text>
<rect class="bx-q" x="126" y="34" width="66" height="42" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="159" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">0</text>
<rect class="bx-q" x="192" y="34" width="66" height="42" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="225" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">1</text>
<rect class="bx" x="258" y="34" width="66" height="42" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="291" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">1</text>
<rect class="bx" x="324" y="34" width="66" height="42" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="357" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">1</text>
<rect class="bx" x="390" y="34" width="66" height="42" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="423" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">0</text>
<rect class="bx" x="456" y="34" width="66" height="42" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="489" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">0</text>
<rect class="bx" x="522" y="34" width="66" height="42" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="555" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">1</text>
<text class="ts" x="93" y="94" text-anchor="middle" font-size="9" fill="#6b675e">bit 0</text>
<text class="ts" x="159" y="94" text-anchor="middle" font-size="9" fill="#6b675e">1</text>
<text class="ts" x="225" y="94" text-anchor="middle" font-size="9" fill="#6b675e">2</text>
<text class="ts" x="291" y="94" text-anchor="middle" font-size="9" fill="#6b675e">3</text>
<text class="ts" x="357" y="94" text-anchor="middle" font-size="9" fill="#6b675e">4</text>
<text class="ts" x="423" y="94" text-anchor="middle" font-size="9" fill="#6b675e">5</text>
<text class="ts" x="489" y="94" text-anchor="middle" font-size="9" fill="#6b675e">6</text>
<text class="ts" x="555" y="94" text-anchor="middle" font-size="9" fill="#6b675e">bit 7</text>
<line class="axis" x1="60" y1="106" x2="258" y2="106" stroke="#a29d90" stroke-width="1.2"/>
<text class="ts" x="159" y="124" text-anchor="middle" font-size="10" fill="#2b2a26">low: u3 = 0b101</text>
<line class="axis" x1="258" y1="106" x2="588" y2="106" stroke="#a29d90" stroke-width="1.2"/>
<text class="ts" x="423" y="124" text-anchor="middle" font-size="10" fill="#2b2a26">high: u5 = 0b10011</text>
<text class="tc" x="60" y="156" font-size="10.5" fill="#b03a2e">@bitCast(pair) 整字节读出：0b10011101 = 0x9d</text>
</svg>
</figure>

不写 backing integer 也可以，Zig 会按字段总位数推断一个无符号整数；显式写出来的好处是把总宽度也纳入编译检查。对协议头、位图和硬件寄存器，每一位归谁，落笔之前便已定下。

## `@bitOffsetOf` 与位域指针

对普通和 extern 结构体，字段通常从某个完整字节开始，`@offsetOf` 足以量位置。packed struct 可以从一个字节的半途起笔，需要更细的尺：

```zig
const Header = packed struct(u64) {
    version: u3,
    kind: u5,
    length: u16,
    sequence: u32,
    flags: u8,
};

comptime {
    if (@bitOffsetOf(Header, "version") != 0) @compileError("bad layout");
    if (@bitOffsetOf(Header, "kind") != 3) @compileError("bad layout");
    if (@bitOffsetOf(Header, "length") != 8) @compileError("bad layout");
    if (@bitOffsetOf(Header, "sequence") != 24) @compileError("bad layout");
    if (@bitOffsetOf(Header, "flags") != 56) @compileError("bad layout");
}
```

这五个字段刚好占满 64 位：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 158" role="img" aria-label="Header 的 64 位按宽度比例切分：version 占 bit 0 到 2，kind 占 bit 3 到 7，length 占 bit 8 到 23，sequence 占 bit 24 到 55，flags 占 bit 56 到 63，五个字段无 padding 占满 backing integer" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">packed struct(u64) · 宽度按位数比例</text>
<rect class="bx-q" x="60" y="56" width="26" height="44" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-q" x="86" y="56" width="44" height="44" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx" x="130" y="56" width="140" height="44" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="200" y="82" text-anchor="middle" font-size="10" fill="#2b2a26">length · 16 位</text>
<rect class="bx" x="270" y="56" width="280" height="44" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="410" y="82" text-anchor="middle" font-size="10" fill="#2b2a26">sequence · 32 位</text>
<rect class="bx-q" x="550" y="56" width="70" height="44" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="585" y="82" text-anchor="middle" font-size="9.5" fill="#2b2a26">flags · 8</text>
<text class="ts" x="73" y="44" text-anchor="middle" font-size="9" fill="#2b2a26">version·3</text>
<text class="ts" x="108" y="122" text-anchor="middle" font-size="9" fill="#2b2a26">kind·5</text>
<line class="axis" x1="60" y1="112" x2="620" y2="112" stroke="#a29d90" stroke-width="1"/>
<text class="ts" x="60" y="130" text-anchor="middle" font-size="9" fill="#6b675e">0</text>
<text class="ts" x="86" y="130" text-anchor="middle" font-size="9" fill="#6b675e">3</text>
<text class="ts" x="130" y="130" text-anchor="middle" font-size="9" fill="#6b675e">8</text>
<text class="ts" x="270" y="130" text-anchor="middle" font-size="9" fill="#6b675e">24</text>
<text class="ts" x="550" y="130" text-anchor="middle" font-size="9" fill="#6b675e">56</text>
<text class="ts" x="620" y="130" text-anchor="middle" font-size="9" fill="#6b675e">64</text>
<text class="ts" x="60" y="150" font-size="9.5" fill="#6b675e">@bitOffsetOf 逐字段核对的就是这些起点：3 + 5 + 16 + 32 + 8 = 64，一位不剩</text>
</svg>
</figure>

`@offsetOf` 仍可用于 packed struct，但对非字节对齐字段，它只能告诉你所在的 host 字节；要问精确的第几位，应使用 `@bitOffsetOf`。

甚至 packed field 的地址也可以取得：

```zig
var pair: Pair = .{ .low = 1, .high = 2 };
const p = &pair.high;
std.debug.print("{s}\n", .{@typeName(@TypeOf(p))});
```

结果是带有 host size 与 bit offset 的特殊指针。它能读写对应位域，却不能冒充普通 ABI 指针传给一个期待 `*u5` 的函数。同一字节里的两个位字段，数值意义不同，物理地址甚至可能完全相同；真正区分它们的，是类型里额外写下的位偏移。

## `@bitCast`：位模式重解释

`@bitCast` 做的是位模式重解释。源与目标的 `@bitSizeOf` 必须相同：

```zig
const raw: u8 = @bitCast(pair);
const again: Pair = @bitCast(raw);
```

它不复制一份业务意义上的新数据，也不替你调整端序，只是把同一组位换一种类型来读。这正适合 packed struct 与 backing integer 之间转换。

普通 `struct` 没有保证布局，因此不能这样 bitcast；`extern struct` 虽有布局，可以 bitcast，但它的 padding 位仍是 undefined，得到的整型会把那些不可靠的位也一并装进去。尺寸恰好相同，不代表每一位都值得信赖。

更危险的是合法值。假设 packed struct 里放了一个穷尽 enum：

```zig
const Kind = enum(u3) { data, ack, control };
const Packet = packed struct(u8) {
    kind: Kind,
    rest: u5,
};
```

外部字节完全可能在低三位放入 7。`@bitCast` 不会替 `kind` 核验枚举成员；随后对它做穷尽 `switch`，Debug 或 ReleaseSafe 可能报告 `switch on corrupt value`，ReleaseFast 则进入不受保护的非法行为。

`@bitCast` 只核对位数，不核验来历。它能证明两只盒子一样大，不能证明盒中之物合法。解析不可信输入时，应先在整数层面取值并校验，或使用带 `_` 的非穷尽 enum；不要把外部字节直接授予一个比事实更强的类型。

## packed 不是网络字节序

这是整篇最容易误传的一点：packed struct 有确定的位布局，却不等于它天然就是网络包。

仍用刚才的 64 位 `Header`。设协议规定：

```text
byte 0     高 3 位 version，低 5 位 kind
byte 1..2  length，big-endian
byte 3..6  sequence，big-endian
byte 7     flags
```

取一组值：

```zig
const h: Header = .{
    .version = 1,
    .kind = 0,
    .length = 0x0400,
    .sequence = 0x11223344,
    .flags = 0xff,
};
```

协议期望的八字节是：

```text
20 04 00 11 22 33 44 ff
```

若在这台 little-endian 机器上直接 `@bitCast`，再把内存原样发出去，实测却是：

```text
01 00 04 44 33 22 11 ff
```

错了两层。

第一层是位序。packed struct 的第一个字段从 backing integer 的最低有效位开始；协议却把 version 放在第一个字节的最高三位。第二层是字节序。`length` 与 `sequence` 在内存中的多字节表示服从本机端序，协议要求的是 big-endian。

把整个 `u64` 做一次 `@byteSwap` 也救不回来。byte swap 只会颠倒八个字节，不能把每个字节内部的字段从低位搬到高位。位序与字节序是两套独立的坐标，不能靠一次翻面混为一谈。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 182" role="img" aria-label="协议期望的八字节 20 04 00 11 22 33 44 ff 与在 little-endian 机器上直接 bitCast 发出的 01 00 04 44 33 22 11 ff 逐字节对照：前七个字节全部不同，只有最后的 flags 一致" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">同一组字段值，两种字节序列</text>
<text class="ts" x="118" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">byte0</text>
<text class="ts" x="178" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">1</text>
<text class="ts" x="238" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">2</text>
<text class="ts" x="298" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">3</text>
<text class="ts" x="358" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">4</text>
<text class="ts" x="418" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">5</text>
<text class="ts" x="478" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">6</text>
<text class="ts" x="538" y="48" text-anchor="middle" font-size="8.5" fill="#a29d90">7</text>
<text class="ts" x="20" y="74" font-size="9.5" fill="#2b2a26">协议期望</text>
<rect class="bx-q" x="90" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="118" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">20</text>
<rect class="bx-q" x="150" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="178" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">04</text>
<rect class="bx-q" x="210" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="238" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">00</text>
<rect class="bx-q" x="270" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="298" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">11</text>
<rect class="bx-q" x="330" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="358" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">22</text>
<rect class="bx-q" x="390" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="418" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">33</text>
<rect class="bx-q" x="450" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="478" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">44</text>
<rect class="bx-q" x="510" y="56" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="538" y="76" text-anchor="middle" font-size="10" fill="#2b2a26">ff</text>
<text class="ts" x="14" y="126" font-size="9" fill="#2b2a26">@bitCast 直发</text>
<rect class="bx-sick" x="90" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="118" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">01</text>
<rect class="bx-sick" x="150" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="178" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">00</text>
<rect class="bx-sick" x="210" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="238" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">04</text>
<rect class="bx-sick" x="270" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="298" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">44</text>
<rect class="bx-sick" x="330" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="358" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">33</text>
<rect class="bx-sick" x="390" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="418" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">22</text>
<rect class="bx-sick" x="450" y="108" width="56" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.1"/><text class="ts" x="478" y="128" text-anchor="middle" font-size="10" fill="#b03a2e">11</text>
<rect class="bx-q" x="510" y="108" width="56" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="538" y="128" text-anchor="middle" font-size="10" fill="#2b2a26">ff</text>
<text class="tc" x="90" y="164" font-size="10.5" fill="#b03a2e">八个字节错了七个：byte0 错位序，多字节字段错端序；只有单字节的 flags 幸存</text>
</svg>
</figure>

`packed` 管的是字段如何切分 backing integer；wire format 管的是每一位、每一字节怎样排列在传输序列里。两者可能恰好一致，却绝不是同义词。

## 按协议显式解析

既然协议已经把字节次序写清，代码也应照着写清：

```zig
const std = @import("std");

const Header = packed struct(u64) {
    version: u3,
    kind: u5,
    length: u16,
    sequence: u32,
    flags: u8,

    const current_version: u3 = 1;
    const DecodeError = error{BadVersion};

    fn encode(self: Header, out: *[8]u8) void {
        out[0] = (@as(u8, self.version) << 5) | @as(u8, self.kind);
        std.mem.writeInt(u16, out[1..3], self.length, .big);
        std.mem.writeInt(u32, out[3..7], self.sequence, .big);
        out[7] = self.flags;
    }

    fn decode(bytes: *const [8]u8) DecodeError!Header {
        const version: u3 = @truncate(bytes[0] >> 5);
        if (version != current_version) return error.BadVersion;

        return .{
            .version = version,
            .kind = @truncate(bytes[0] & 0x1f),
            .length = std.mem.readInt(u16, bytes[1..3], .big),
            .sequence = std.mem.readInt(u32, bytes[3..7], .big),
            .flags = bytes[7],
        };
    }
};
```

第一字节用移位和掩码明确表达位序；多字节整数用 `std.mem.readInt` / `writeInt` 明确表达 big-endian。没有依赖主机端序，没有把 padding 带上路，也没有假装外部八字节已经是一个合法的 Zig 对象。

我给它写了四个测试：固定字节镜像、encode/decode 往返、拒绝未知版本、编译期布局断言。Zig 0.16.0 上全部通过：

```zig
test "encode produces exact wire bytes" {
    var bytes: [8]u8 = undefined;
    const h: Header = .{
        .version = 1,
        .kind = 2,
        .length = 0x0102,
        .sequence = 0x0a0b0c0d,
        .flags = 0xee,
    };

    h.encode(&bytes);
    try std.testing.expectEqualSlices(u8, &.{
        0x22, 0x01, 0x02, 0x0a, 0x0b, 0x0c, 0x0d, 0xee,
    }, &bytes);
}
```

这里依然保留 packed struct，是因为它很适合在程序内部表达字段宽度、做编译期位偏移检查；真正跨越网络边界时，由 encode/decode 把内存表示翻译成 wire 表示。

八字节的显式读写，换来跨端序、可校验、可测试的语义，往往比一次聪明的强转更便宜。

## 三种 struct 的分工

现在可以把三种结构体并排放下：

| 类型 | 主要承诺 | 字段顺序 | padding | 适用场景 |
| --- | --- | --- | --- | --- |
| `struct` | 字段满足 ABI 对齐 | 不保证 | 由编译器决定 | Zig 内部数据模型 |
| `extern struct` | 匹配目标 C ABI | 按 C ABI | 可能存在 | C 互操作、系统 ABI |
| `packed struct` | 与 backing integer 同 ABI，字段由低位向高位精确排列 | 保证 | 无 | 位域、寄存器、内存中的整数表示 |

它们不是安全程度从低到高的阶梯，也不是三个可随意替换的拼写。普通 struct 给编译器自由，因而适合语言内部优化；extern struct 放弃这份自由，换来和 C 对话；packed struct 把约束收紧到每一位，换来位级表示。

选择哪一个，取决于你要向谁负责：向 Zig 编译器负责，向 C ABI 负责，还是向一枚 backing integer 的每一位负责。至于磁盘与网络，它们通常还有自己的端序、校验和、版本兼容规则，三种 struct 都不能替协议本身发言。

## 固定布局的代价

固定布局会束住编译器的手。普通 struct 可以重排字段，减少 padding，也可以随编译器演进改变内部表示；换成 extern 或 packed，就是主动放弃这种自由。若数据从不跨 ABI、从不作为位模式观察，固定布局往往只是平添约束。

padding 既占空间，也藏风险。它会随数组重复，会让逐字节比较不可靠，还可能在序列化时带出旧内存。初始化所有字段并不等于初始化 padding；需要稳定字节表示时，应逐字段编码，而不是把整块结构体当成现成报文。

packed field 不再是普通字段。子字节字段的地址带着 host size 与 bit offset，不能随意交给期待普通指针的函数。对 packed 值的字段赋值还可能编译成读—改—写，而不是一次原子操作；映射 MMIO 寄存器时，应先构造完整新值，再通过 volatile 指针整体写入，不能把字段级赋值误当成硬件原子性。

`@bitCast` 不负责验证。位数相等只是入场券；非法 enum tag、未初始化位、extern padding、来自外部的不可信模式，都不会因为一声 bitcast 自动变得合法。类型越精确，伪造这份类型时承担的责任也越重。

端序始终要单独回答。packed struct 解决位域布局，extern struct 解决 C ABI，二者都不会替一个 big-endian 协议照料主机字节序。显式 `readInt` / `writeInt` 看起来多写几行，却把跨平台语义钉在了源码上。

零拷贝有时只是把成本改了名字。省下一次八字节复制，却引入对齐、端序、合法值、生命周期和别名问题，未必划算。性能应当测，边界应先说清；几行朴素的解析代码，常比一次惊艳的强转更经得起年月。

---

上一篇的指针告诉我们从哪里开始，这一篇的布局告诉我们进去以后如何落脚。地址保存边界，布局安排尺度，两者合在一起，才是一段内存完整的来历。

Zig 没有替人省下选择，它把三种保证分别摆在面前：交给编译器安排、遵从 C ABI、亲手规定每一位。布局越精确，承诺越重；字节排得越满，越容不得含混。

下一篇讲 result location。布局定的是值长成以后的模样；值在被求值之前，类型和地址就已经从外层传进来了——那是另一套看不见的规则。
