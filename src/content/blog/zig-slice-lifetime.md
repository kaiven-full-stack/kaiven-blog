---
title: 借来的一段地址：Zig 切片为何不替你保管内存
description: 切片记得一段内存从哪里开始、可以走多远，却不记得谁拥有它，也不保证它还能活多久。本文从栈上数组、ArrayList、allocator、arena 与字符串字面量出发，辨清借用、失效与所有权转移。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-05
tags: [Zig, 编程语言]
---

借书有册，归还有期。

一册书从藏书楼递到案头，借书条会写下书名、卷数与索书之处；至于哪日闭馆，谁该归还，能不能转借旁人，往往另有章程。只看手中那张纸，未必看得见全部期限。

Zig 的切片也像这样一张借书条。它记得内存从哪里开始，也记得可以读到多远：

```zig
[]const u8
```

可这几个字符没有写下内存归谁，没有写下何时失效，更没有承诺有人会在最后替你归还。

上一篇写 Result Location，问一个值在何处落笔；其中留下一句：位置不是所有权，也不证明生命周期。这一篇便接住那句未尽之言，不再问切片能走多远，而问它能用到几时。代码照例全部在 Zig 0.16.0 上验证过。

## 切片只有地址与长度

语言参考给切片的定义很短：

> A slice is a pointer and a length.

在运行时，它主要携带两样东西：

```zig
var array = [_]i32{ 1, 2, 3, 4 };
const slice: []i32 = array[0..];

const address = slice.ptr;
const length = slice.len;
```

`ptr` 指向第一个元素，`len` 划出可访问范围。边界检查据此发生；但无论切片背后是栈数组、堆分配、`ArrayList.items`，还是静态字符串，切片本身仍只是这两项信息。

在这台 x86_64 机器上：

```zig
std.debug.print("slice={d}\n", .{@sizeOf([]i32)});
```

输出：

```text
slice=16
```

八字节指针，加八字节长度。具体尺寸依目标平台而异，更重要的是其中没有第三个字段：没有 allocator，没有引用计数，没有析构函数，也没有到期时刻。

长度回答的是边界，不是时限。`slice.len == 4` 只能说明这份切片声称有四个元素，不能说明那四个元素此刻仍存在。

## 同一种切片，四种来处

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

它们表面的类型相近，期限却完全不同：

- `from_stack` 不能活过 `local` 所在的作用域；
- `from_heap` 有效到对应内存被释放或重新分配；
- `from_list` 受 `list` 的扩容、删除与清空操作约束；
- `from_literal` 指向具有静态存储期的只读数据，可以活到程序结束。

类型没有替这些来处编成四种切片。Zig 选择让 `[]const u8` 只陈述访问方式，不把所有权与生命周期一并编码进去。

这使函数签名轻，也把责任留在签名之外：变量作用域、allocator 参数、容器文档和调用约定，共同决定一段借用何时到期。

## 栈帧落幕，地址仍写在纸上

最短的一堂生命周期课，是返回局部数组的切片。

先写最直白的版本：

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

这是一条很有用的诊断。函数返回以后，`buffer` 的存储期结束；指向它的切片若被访问，便会触犯 Illegal Behavior。

但不要把一条诊断误认成完整的生命周期证明。稍换一种写法：

```zig
fn escaped() []const u8 {
    var buffer: [8]u8 = undefined;
    return buffer[0..];
}
```

它在 Zig 0.16.0 上仍能编译。得到的切片保留了长度 `8`，它的元素却已经没有合法的存储可供访问。

还可以先把地址降成多项指针再切回来，或者经另一个函数传递出去。语法绕了一步，事实没有改变：栈帧结束以后，局部数组便不再属于程序可访问的内存。

语言参考说得很清楚：

> It is the Zig programmer's responsibility to ensure that a pointer is not accessed when the memory pointed to is no longer available.

它紧接着提醒，切片也是一种指针，因为它引用别处的内存。编译器会抓住一部分明显错误，却没有因此成为借用检查器。检查是照进暗处的一盏灯，不是替人看守终夜的更夫。

## 借阅与持有，类型未必作答

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

两个结果都是切片，也都含有 `bamboo`；责任却相反。

`borrowed` 只是 `input` 的子切片。它没有分配内存，调用者不应释放它，而且它不能活过 `input`。

`owned` 来自 `allocator.dupe`。标准库在这个 API 上明写：

> Caller owns the memory.

它是一份独立分配，调用者负责用相容的 allocator 释放。测试也能确认两者内容相同、地址不同：

```zig
try std.testing.expectEqualStrings("bamboo", borrowed);
try std.testing.expectEqualStrings("bamboo", owned);
try std.testing.expect(borrowed.ptr != owned.ptr);
```

```text
All 1 tests passed.
```

不要从 `[]const u8` 与 `[]u8` 猜所有权。一个可写切片也可能只是借来的缓冲区，一个只读切片也可能指向调用者拥有的分配。真正说明责任的是函数契约：是否接受 allocator，文档是否写着 caller owns，返回值来自输入还是新分配，以及应当由谁清理。

借书条写了书在哪里；谁来归还，要看出借章程。

## `const` 只管从这条路能不能改

`const` 很容易被读出过多含义。

```zig
var bytes = [_]u8{ 'a', 'b', 'c' };

const writable: []u8 = &bytes;
writable[0] = 'A';

const read_only: []const u8 = writable;
// read_only[1] = 'B'; // error: cannot assign to constant
```

这里有两种不同的 `const`：

- `const writable` 表示变量 `writable` 不能被重新赋成另一份切片；它指向的元素仍是 `u8`，所以可以通过它写入；
- `[]const u8` 表示不能通过这份切片修改元素。

`[]u8` 可以隐式转成 `[]const u8`，反向则会丢失 const 限定，不能自然发生。

然而 `[]const u8` 只限制“经由这条访问路径写入”。它不表示内存属于切片，不表示内存位于只读段，不表示没有其他可写别名，更不表示存储期更长。

一段栈内存即使只读，函数返回后仍会失效；一段堆内存即使只读，`free` 以后仍会悬空。不可写与不会消失，是两件相隔很远的事。

## 转借不会延长期限

切片很容易继续传播：

```zig
const Reader = struct {
    source: []const u8,

    fn init(source: []const u8) Reader {
        return .{ .source = source };
    }
};
```

`Reader.init` 没有复制 `source` 指向的字节，只把切片值存进结构体。返回的 `Reader` 可以活得比实参所在的语句更久，底层内存却不会因为多了一层结构体就延寿。

再切片也是一样：

```zig
const line = input[begin..end];
const word = line[first..last];
```

`word` 借自 `line`，`line` 又借自 `input`；三者的指针可以不同，最终仍依附同一片底层存储。任何一个中间切片离开作用域都不重要，真正重要的是最初那块内存是否还在。

因此，持有切片的结构体需要在 API 上说清生命周期：

- 调用者必须让输入活得比结构体久；或
- 初始化函数复制输入，结构体取得所有权，并提供 `deinit`；或
- 结构体只在一次明确的请求、解析或 arena 生命周期内使用。

切片能够转借，不能续期。多抄一张借书条，不会使藏书楼晚一刻闭门。

## `ArrayList.items`：书架会在扩容时搬走

`ArrayList.items` 是最常见的失效现场之一。

Zig 0.16.0 中，`std.ArrayList(T)` 使用显式传 allocator 的 API：

```zig
var list: std.ArrayList(u32) = .empty;
defer list.deinit(allocator);

try list.append(allocator, 1);
const old = list.items;

try list.ensureTotalCapacity(allocator, 4096);
```

`old` 是一份切片值。它不会跟随 `list.items` 自动更新。

在本机这次运行里，扩容前后的地址不同：

```zig
std.debug.print("moved={}\n", .{
    old.ptr != list.items.ptr,
});
```

```text
moved=true
```

此后若解引用 `old`，便是在访问已经失效的视图。但地址变化只是这次运行留下的脚印，不是判断失效的标准。

标准库对 `ArrayList` 的措辞更严谨：当操作把内存交给 allocator 的 `resize` 或 `free` 时，元素指针就算失效。即使 allocator 恰好原地调整，数值地址看上去没变，也不能拿旧指针继续作保。

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

所以保存 `list.items` 或 `&list.items[i]` 以后，不能不加分辨地调用可能扩容、删除或清空的操作。若数据必须跨过这些边界，就复制一份，或在操作完成后重新取得切片。

容器可以继续生长，旧视图不会随它一同长大。

## `toOwnedSlice`：不是借阅，是移交

有时需要把 `ArrayList` 中积累的内容正式交给调用者。此时不必先 `dupe` 再销毁列表，可以使用：

```zig
var list: std.ArrayList(u8) = .empty;
defer list.deinit(allocator);

try list.appendSlice(allocator, "ink");

const owned = try list.toOwnedSlice(allocator);
defer allocator.free(owned);
```

`toOwnedSlice` 的标准库契约包含三件事：

1. 调用者拥有返回的内存；
2. `ArrayList` 被清空；
3. 它的 capacity 也被清零，因此之后调用 `deinit` 是安全的，但已经没有必要。

在 Zig 0.16.0 上测试：

```zig
try std.testing.expectEqualStrings("ink", owned);
try std.testing.expectEqual(@as(usize, 0), list.items.len);
try std.testing.expectEqual(@as(usize, 0), list.capacity);
```

```text
All 1 tests passed.
```

这不是“返回一份借用”，而是所有权转移。`list` 不再负责那块存储，调用者接过释放义务。

反过来，不能把 `items` 子切片拿去 `free`。allocator 认的是当初分配出的完整区域及其约定，不是任何碰巧落在区域内部的地址。切片可以裁短视野，却不能擅自改写分配记录。

所有权不在 `ptr` 的数值里，也不在 `len` 的大小里；它存在于一次分配、一次转移和一次释放之间必须首尾相合的关系中。

## arena：同一日到期

arena 没有让生命周期消失，只是把许多期限合并成一个期限。

```zig
var arena = std.heap.ArenaAllocator.init(backing_allocator);
defer arena.deinit();

const allocator = arena.allocator();
const title = try allocator.dupe(u8, "chapter");
const body = try allocator.alloc(u8, 4096);
```

`title` 与 `body` 不必各自安排一次常规释放；`arena.deinit()` 会统一释放 arena 持有的存储。代价是它们也在同一刻全部失效。

这很适合请求处理、一次解析、编译阶段或批量临时数据：一群对象本来就应同生共死，统一期限反而使责任清楚。

危险出现在切片越过 arena 边界时：

```zig
fn buildName(backing_allocator: std.mem.Allocator) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(backing_allocator);
    defer arena.deinit();

    return arena.allocator().dupe(u8, "borrowed name");
}
```

这段代码能编译，返回时却先执行 `arena.deinit()`。调用者接到的是已经悬空的切片。函数返回了一个地址，却把地址背后的存储留在已经结清的 arena 里。

若要把结果交给外层，就应使用外层提供且寿命足够长的 allocator，或在 arena 结束前把结果复制到那块存储。批量归还省去了许多小账，也要求所有借阅都服从同一日的闭馆钟声。

## 字符串字面量：可以久存的只读页

并非所有返回的切片都短命：

```zig
fn label(ready: bool) []const u8 {
    return if (ready) "ready" else "waiting";
}
```

这是安全的。字符串字面量具有静态存储期，程序运行期间一直存在；函数返回的只是指向它的只读视图。

```zig
test "string literal may cross a return boundary" {
    try std.testing.expectEqualStrings("ready", label(true));
}
```

```text
All 1 tests passed.
```

上一篇指针文章已经拆过字符串字面量的类型：它是指向带哨兵数组的常量单项指针，可转换成切片。这里真正要看的不是类型形状，而是存储期。

同样返回 `[]const u8`，`return buffer[0..]` 可能悬空，`return "ready"` 却可以长久使用。函数返回类型没有把两者分开，调用者必须依靠实现可见性或 API 文档知道期限。

“只读”不是“永久”的同义词；只是字符串字面量恰好同时拥有这两种性质。

## 与其猜，不如把责任写进接口

Zig 不把生命周期写进类型系统，却提供了几种让契约清楚的惯例。

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

**分配并转移所有权。** 函数接受 allocator，文档写明 caller owns returned memory，调用者用同一 allocator 安排 `defer free`。

**批量管理。** 一组对象放进同一个 arena，让 API 明确规定它们只在 arena 存续期间有效。

**跨失效点复制。** 若要把 `ArrayList.items`、解析缓冲区中的字段或临时 arena 数据保存更久，使用 `dupe` 建立独立存储，而不是寄望原地址恰好没变。

可以把常见来处列成一张期限表：

| 底层存储 | 谁控制期限 | 何时失效 | 谁负责释放 |
| --- | --- | --- | --- |
| 函数局部数组 | 所在栈帧 | 函数返回时 | 自动结束，不可手动 `free` |
| allocator 分配 | 持有所有权的一方 | `free`、`resize` 或 allocator 销毁后 | 契约指定的所有者 |
| `ArrayList.items` | `ArrayList` 及其操作 | 依具体操作的失效规则 | 列表或 `toOwnedSlice` 后的调用者 |
| arena 分配 | arena | `reset` 或 `deinit` 后 | arena 统一处理 |
| 字符串字面量 | 程序静态存储 | 程序结束时 | 无需释放 |

类型写不下的期限，接口必须写清。文档在这里不是锦上添花，而是内存安全的一部分。

## 代价，认真地

**借用很轻，责任不轻。** 复制一份切片只复制指针和长度，代价几乎可以忽略；底层存储的有效性却由所有副本共同依赖。视图越多，越需要清楚谁能结束那块内存的生命。

**少复制，便多一层时序约束。** 保存 `ArrayList.items` 可以省下一次分配，却要求使用期间列表不发生使其失效的操作。性能所得是真实的，调用顺序受到的约束也同样真实。

**复制会买来独立，也会带来成本。** `dupe` 需要分配、拷贝和释放，还可能返回 `error.OutOfMemory`。它不是遇见生命周期疑问时的万能护符，而是一笔用时间和空间换取独立存储的交易。

**arena 简化的是归还，不是逃逸分析。** 一次 `deinit` 可以结清整批内存，却不会阻止某份切片被存进更长寿的对象。越容易统一释放，越要警惕数据越过统一期限。

**工具只能照见一部分错误。** Debug allocator、毒化字节和编译器诊断能抓住若干 use-after-free 或错误释放；有些悬空切片仍会正常编译，某些非法访问甚至暂时返回旧值。没有立刻崩溃，不是内存仍归你使用的凭证。

---

借书条终于写到了最后一栏。

切片上的地址告诉我们去哪里寻，长度告诉我们可以读多少；唯独归还日期没有印在类型里。它可能随栈帧谢幕，可能在容器扩容时作废，可能与整个 arena 同日结清，也可能像一页静态文字，陪程序走到终章。

前文谈指针，辨它带着多少边界；谈 allocator，问内存从哪里来；谈 result location，看值在何处写成。到了切片的生命周期，这几条线才在一处相逢：地址有来处，存储有主人，借用有期限，释放也须有人落款。

Zig 没有替每一段切片写下归还日期。它把这件事交给作用域、allocator、容器契约与人的判断。自由之处从来也是责任之处；能把一份借用传得很远，更应知道它最迟该停在哪里。

夕照移过书案，藏书楼将要闭门。手边哪一册是借来的，哪一册已经誊作自藏，宜在钟声响起以前，分说明白。
