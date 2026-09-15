---
title: 切片的有效期：Zig 为什么不替你保管内存
description: 切片只有地址和长度两个字段，谁拥有这块内存、什么时候失效，类型里一概没有。这篇从栈数组、allocator、ArrayList、arena 与字符串字面量几种来处入手，讲清借用、失效与所有权转移，以及把责任写进接口的惯例。示例代码经 Zig 0.16.0 实测。
pubDate: 2026-09-05
category: zig
tags: [Zig, 编程语言]
---

Zig 的切片，运行时只带两样信息：内存从哪里开始，能访问到多远。

```zig
[]const u8
```

这个类型没有回答的问题是：这块内存归谁，能用到什么时候，最后由谁释放。上一篇讲 result location 时留了一句话——值在哪里写成是一回事，内存归谁管是另一回事。这一篇就专门讲后一件事：一段切片指向的内存，到底能用多久。代码全部在 Zig 0.16.0 上验证过。

## 切片只有地址与长度

语言参考给切片的定义只有一句话：

> A slice is a pointer and a length.

运行时可以直接看到这两样东西：

```zig
var array = [_]i32{ 1, 2, 3, 4 };
const slice: []i32 = array[0..];

const address = slice.ptr;
const length = slice.len;
```

`ptr` 指向第一个元素，`len` 划出可访问范围，边界检查据此发生。在这台 x86_64 机器上：

```zig
std.debug.print("slice={d}\n", .{@sizeOf([]i32)});
```

输出：

```text
slice=16
```

八个字节的指针，加八个字节的长度，具体尺寸依目标平台而异。比尺寸更值得注意的是里面没有第三个字段：没有 allocator、没有引用计数，也没有任何形式的过期标记。`slice.len == 4` 说明这份切片声称有四个元素，说明不了那四个元素此刻仍然存在。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 116" role="img" aria-label="切片的运行时形状：本机 16 字节，只有 ptr 与 len 两格；没有第三格，allocator、引用计数、过期标记都不在类型里" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">[]i32 的运行时形状（本机 16 字节）</text>
<rect class="bx-q" x="60" y="34" width="180" height="46" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="150" y="53" text-anchor="middle" font-size="10.5" fill="#2b2a26">ptr · 8 字节</text>
<text class="ts" x="150" y="70" text-anchor="middle" font-size="9" fill="#6b675e">第一个元素在哪</text>
<rect class="bx-q" x="240" y="34" width="180" height="46" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="330" y="53" text-anchor="middle" font-size="10.5" fill="#2b2a26">len · 8 字节</text>
<text class="ts" x="330" y="70" text-anchor="middle" font-size="9" fill="#6b675e">能访问到多远</text>
<rect class="bx-gone" x="420" y="34" width="200" height="46" rx="3" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="520" y="53" text-anchor="middle" font-size="10" fill="#a29d90">没有第三格</text>
<text class="ts" x="520" y="70" text-anchor="middle" font-size="8.5" fill="#a29d90">allocator / 引用计数 / 过期标记</text>
<text class="ts" x="60" y="104" font-size="9.5" fill="#6b675e">「去哪读、读多远」写进了类型；「归谁、活多久」一个字都没有</text>
</svg>
</figure>

## 同一种切片，不同的来处

下面四个值都可以成为 `[]const u8`：

```zig
var local = [_]u8{ 'i', 'n', 'k' };
const from_stack: []const u8 = &local;

const from_heap: []u8 = try allocator.alloc(u8, 3);

var list: std.ArrayList(u8) = .empty;
try list.appendSlice(allocator, "ink");
const from_list: []const u8 = list.items;

const from_literal: []const u8 = "ink";
```

表面的类型一样，期限完全不同：

- `from_stack` 不能活过 `local` 所在的作用域；
- `from_heap` 有效到对应内存被释放或重新分配；
- `from_list` 受 `list` 的扩容、删除与清空操作约束；
- `from_literal` 指向具有静态存储期的只读数据，可以活到程序结束。

类型没有区分这四种来处。`[]const u8` 只说明「这里有一段只读内存」，所有权和有效期得从别处来：变量作用域、allocator 参数、容器文档、函数契约，共同决定一段借用何时到期。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="四种来处的 []const u8：栈上局部数组不能活过作用域；allocator 分配的有效到 free 或 resize；ArrayList.items 受扩容删除清空约束；字符串字面量是静态存储期可以活到程序结束；四行中间的类型一模一样" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="slA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="11.5" fill="#6b675e">来处</text>
<text class="ts" x="280" y="22" font-size="11.5" fill="#6b675e">类型</text>
<text class="ts" x="420" y="22" font-size="11.5" fill="#6b675e">期限</text>
<rect class="bx-q" x="20" y="32" width="220" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="55" font-size="9.5" fill="#2b2a26">栈上局部数组 &amp;local</text>
<line class="fl" x1="240" y1="50" x2="262" y2="50" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<rect class="bx" x="266" y="32" width="120" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="326" y="55" text-anchor="middle" font-size="9.5" fill="#2b2a26">[]const u8</text>
<line class="fl" x1="386" y1="50" x2="408" y2="50" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<text class="tc" x="420" y="55" font-size="9.5" fill="#b03a2e">不能活过 local 所在作用域</text>
<rect class="bx-q" x="20" y="80" width="220" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="103" font-size="9.5" fill="#2b2a26">allocator.alloc(u8, 3)</text>
<line class="fl" x1="240" y1="98" x2="262" y2="98" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<rect class="bx" x="266" y="80" width="120" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="326" y="103" text-anchor="middle" font-size="9.5" fill="#2b2a26">[]const u8</text>
<line class="fl" x1="386" y1="98" x2="408" y2="98" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<text class="ts" x="420" y="103" font-size="9.5" fill="#6b675e">到 free / resize 为止，所有者负责</text>
<rect class="bx-q" x="20" y="128" width="220" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="151" font-size="9.5" fill="#2b2a26">list.items（ArrayList）</text>
<line class="fl" x1="240" y1="146" x2="262" y2="146" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<rect class="bx" x="266" y="128" width="120" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="326" y="151" text-anchor="middle" font-size="9.5" fill="#2b2a26">[]const u8</text>
<line class="fl" x1="386" y1="146" x2="408" y2="146" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<text class="ts" x="420" y="151" font-size="9.5" fill="#6b675e">扩容、删除、清空都可能作废它</text>
<rect class="bx-q" x="20" y="176" width="220" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="199" font-size="9.5" fill="#2b2a26">字符串字面量 "ink"</text>
<line class="fl" x1="240" y1="194" x2="262" y2="194" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<rect class="bx" x="266" y="176" width="120" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="326" y="199" text-anchor="middle" font-size="9.5" fill="#2b2a26">[]const u8</text>
<line class="fl" x1="386" y1="194" x2="408" y2="194" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA2)"/>
<text class="ts" x="420" y="199" font-size="9.5" fill="#6b675e">静态存储 · 活到程序结束</text>
</svg>
</figure>

## 栈帧结束，地址还留在切片里

最短的一个例子是返回局部数组的切片。先写最直白的版本：

```zig
fn expired() []const u8 {
    var buffer: [8]u8 = undefined;
    return &buffer;
}
```

Zig 0.16.0 会拒绝：

```text
error: returning address of expired local variable 'buffer'
note: declared runtime-known here
```

这条诊断很有用：函数返回以后，`buffer` 的存储期结束，指向它的切片若被访问就是 Illegal Behavior，后果在安全模式那篇已经讲过。

但一条编译诊断不等于完整的生命周期检查。稍微换一种写法：

```zig
fn escaped() []const u8 {
    var buffer: [8]u8 = undefined;
    return buffer[0..];
}
```

它在 Zig 0.16.0 上仍能编译。返回的切片带着长度 `8`，它指向的栈内存却已经随函数调用结束而不再可用。还可以先把地址降成多项指针再切回来，或者经另一个函数转一手——绕来绕去，事实不变：栈帧一结束，局部数组就退出了程序可访问的内存。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 210" role="img" aria-label="悬空切片的两个时刻：函数内 buffer 住在栈帧里，返回的切片 ptr 指向它、len 为 8；函数返回后栈帧收回，切片里的旧地址还在，解引用即 Illegal Behavior" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="slA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="slA3c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<rect class="bx-q" x="20" y="26" width="280" height="160" rx="6" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="160" y="48" text-anchor="middle" font-size="10.5" fill="#2b2a26">fn escaped() 执行中</text>
<rect class="bx" x="40" y="60" width="240" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="160" y="78" text-anchor="middle" font-size="9.5" fill="#2b2a26">栈帧里的 buffer: [8]u8</text>
<text class="ts" x="160" y="95" text-anchor="middle" font-size="9" fill="#6b675e">存储期 = 本次函数调用</text>
<rect class="bx-q" x="40" y="128" width="240" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="160" y="145" text-anchor="middle" font-size="9.5" fill="#2b2a26">返回值 buffer[0..]</text>
<text class="ts" x="160" y="161" text-anchor="middle" font-size="9" fill="#6b675e">ptr ↑ · len = 8</text>
<line class="fl" x1="160" y1="128" x2="160" y2="108" stroke="#6b675e" stroke-width="1.2" marker-end="url(#slA3)"/>
<line class="fl" x1="300" y1="106" x2="356" y2="106" stroke="#6b675e" stroke-width="1.4" marker-end="url(#slA3)"/>
<text class="ts" x="328" y="96" text-anchor="middle" font-size="9.5" fill="#6b675e">return</text>
<rect class="bx-sick" x="360" y="26" width="280" height="160" rx="6" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="500" y="48" text-anchor="middle" font-size="10.5" fill="#b03a2e">函数返回之后</text>
<rect class="bx-gone" x="380" y="60" width="240" height="44" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="500" y="78" text-anchor="middle" font-size="9.5" fill="#a29d90">栈帧已收回</text>
<text class="ts" x="500" y="95" text-anchor="middle" font-size="9" fill="#a29d90">buffer 退出可访问内存</text>
<rect class="bx-q" x="380" y="128" width="240" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="500" y="145" text-anchor="middle" font-size="9.5" fill="#2b2a26">调用者手里的切片</text>
<text class="ts" x="500" y="161" text-anchor="middle" font-size="9" fill="#6b675e">旧地址与 len=8 原封不动</text>
<line class="flc" x1="500" y1="128" x2="500" y2="108" stroke="#b03a2e" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#slA3c)"/>
<text class="tc" x="512" y="122" font-size="9" fill="#b03a2e">解引用 = Illegal Behavior</text>
<text class="ts" x="20" y="202" font-size="9.5" fill="#6b675e">切片值本身完好无损：坏掉的只是它指的那块内存的可用性</text>
</svg>
</figure>

语言参考说得很直接：

> It is the Zig programmer's responsibility to ensure that a pointer is not accessed when the memory pointed to is no longer available.

它紧接着提醒，切片也是一种指针，因为它引用别处的内存。编译器能拦住一部分明显错误，Zig 也并没有因此变成一门带借用检查器的语言；漏网的悬空切片，要靠人自己防。

## 借用还是持有，看契约不看类型

看两个处理字符串的函数：

```zig
fn trimSpaces(input: []const u8) []const u8 {
    return std.mem.trim(u8, input, " ");
}

fn copyTrimmed(
    allocator: std.mem.Allocator,
    input: []const u8,
) ![]u8 {
    return allocator.dupe(u8, trimSpaces(input));
}
```

调用起来很相似：

```zig
const input = "  bamboo  ";

const borrowed = trimSpaces(input);
const owned = try copyTrimmed(allocator, input);
defer allocator.free(owned);
```

两个结果都是切片，内容都是 `bamboo`，责任相反。

`borrowed` 只是 `input` 的子切片。它没有分配内存，调用者不应释放它，有效期也不超过 `input`。`owned` 来自 `allocator.dupe`，标准库在这个 API 上明写：

> Caller owns the memory.

它是一份独立分配，调用者负责用相容的 allocator 释放。测试能确认两者内容相同、地址不同：

```zig
try std.testing.expectEqualStrings("bamboo", borrowed);
try std.testing.expectEqualStrings("bamboo", owned);
try std.testing.expect(borrowed.ptr != owned.ptr);
```

```text
All 1 tests passed.
```

所以别从 `[]const u8` 还是 `[]u8` 去猜所有权。可写切片可能只是借来的缓冲区，只读切片也可能指向调用者自己拥有的分配。真正能说明责任的是函数契约：接不接 allocator，文档写没写 caller owns，返回值来自输入还是新分配，由谁清理。

## `const` 管的只是这条路径上的写权限

```zig
var bytes = [_]u8{ 'a', 'b', 'c' };

const writable: []u8 = &bytes;
writable[0] = 'A';

const read_only: []const u8 = writable;
// read_only[1] = 'B'; // error: cannot assign to constant
```

这里有两种不同的 `const`：`const writable` 是变量本身不能重新赋成另一份切片，它指向的元素仍是 `u8`，可以写；`[]const u8` 是不能通过这份切片修改元素。`[]u8` 可以隐式转成 `[]const u8`，反向要丢掉 const 限定，不能自然发生。

容易读出过多含义的是后者。`[]const u8` 限制的只有「经由这份切片写入」，它说明不了内存归谁，也说明不了存储期多长。栈上的内存就算设成只读，函数返回后照样失效。只读和长命是两回事。

## 转借和再切片都不改变期限

切片很容易继续传播：

```zig
const Reader = struct {
    source: []const u8,

    fn init(source: []const u8) Reader {
        return .{ .source = source };
    }
};
```

`Reader.init` 没有复制 `source` 指向的字节，只是把切片值存进了结构体。返回的 `Reader` 可以活得比实参所在的语句更久，底层内存不会因为多包了一层结构体就延长寿命。

再切片也一样：

```zig
const line = input[begin..end];
const word = line[first..last];
```

`word` 借自 `line`，`line` 借自 `input`；三者的指针可以各不相同，底层依附的是同一片存储。中间切片离开作用域无所谓，要紧的只有最初那块内存还在不在。

所以持有切片的结构体，得在 API 上把生命周期说清，惯用的做法有三种：调用者保证输入活得比结构体久；或者初始化函数复制输入、结构体取得所有权并提供 `deinit`；或者约定结构体只在一次请求、一个 arena 的存续期内使用。

## `ArrayList.items` 会在扩容时失效

这是实际项目里最常见的悬空来源。

Zig 0.16.0 中，`std.ArrayList(T)` 使用显式传 allocator 的 API：

```zig
var list: std.ArrayList(u32) = .empty;
defer list.deinit(allocator);

try list.append(allocator, 1);
const old = list.items;

try list.ensureTotalCapacity(allocator, 4096);
```

`old` 是一份切片值，它不会跟随 `list.items` 自动更新。在本机这次运行里，扩容前后的地址不同：

```zig
std.debug.print("moved={}\n", .{
    old.ptr != list.items.ptr,
});
```

```text
moved=true
```

此后再解引用 `old`，访问的就是已经失效的视图。不过地址变没变只是这次的观察结果，不能当判断标准。标准库对失效的措辞更严：当操作把内存交给 allocator 的 `resize` 或 `free` 时，元素指针就算失效；即使 allocator 恰好原地调整、数值地址看上去没变，旧指针也不能继续用。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 234" role="img" aria-label="扩容前后的 ArrayList：扩容前 old 切片与 list.items 指向同一块缓冲区；ensureTotalCapacity 之后 list.items 指向新缓冲区，old 仍握着旧地址，那块内存已经交还分配器，再解引用就是访问失效视图" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="slA4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="slA4c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">扩容前：old 与 list.items 同指一块缓冲</text>
<rect class="bx-q" x="20" y="32" width="180" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="110" y="55" text-anchor="middle" font-size="9.5" fill="#2b2a26">list · capacity = 4</text>
<rect class="bx-q" x="240" y="32" width="180" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="55" text-anchor="middle" font-size="9.5" fill="#2b2a26">old = list.items</text>
<rect class="bx" x="460" y="32" width="180" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="550" y="55" text-anchor="middle" font-size="9.5" fill="#2b2a26">缓冲区 A：1 2 3 4</text>
<path class="fl" d="M 150 68 C 200 96 400 96 470 70" fill="none" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA4)"/>
<line class="fl" x1="420" y1="50" x2="456" y2="50" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA4)"/>
<text class="ts" x="20" y="100" font-size="11" fill="#6b675e">ensureTotalCapacity(4096) 之后：</text>
<rect class="bx-q" x="20" y="110" width="180" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="110" y="133" text-anchor="middle" font-size="9.5" fill="#2b2a26">list · capacity = 4096</text>
<rect class="bx-sick" x="240" y="110" width="180" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="330" y="133" text-anchor="middle" font-size="9.5" fill="#b03a2e">old：地址纹丝不动</text>
<rect class="bx" x="460" y="110" width="180" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="550" y="133" text-anchor="middle" font-size="9.5" fill="#2b2a26">缓冲区 B：1 2 3 4 …</text>
<line class="fl" x1="200" y1="128" x2="456" y2="128" stroke="#6b675e" stroke-width="1.1" marker-end="url(#slA4)"/>
<rect class="bx-gone" x="240" y="170" width="400" height="36" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="440" y="193" text-anchor="middle" font-size="9.5" fill="#a29d90">缓冲区 A：已交还 resize / free</text>
<line class="flc" x1="330" y1="146" x2="330" y2="166" stroke="#b03a2e" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#slA4c)"/>
<text class="tc" x="342" y="162" font-size="9" fill="#b03a2e">悬空</text>
</svg>
</figure>

不同操作的边界也不同：

| 操作 | 元素指针何时失效 |
| --- | --- |
| `append`、`appendSlice`、`insert` | 需要额外内存时 |
| `ensureTotalCapacity` | 实际需要增长时 |
| `orderedRemove` | 指向末尾元素的指针失效；被移位置之后的元素会移动 |
| `swapRemove` | 指向最后一个元素的指针失效 |
| `clearRetainingCapacity` | 全部失效 |
| `clearAndFree` | 全部失效且内存被释放 |
| `appendAssumeCapacity` | 不因扩容失效，但调用者必须先保证容量 |

保存了 `list.items` 或 `&list.items[i]` 之后，对可能扩容、删除、清空的操作就要多留个心眼。数据要跨过这些边界，要么复制一份，要么操作完成后重新取切片。

## `toOwnedSlice` 是所有权转移

有时需要把 `ArrayList` 里积累的内容正式交给调用者，不必先 `dupe` 再销毁列表：

```zig
var list: std.ArrayList(u8) = .empty;
defer list.deinit(allocator);

try list.appendSlice(allocator, "ink");

const owned = try list.toOwnedSlice(allocator);
defer allocator.free(owned);
```

`toOwnedSlice` 的标准库契约有三条：调用者拥有返回的内存；`ArrayList` 被清空；capacity 也归零，之后再调 `deinit` 是安全的，但已经没有必要。在 Zig 0.16.0 上测试：

```zig
try std.testing.expectEqualStrings("ink", owned);
try std.testing.expectEqual(@as(usize, 0), list.items.len);
try std.testing.expectEqual(@as(usize, 0), list.capacity);
```

```text
All 1 tests passed.
```

`list` 从此不再负责那块存储，释放义务移交给调用者。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="toOwnedSlice 的所有权转移：转移前 ArrayList 通过 items 拥有缓冲区；转移后列表被清空、容量归零，缓冲区原封不动，owned 切片接手，释放义务随 defer allocator.free 归调用者" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="slA6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="slA6c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">toOwnedSlice 之前</text>
<rect class="bx-q" x="20" y="32" width="190" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="115" y="50" text-anchor="middle" font-size="9.5" fill="#2b2a26">list（ArrayList）</text>
<text class="ts" x="115" y="67" text-anchor="middle" font-size="9" fill="#6b675e">items = "ink" · capacity 4</text>
<line class="fl" x1="115" y1="76" x2="115" y2="122" stroke="#6b675e" stroke-width="1.2" marker-end="url(#slA6)"/>
<text class="ts" x="125" y="102" font-size="9" fill="#6b675e">拥有</text>
<rect class="bx" x="20" y="126" width="280" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="160" y="151" text-anchor="middle" font-size="10" fill="#2b2a26">缓冲区：i n k</text>
<text class="ts" x="20" y="190" font-size="9.5" fill="#6b675e">释放义务在 list.deinit</text>
<text class="ts" x="370" y="22" font-size="11" fill="#6b675e">之后</text>
<rect class="bx-gone" x="370" y="32" width="190" height="44" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="465" y="50" text-anchor="middle" font-size="9.5" fill="#a29d90">list 被清空</text>
<text class="ts" x="465" y="67" text-anchor="middle" font-size="9" fill="#a29d90">items.len = 0 · capacity = 0</text>
<rect class="bx-q" x="370" y="98" width="260" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="500" y="115" text-anchor="middle" font-size="9.5" fill="#2b2a26">owned = try list.toOwnedSlice(allocator)</text>
<text class="ts" x="500" y="131" text-anchor="middle" font-size="9" fill="#6b675e">defer allocator.free(owned)</text>
<line class="flc" x1="210" y1="46" x2="366" y2="110" stroke="#b03a2e" stroke-width="1.3" marker-end="url(#slA6c)"/>
<text class="tc" x="238" y="76" font-size="9" fill="#b03a2e">释放义务移交</text>
<line class="fl" x1="300" y1="146" x2="366" y2="130" stroke="#6b675e" stroke-width="1.2" marker-end="url(#slA6)"/>
<text class="ts" x="370" y="190" font-size="9.5" fill="#6b675e">字节一个没动，动的只是「谁负责还」</text>
</svg>
</figure>

反过来要注意：不能把 `items` 的子切片拿去 `free`。allocator 认的是当初分配出的完整区域，不是碰巧落在区域内部的地址。切片可以裁短自己的视野，裁不出一份新的分配记录。

## arena 把许多期限并成一个

```zig
var arena = std.heap.ArenaAllocator.init(backing_allocator);
defer arena.deinit();

const allocator = arena.allocator();
const title = try allocator.dupe(u8, "chapter");
const body = try allocator.alloc(u8, 4096);
```

`title` 与 `body` 不必各自安排释放，`arena.deinit()` 会统一释放 arena 持有的存储；代价是它们也在同一刻全部失效。

这适合一批对象本来就该同生共死的场景：处理一个请求、跑一次解析、编译的一个阶段。统一归还省掉了许多琐碎操作，责任也因此清楚。

危险出在切片越过 arena 边界的时候：

```zig
fn buildName(backing_allocator: std.mem.Allocator) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(backing_allocator);
    defer arena.deinit();

    return arena.allocator().dupe(u8, "borrowed name");
}
```

这段代码能编译，但函数返回前会先执行 `arena.deinit()`，调用者接到的是已经悬空的切片。要把结果交给外层，就用外层提供且寿命够长的 allocator 来分配，或在 arena 结束前把数据复制到那样的存储里去。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="arena 逃逸时间线：buildName 函数体内 arena 存活，dupe 出切片；defer 触发 arena.deinit 统一归还存储；随后函数返回，调用者手里的切片指向已经归还的内存，成为悬空切片" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="slA5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="11" fill="#6b675e">buildName() 里的时间线</text>
<rect class="bar" x="60" y="96" width="320" height="16" rx="3" fill="#2b2a26"/>
<text class="onbar" x="220" y="108" text-anchor="middle" font-size="9.5" fill="#ece9e2">arena 存活 · dupe 出 "borrowed name"</text>
<line class="flc" x1="380" y1="82" x2="380" y2="126" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="380" y="72" text-anchor="middle" font-size="9.5" fill="#b03a2e">defer arena.deinit()</text>
<text class="tc" x="380" y="142" text-anchor="middle" font-size="9" fill="#b03a2e">存储统一归还</text>
<line class="axis" x1="470" y1="82" x2="470" y2="126" stroke="#a29d90" stroke-width="1.3"/>
<text class="ts" x="470" y="72" text-anchor="middle" font-size="9.5" fill="#6b675e">函数返回</text>
<line class="axis" x1="30" y1="160" x2="630" y2="160" stroke="#a29d90" stroke-width="1.2" marker-end="url(#slA5)"/>
<rect class="bx-sick" x="490" y="88" width="150" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="565" y="105" text-anchor="middle" font-size="9" fill="#b03a2e">调用者接到切片</text>
<text class="ts" x="565" y="121" text-anchor="middle" font-size="9" fill="#b03a2e">已经悬空</text>
<line class="flc" x1="470" y1="104" x2="486" y2="104" stroke="#b03a2e" stroke-width="1.2" marker-end="url(#slA5)"/>
<text class="ts" x="60" y="184" font-size="9.5" fill="#6b675e">deinit 排在 return 之前执行：切片想活过函数，就得换一块寿命够长的存储</text>
</svg>
</figure>

## 字符串字面量为什么可以直接返回

并非所有跨函数返回的切片都短命：

```zig
fn label(ready: bool) []const u8 {
    return if (ready) "ready" else "waiting";
}
```

这是安全的。字符串字面量具有静态存储期，程序运行期间一直存在，函数返回的只是指向它的只读视图。

```zig
test "string literal may cross a return boundary" {
    try std.testing.expectEqualStrings("ready", label(true));
}
```

```text
All 1 tests passed.
```

指针那篇讲过它的类型：指向带哨兵数组的常量单项指针，可以转成切片。这里要看的重点是存储期。同样返回 `[]const u8`，`return buffer[0..]` 会悬空，`return "ready"` 可以一直用；函数签名区分不了这两者，调用者只能靠读实现或看 API 文档。

## 把责任写进接口

Zig 不把生命周期写进类型系统，但提供了几条现成的惯例，可以把契约说清楚。

**只借用。** 参数使用 `[]const T`，函数不保存超出调用期的引用，也不释放输入。

**由调用者提供缓冲区。** 例如：

```zig
var buffer: [32]u8 = undefined;
const text = try std.fmt.bufPrint(
    &buffer,
    "chapter {d}",
    .{8},
);
```

谁拥有内存、结果能活多久，一眼便知；容量不足由 `error.NoSpaceLeft` 明说。

**分配并转移所有权。** 函数接受 allocator，文档写明 caller owns returned memory，调用者用同一个 allocator 安排 `defer free`。

**批量管理。** 一组对象放进同一个 arena，API 明确规定它们只在 arena 存续期间有效。

**跨失效点就复制。** 要把 `ArrayList.items`、解析缓冲区中的字段或 arena 里的临时数据保存得更久，用 `dupe` 建立独立存储，不要指望原地址恰好没变。

常见来处可以列成一张期限表：

| 底层存储 | 谁控制期限 | 何时失效 | 谁负责释放 |
| --- | --- | --- | --- |
| 函数局部数组 | 所在栈帧 | 函数返回时 | 自动结束，不可手动 `free` |
| allocator 分配 | 持有所有权的一方 | `free`、`resize` 或 allocator 销毁后 | 契约指定的所有者 |
| `ArrayList.items` | `ArrayList` 及其操作 | 依具体操作的失效规则 | 列表或 `toOwnedSlice` 后的调用者 |
| arena 分配 | arena | `reset` 或 `deinit` 后 | arena 统一处理 |
| 字符串字面量 | 程序静态存储 | 程序结束时 | 无需释放 |

类型写不下的期限，接口必须写清。在这种设计里，API 文档属于内存安全的一部分。

## 借用模式的代价

借用很轻，责任不轻。复制一份切片只是复制指针和长度，底层存储的有效性却由所有副本共同依赖；视图越多，越要清楚谁能终结那块内存。

省一次分配，就多一层时序约束。保存 `ArrayList.items` 而不做 `dupe` 是真实的性能收益，但使用期间列表不能发生任何使指针失效的操作，调用顺序受到的限制同样真实。

`dupe` 也不是万能答案。它要分配、拷贝、释放，还可能返回 `error.OutOfMemory`；它是用时间和空间换独立存储的一笔交易，遇到生命周期疑问就无脑 `dupe`，账会越欠越多。

arena 简化的是归还，防不了逃逸。一次 `deinit` 能结清整批内存，却拦不住某份切片被存进更长寿的对象；越容易统一释放，越要警惕数据越过统一期限。

最后，工具只能照见一部分错误。Debug allocator、毒化字节和编译器诊断各有覆盖范围，有些悬空切片照样编译通过，某些非法访问甚至暂时返回旧值。没有立刻崩溃，不构成内存仍可使用的证据。

---

这一篇的结论可以收得很短：切片负责「去哪读、读多远」，其余的事归人管。内存从哪里来，allocator 那篇讲过；值在哪里写成，result location 讲过；这篇补上的是中间那一段——借用期间，底层内存必须仍然有效，而语言不会替你盯着。

下一篇讲 tagged union。一个连接的状态记在哪里、怎么保证状态和它携带的数据不出错，是另一类「类型该表达多少事实」的问题。
