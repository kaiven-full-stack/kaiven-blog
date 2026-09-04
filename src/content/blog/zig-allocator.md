---
title: 分配是调用方的事：Zig 的 Allocator
description: GC 把分配藏进运行时，RAII 把清理绑在对象生命周期上，Zig 的答案是：分配不是语言特性，是一个参数。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-04
tags: [Zig, 编程语言]
---

每个用内存的程序都要回答两个问题：内存从哪儿来，用完还给谁。多数语言把答案焊死在语言里——GC 语言说「运行时管，你别问」；C++ 说「对象析构的时候还」；Rust 说「所有权移到谁身上，谁负责」。

Zig 的答案有点奇怪：这个问题，语言不管。`new` 这个关键字不存在，垃圾收集器不存在，析构函数也不存在。分配内存靠一个普通的值——Allocator——从函数参数传进来。分配是调用方的决策，不是语言的决策。

上一篇讲 `errdefer` 时留了个尾巴：清理是执行一段代码，传播是算出一个值，两件事拆开反而清楚。这篇把另一半摊开：清理之前的那个问题——这些内存凭什么归你管——Zig 把它也拆了出来，从语言手里拆出来，交还给调用方。代码照例全部在 Zig 0.16.0 上验证过。

## Allocator 是个 16 字节的普通值

先看它长什么样。不是关键字，不是内置类型，就是标准库里一个普通的 struct：

```zig
std.debug.print("Allocator 大小: {d} 字节\n", .{@sizeOf(std.mem.Allocator)});

const info = @typeInfo(std.mem.Allocator).@"struct";
inline for (info.fields) |f| {
    std.debug.print("  {s}: {s}\n", .{ f.name, @typeName(f.type) });
}
```

输出：

```text
Allocator 大小: 16 字节
  ptr: *anyopaque
  vtable: *const mem.Allocator.VTable
```

两个字段：一个指针，指向分配器自己的状态；一张函数表，里面是 `alloc`、`resize`、`remap`、`free` 四个函数。第一篇讲 comptime 时用过的 `@typeInfo`，在这里又出场了——连「分配器是什么」都可以用普通代码在编译期问出来。

这个结构的含义比它的大小重要：**分配器不是进程里的一个全局设施，是个可以传来传去的值**。函数签名里写 `Allocator`，就像写 `u32` 一样，没有仪式感。而「接受哪个分配器」因此成了 API 设计的一部分：函数只声明「我需要分配能力」，至于是栈上的一块预分配内存，还是带泄漏检查的调试堆，调用的时候再定。

## 同一个函数，栈上跑，堆上跑

看一个具体函数：

```zig
const Allocator = std.mem.Allocator;

fn normalize(alloc: Allocator, raw: []const u8) ![]u8 {
    var start: usize = 0;
    var end: usize = raw.len;
    while (start < end and raw[start] == ' ') start += 1;
    while (end > start and raw[end - 1] == ' ') end -= 1;
    const out = try alloc.alloc(u8, end - start);
    @memcpy(out, raw[start..end]);
    return out;
}
```

去掉首尾空格，返回新分配的字符串。这个函数不关心内存从哪儿来——那是第一个参数的事。于是同一份代码可以跑在完全不同的策略上：

```zig
pub fn main() !void {
    var stack_buf: [128]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&stack_buf);

    const a = try normalize(fba.allocator(), "  听雨  ");
    std.debug.print("栈上结果: \"{s}\"\n", .{a});

    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const b = try normalize(gpa.allocator(), "  听雨  ");
    defer gpa.allocator().free(b);
    std.debug.print("堆上结果: \"{s}\"\n", .{b});
}
```

第一次调用，内存在 `main` 的栈帧里，函数返回时连分配器的影子都不剩；第二次调用走调试堆，有泄漏检查、有越界保护。`normalize` 一个字都没改。

这就是「分配是策略」的意思。别的语言里策略被语言选定：Java 里你只有堆，逃逸分析是编译器背着你做的优化；Rust 里你默认只有一个全局分配器，想换得动 `#[global_allocator]`，是全局属性不是调用属性。Zig 把选择权下放到每一次调用。

## 标准库是一柜子策略

既然分配器只是「实现了那张函数表」的值，标准库自然就可以摆一柜子现成的策略，各有各的适用场景：

- **`DebugAllocator`**：调试用。每次分配记录来源，`deinit()` 时没还的内存逐块报告，文件行号精确到位；free 时检查「这块是不是真的分配过、有没有被释放过」。
- **`ArenaAllocator`**：批量管理。分配只进不出，`deinit()` 一次性整批归还。下文单独讲。
- **`FixedBufferAllocator`**：给定一块现成内存（栈上的数组、mmap 来的页），在这块里面切分。零系统调用，代价是大小封顶。
- **`page_allocator`**：直接向操作系统要页，最底层。
- **`smp_allocator`**：多线程场景的高性能分配器，ReleaseFast 下的默认选择。

有意思的是连「程序默认用哪个」都被摆在了明处。看 0.16.0 标准库 `start.zig` 里的这段逻辑：Debug 构建用 `DebugAllocator`；链接了 libc 就用 `c_allocator`；ReleaseFast 且多线程用 `smp_allocator`。没有哪个分配器是「内定」的，都是按构建模式查表选出来的普通策略——你自己的代码里可以做同样的选择，用同样的方式。

## 场景：处理一个请求

策略柜子要放进场景里，差异才显形。拿一个典型任务：处理一个 HTTP 请求——解析三行 header，用完释放。

逐块管理是这个任务在 C 里的传统长相：三个 header，每个的名字、值各 `dupe` 一次，加上一个动态数组，一共七块内存。请求结束时要还七次，漏一次就是泄漏；解析到一半失败，还得靠上一篇讲的 `errdefer` 把已分配的逐块回收。

换 `ArenaAllocator`：

```zig
const headers = try parseHeaders(arena.allocator(), raw);
for (headers) |h| {
    std.debug.print("  {s} = {s}\n", .{ h.name, h.value });
}
// 没有循环 free，没有 errdefer——请求结束，arena 一笔勾销
```

再换 `FixedBufferAllocator`，把整块缓冲区放在栈上：

```zig
var stack_buf: [512]u8 = undefined;
var fba = std.heap.FixedBufferAllocator.init(&stack_buf);
try handleRequest(fba.allocator());
```

我把同一个解析函数在三种策略下都跑了一遍，输出一模一样——三个 header 原样解析出来。区别全在背后：逐块版还了七次内存；arena 版一次 `deinit`；FixedBuffer 版从头到尾零次系统分配，请求处理的热路径上连堆都没碰过。**同一份业务代码，性能特征和安全特征由外挂的策略决定**——这是「分配是参数」的直接收益。

GC 语言处理这个场景靠分代回收和逃逸分析，程序员祈祂数据别逃出栈帧太远；C++ 靠一串 RAII 对象在作用域结束鱼贯析构。它们都能把这件事做好，但策略都写死在语言假设里。Zig 这里没有假设，只有一个参数。

## arena：对析构函数的另一种回答

`ArenaAllocator` 值得单独一节，因为它是对「没有析构函数怎么办」最 Zig 的回答：不管理单个对象的生命周期，管理一批。

上一篇的 `Reader.init` 还记得吗：三块内存，三个 `errdefer`，失败路径逐块回收。用 arena 重写：

```zig
const Reader = struct {
    index: []u8,
    body: []u8,
    notes: []u8,

    fn init(a: Allocator) !Reader {
        const index = try a.alloc(u8, 16);
        const body = try a.alloc(u8, 64);
        const notes = try a.alloc(u8, 8);
        return .{ .index = index, .body = body, .notes = notes };
    }
};

pub fn main() !void {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();

    var arena: std.heap.ArenaAllocator = .init(gpa.allocator());
    defer arena.deinit(); // 成功、失败，一行全兜住

    const reader = try Reader.init(arena.allocator());
    _ = reader;
}
```

三个 `errdefer` 全部消失。失败路径不再是「逐块还」，而是「整个 arena 不要了」——`init` 里任何一步失败，错误冒泡到顶层，`defer arena.deinit()` 一笔勾销。上一篇结尾说 Zig 逼你回答「这块资源的失败路径归谁管」；arena 给出的答案是：**归批管**。把生命周期相同的资源放进同一个批，清理问题从「N 个」塌缩成「一个」。

这个模式有个专门的适用面：生命周期天然成批的场景——解析一次请求、编译一个文件、处理一条消息。Zig 自己的编译器就在大量使用 arena。反过来，生命周期参差的资源（缓存、长连接）硬塞进 arena，就是用内存换省事，得想清楚。

## 我踩的坑：arena 的 free 几乎是个空操作

写这篇的实验时我撞上了一个必须诚实记录的语义：`ArenaAllocator` 也实现了 `free`，但它几乎总是什么都不做。

我最初以为 arena 里的 `free` 至少会让后续分配复用那块空间。实测打脸，设计了一个对照实验：

```zig
// 两组各建一个 arena，组一：
const A = try a.alloc(u8, 16);
const B = try a.alloc(u8, 16);
a.free(B);          // B 是最后一块
const D = try a.alloc(u8, 16);
std.debug.print("容量: {d}\n", .{arena.queryCapacity()});

// 组二：
const A = try a.alloc(u8, 16);
const B = try a.alloc(u8, 16);
const C = try a.alloc(u8, 24); // 占掉剩余空间
a.free(B);          // B 前面有 A、后面有 C
const D = try a.alloc(u8, 16);
std.debug.print("容量: {d}\n", .{arena.queryCapacity()});
```

输出：

```text
[末尾] A+B 后容量: 62
[末尾] free(B) 后分配 D(16)，容量: 62
[中间] A+B+C 后容量: 62
[中间] free(B) 后分配 D(16)，容量: 88
```

同样的 `free(B)`、同样的再分配：B 在末尾时，回退生效，D 原地复用，容量纹丝不动；B 被夹在中间时，free 是静默空操作，D 只能逼着缓冲区从 62 扩张到 88。真实语义一句话：**只有当被 free 的恰好是最后一块分配时，才回退内部指针；其余情况静默忽略**。不是 bug，是设计——按分配顺序回退是 O(1) 的，任意回收就得维护空闲链表，那就不是 arena 了。

所以 arena 的正确用法是干脆不 free，等 `deinit` 或 `reset`。`free` 在接口里存在只是为了让 arena 能被传给「签名要 Allocator」的函数，语义上它是个安慰剂。踩过这个坑之后我再读 arena 的文档，那句「allocations are only freed en masse」才真正看进眼里——文档说了，但我以为自己可以例外。

顺带还有一个相邻的坑：`DebugAllocator` 的 `free` 要求地址和长度与分配时精确一致。我从 `normalize` 拿到的字符串上切了个子串去 free，当场被按住：

```text
thread panic: Invalid free
/usr/lib/zig/std/heap/debug_allocator.zig: in free
```

C 程序员对这套不陌生——`free` 本来就只认指针。但 Zig 的调试分配器把「free 了不该 free 的东西」从深夜崩溃提前成了当场报错，这个体验值得点个赞。

## 没有隐藏分配

Allocator 作为参数还有个副产品：**所有分配在源码里都看得见**。想分配，就得有分配器；有分配器，它就在参数列表里。格式化一个字符串也不例外：

```zig
const greeting = try std.fmt.allocPrint(a, "{s} 的第 {d} 篇文章", .{ "kaiven", 3 });
defer a.free(greeting);
std.debug.print("{s}\n", .{greeting});
```

```text
kaiven 的第 3 篇文章
```

对比一下：Java 里 `+` 拼字符串背后的分配不在源码里；Rust 的 `format!` 也不需要你指明分配器，因为有一个全局的默认在。Zig 里没有这个「默认」——任何一行分配代码，往上翻几层签名，一定能找到一个由某人明确选择的分配器。审计内存行为时，这条路是闭合的。

有个细节我挺喜欢：Zig 程序的 `main` 自己就跑在一个 arena 里。标准库的启动代码先用 `page_allocator` 建了个 arena，`main` 期间的所有「顺手分配」都进这个批，退出时整批归还。语言自己对 arena 的用法，和它教用户的用法，是同一套。

## 代价，认真地

**传参的啰嗦。** 每个可能分配的函数都要带一个 `Allocator` 参数，三层调用就是三层传递。库作者还要决定：分配器进结构体存着，还是每次调用传？两种都有道理，也都是要做的决定。GC 语言里这些决定统统不存在——代价是不存在的不等于没有，只是你不用看。

**free 的语义要自己背。** arena 的 free 是安慰剂，`DebugAllocator` 的 free 精确匹配，`FixedBufferAllocator` 的 free 同样只回退末尾。同一个接口，四种脾气。语言把分配下放成策略，就得接受策略之间行为有差异——接口统一，语义不承诺统一。

**use-after-free 无人兜底。** 这是显式管理绕不开的深渊。我实测了一把：Debug 构建下读已释放的内存，崩溃报告带着精确的源码行号，那一刻几乎是欣慰的：

```text
Segmentation fault at address 0x7f568db80000
ex-uaf.zig:11: in main — std.debug.print(... buf[0] ...)
```

同样的代码换 ReleaseFast，五次运行，五次静默退出，退出码 139，一个字的报告都没有。崩溃还在，诊断没了。DebugAllocator 的保护是策略提供的，策略有开关，而发布构建通常都关。悬垂指针这件事，Zig 给了你抓它的工具，没替你保证抓得住。

**非内存资源不在管辖内。** 文件、锁、连接，这些没有「分配器」概念的资源，依然只有上一篇的 `defer` / `errdefer`。Allocator 解决的是内存这一类的批量管理问题，不是所有资源问题。

---

三篇了，可以合龙了。comptime 找回的原语是「求值时机」——一个标注替了宏、模板、反射三门手艺；错误处理找回的原语是「错误是值」——传播和清理拆回两件事；这一篇找回的是「分配是调用方的决策」——内存管理从语言特性降回一个参数。三次做的是同一个动作：把别的语言焊死在语言里的东西拆下来，交还给写代码的人。

三次也共享同一份代价：Zig 不替你省决定。求值时机、错误路径、内存策略，每一项都要你自己拍板，拍错了编译器或运行时会如实相告。喜欢这个安排的人说这叫诚实——每行代码的代价摆在明面；不喜欢的人说这叫负担——凭什么别的语言能替我做的事，这里全要我自己来。两边我都能理解，但写完这三篇我确定了一件事：这些设计之间有真正的内在一致性，不是标新立异的堆叠。一个把「决定权交还调用方」当纲领执行到底的语言，值一个观察者的三篇文章。

天阴了一天，像是要下雨。该收笔了，雨来了正好听。
