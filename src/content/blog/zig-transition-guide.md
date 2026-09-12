---
title: 入境先开箱：从 C++、Rust、Go、Python 带进 Zig 的直觉，哪些得留下
description: 没有人空着手学新语言。RAII 的肌肉记忆、借用检查的安全感、runtime 的托底、万物皆对象的常识：四门语言的行李在 Zig 分成三堆，直通可用的、换形态可用的、恰好不成立的。一张把系列十七篇缝起来的地图。Zig 代码在 0.16.0 上验证，对照语言 go1.27、g++ 16.2、rustc 1.97、Python 3.14 实测。
pubDate: 2026-09-09
category: zig
tags: [Zig, 编程语言]
---

这个系列写到第十八篇了。分配器、指针、切片、comptime、错误处理、对象模型、测试……每篇拆解一个主题，拆的时候假设读者是一张白纸。

但没有人是白纸。你带着十年 C++ 的析构肌肉记忆、三年 Rust 的借用检查安全感、无数个 Go 的 `if err != nil`，或者 Python 的万物皆对象来了。这些行李里，有些在 Zig 直接可用，有些换个形态还能用，还有一些带进来是要出事故的。

C 互操作那篇写过一条边界：数据过界要申报，函数原型要备案，返回码要在包装层翻译。这一次是更大的迁移：整门语言。这篇按三堆整理：直通（直觉落地就能用）、改造（直觉是对的，但形态要换）、没收（在 Zig 里恰好不成立，而且越本能越危险）。

这一篇是地图，每条判断一句话，深处有链接。Zig 一侧以 0.16.0 为准；对照语言的输出也全部实测：go1.27.1、g++ 16.2.1、rustc 1.97.1、Python 3.14.7。

## 从 C 来：你已经到家

先给最舒服的人。指针就是指针，手动管理就是手动管理，没有隐藏控制流、没有语法糖劫持，C 程序员在 Zig 落地当天就能干活。

改造两件：宏换成 comptime（没有预处理器，字符串拼接和条件编译都是普通代码）；头文件换成文件即模块（`@import` 声定的就是边界，`pub` 就是可见性）。C 互操作那篇整篇都在讲这条边界怎么过，连 `translate-c` 都进了构建系统。

要没收的几乎没有，除了「这个语言很原始，大概也没什么工具」这个错觉本身。C 没给过你的东西这里都有：测试是语言内置的、泄漏检查精确到行号、模糊测试开箱即用、交叉编译是一条参数。从 C 来的最大风险不是带错行李，是低估了目的地。

## 从 C++ 来：作用域是静音的

C++ 程序员的耳朵被训练得很好：对象离开作用域，耳边应当响起析构的声音。这个直觉在 Zig 会被没收，而且没收得悄无声息。

看同一个小类型在两边的命运。C++ 版，栈上的 `Session`，作用域结束：

```cpp
struct Session {
    char* token;
    Session() : token(new char[7]) { std::strcpy(token, "kaiven"); }
    ~Session() { delete[] token; std::puts("析构自动执行"); }
};

int main() {
    { Session s; }
    std::puts("作用域已结束");
}
```

```text
析构自动执行
作用域已结束
```

清理先于结束，自动，必然。Zig 版，对象模型那篇的 `init`/`deinit` 惯例，只是这次忘了调 `deinit`：

```zig
const s = try Session.init(allocator, "kaiven");
_ = s;
std.debug.print("正常结束\n", .{});
```

编译器一个字不说。程序正常打印「正常结束」；如果你用的是 `DebugAllocator`，退出时报告泄漏，行号指向分配现场。没有 `deinit` 的调用，就没有清理；作用域结束的时候，什么都不会发生。

你带走的最重要的一件行李是「清理是类型系统的义务」这个假设，它在这里不成立。清理是 `defer` 语句的义务：写在哪里就执行在哪里，不挂在类型上。

直通的不也不少：对未定义行为的警觉直通安全模式篇（C++ 的 UB 是「一切皆有可能」，Zig 把它写进了四种构建模式的规则里）；迭代器失效的直觉直通切片篇的失效规则表（`ArrayList.items` 在扩容后作废，和 vector 一个脾气）；对成本的习惯性敏感在这里处处有用。

改造的几件：模板换成 comptime（一个机制顶 C++ 三门手艺的活，comptime 篇看过）；智能指针换成指针家族加惯例所有权（没有 `unique_ptr` 的类型系统背书，`toOwnedSlice` 那样的移交靠函数文档写明）；移动语义换成明晃晃的值语义：赋值即拷贝，没有隐藏的 move 构造，对象模型篇实测过两个 `Box` 互不影响。

## 从 Rust 来：编译器不再替你免疫

Rust 程序员要交出的行李只有一件，但它是整件行李箱：「编译通过，就没有内存安全问题」。

拿切片篇用过的例子，让悬空切片现形。返回局部数组的切片：

```zig
fn escaped() []const u8 {
    var buffer: [8]u8 = undefined;
    return buffer[0..];
}
```

Zig 0.16.0 编译通过。拿到的是一份 `len` 为 8 的切片，底层存储已随栈帧结束。编译器抓住了 `return &buffer` 那个直白的写法，绕一步就放行。同一件事写给 Rust：

```rust
fn escaped() -> &[u8] {
    let buffer = [0u8; 8];
    &buffer[..]
}
```

```text
error[E0106]: missing lifetime specifier
  |
1 | fn escaped() -> &[u8] {
  |                 ^ expected named lifetime parameter
```

rustc 连机会都不给：返回引用必须交代它活多久。这就是两门语言最深的那道分歧：Rust 把检查的成本放进编译期（借用检查器、生命周期标注），Zig 把它放进人的纪律加运行期工具（Debug 构建的安全检查、`DebugAllocator` 的显影）。切片篇的结论原样适用：编译器会抓住一部分明显错误，但没有因此成为借用检查器。

丢了安全网，换到的东西也数一数。错误处理直觉几乎全部直通：`?` 换成 `try`，`Result<T, E>` 换成 error union，哲学完全一致，错误是值、传播是显式、签名里写得见。错误处理篇讲过差别：清理不挂在 `Drop` 上，挂在 `errdefer` 上。测试文化也直通：`cargo test` 的位置站着 `zig build test`，测试篇讲过它连泄漏都逐个测试核账。

改造的：trait 换成两副面孔，编译期鸭子类型是 `anytype`（比 trait 更松，接口不再需要被声明），运行期多态是手写 vtable（Allocator 就是范本），对象模型篇有完整的对照表；`cargo` 换成 `build.zig` 加 `build.zig.zon`，没有中央仓库，依赖是 URL 换哈希，工具链篇实测过全流程。

从 Rust 来的人真正的坎不是语法。是那个每天千百次发生、从不出错的推断（「它编译过了」），从今往后要重新学着自己做。

## 从 Go 来：运行时不再托底

Go 程序员的行李检查最有戏剧性：一半直通，一半没收，而且两半都出人意料。

先说直通的，多到近乎惊喜。slice 的心智模型：Go 的 slice 是 `(指针, 长度, 容量)`，Zig 的切片是 `(指针, 长度)`。指到哪、走多远、不保证谁拥有，这套直觉原样落地，切片篇整篇都是它的展开。「error is a value」的哲学直通 error union，而且 Zig 把 Go 社区争论多年没敢加的那勺糖生在了语言里：

```go
data, err := fetch(url)
if err != nil {
    return nil, err
}
```

```zig
const data = try fetch(url);
```

同一个动作，Go 三行，Zig 一行，语义都是「失败就往上交」。你写惯的四行错误检查，在这里塌缩成一个关键字。小内核的审美本来就是同门：Go 砍继承、砍异常，Zig 砍得更彻底。

字符串长度这条居然也直通。同一个表达式，五门语言实测：

| 语言 | 表达式 | 结果 | 数的是什么 |
| --- | --- | --- | --- |
| Go | `len("听雨")` | 6 | 字节 |
| C++ | `s.size()` | 6 | 字节 |
| Rust | `s.len()` | 6 | 字节 |
| Zig | `"听雨".len` | 6 | 字节 |
| Python | `len("听雨")` | 2 | 码点 |

Rust 想要「字符数」要写 `s.chars().count()`（实测 2），Zig 要 `utf8CountCodepoints`。Go/C++/Rust 的字节直觉直接带来；Python 的是下一节要没收的。

没收的第一件是 GC。Go 的世界里分配是便宜的、回收是别人的事；Zig 的世界里每一次分配都要有归还计划。allocator 篇整篇在讲这个转变，arena 是「同一日到期」的批量方案，`errdefer` 是失败路径的扫帚。第二件是 nil 万物。Go 的 nil slice、nil map、nil pointer 三件套在这里拆成三种诚实的类型：切片不可空（空切片就是 `len == 0`），映射不可空，指针默认不可空。「可能没有」要写成 `?T`，兜底要写 `orelse`：

```zig
fn findIndex(haystack: []const u8, needle: u8) ?usize {
    for (haystack, 0..) |v, i| {
        if (v == needle) return i;
    }
    return null;
}

const miss = findIndex("听", 'z'); // null
const idx = miss orelse 0;          // 兜底要写明
```

想给普通指针传 null？编译错误，报错里写的是 `expected type '*const u32', found '@TypeOf(null)'`。null 在 Zig 里甚至不是一个值，是 optional 的语法糖之一。

改造的：interface 换成两副面孔。Go 的隐式接口像 `anytype`（`fmt.Stringer` 不用声明实现），Go 的 iface 运行期对像 vtable（`(类型, 值)` 对在这里是 `(ctx, 函数表)`），对象模型篇有对照表。goroutine 换成 `std.Thread`：没有绿色线程、没有调度器藏在 runtime 里（Zig 曾经有过 async，后来整个删掉了，那是另一篇的故事），线程就是线程：

```zig
const t = try std.Thread.spawn(.{}, worker, .{"听雨"});
t.join();
```

```text
[thread] 听雨
[main] join 之后才打印
```

`go func()` 的「发射后不管」换成 `spawn` 加显式 `join`。并发在这里也是显式的，和内存、和错误一样。

## 从 Python 来：动态性住进了编译期

Python 程序员的行李最重，没收得也最多，但有一件意想不到的直通。

先说没收的。万物皆对象：在 Zig 里，值就是值。一个 `u32` 在内存里就是四个字节，没有引用计数、没有类型标签、没有 CPython 那个 16 字节的对象头（引用计数篇看过的那个 `PyObject`，这里根本不存在）。类型信息只活在编译期；`@typeName` 问得出名字，但那是 comptime 的事。运行期的多态数据要么是 tagged union（tag 写在数据里），要么是 vtable（类型装在值里），没有第三条路。

运行期反射一并没收：`getattr`、`type()`、运行期改类的属性，这些 Python 的日常在 Zig 里没有对应物。动态性存在，但搬进了编译期：类型是 comptime 的值，`@typeInfo` 是反射，`@field` 是按名字取声明。comptime 篇的结论在这里适用，编译期执行一个机制顶下宏、模板、反射三门手艺。对 Python 来说更贴切的翻译是：解释器的手感，编译器的纪律。你在 REPL 里养成的「拿来就试、类型当值摆弄」的习惯，在 comptime 里居然能找到熟悉的手感，只是这一切发生在编译期，产物是静态代码。

异常也没收：没有 `try/except` 接住一切，错误是签名里可见的值，错误处理篇讲透了。`dict`/`list` 改造成 `HashMap`/`ArrayList`，类型对得上，但每次操作要带 allocator（分配器篇）。

然后是那张表里 Python 独树一帜的一行：`len("听雨")`。Python 是五门语言里唯一按码点数的，因为 Python 的 str 是真文字对象；Zig 的 `[]const u8` 是字节串，「听雨」六个字节、两个汉字，字符串篇从第一天讲到这里。你的 len 直觉不是错的，是带错了地方。

随身携带的除了 comptime 手感，还有一件：读标准库源码的习惯。Python 程序员天然会翻开标准库看实现，这个习惯在 Zig 是官方推荐动作：标准库就在那儿，一个 `@import` 的事，工具链篇还教了你用 `--verbose` 看它怎么被调起来。

## 一张把十七篇缝起来的地图

四堆行李检查完，把没提到的直觉也登记一遍，每一条背后是系列的一篇：

| 你带来的直觉 | 带自 | Zig 的答案 | 详见 |
| --- | --- | --- | --- |
| 内存自动回收 / new 完就不管 | Go/Java/Python | 分配是参数，归还是契约 | Allocator 篇 |
| 析构函数自动清理 | C++ | `defer`/`errdefer` 语句 | 错误处理篇 |
| 作用域结束 = 资源释放 | C++/Rust | 作用域静音，释放靠显式调用 | 对象模型篇 |
| 编译通过 = 内存安全 | Rust | 工具显影 + 人的纪律 | 切片生命周期篇 |
| 未定义行为不可捉摸 | C/C++ | Illegal Behavior，四种构建模式 | 安全模式篇 |
| 模板 / 泛型约束 | C++/Rust | 类型是 comptime 的值 | comptime 篇 |
| class 组织代码 | 面向对象诸语言 | struct 三重身份 + 惯例 | 对象模型篇 |
| 继承复用行为 | C++/Java | 组合、转发、union、vtable | 对象模型篇 |
| trait / interface | Rust/Go | `anytype` + vtable 两副面孔 | 对象模型篇 |
| 异常 / try-except | C++/Python | error union + `try` | 错误处理篇 |
| string 是文字 | Python | 字节串 + 显式约定 | 字符串篇 |
| cargo / npm | Rust/Node | build.zig + URL 换哈希 | 工具链篇 |
| pytest / go test | Python/Go | test 块 + `std.testing` | 测试篇 |
| goroutine / async | Go/Rust | std.Thread，async 已删除 | 原子序篇、本篇 |

## 这张地图的代价

没收的行李未必是坏行李。RAII 是好发明，借用检查是好发明，GC 也是好发明。Zig 没有宣判它们有罪，只是这个口岸不承运。判断某条直觉「被没收」是事实陈述，说它不好就越界了；多数时候，你只是走进了一个把这些保证从机器手里还给人的语言。

对照有时效。五门语言都在动：Go 每年加糖，Rust 的异步在演化，CPython 都在拆 GIL 了。本文的对照锚定在 2026 年 9 月：Zig 0.16.0、go1.27、g++ 16.2、rustc 1.97、Python 3.14。半年后请按新版本复核，尤其 Zig 自己：它还没到 1.0，搬家比别的语言勤。

四堆行李装不下所有人。你可能从 Java、JavaScript、Haskell 来，本文一节都没给你。但方法是可以带走的：列出你关于内存、错误、类型、组织的默认假设，逐条问「在 Zig 里，谁保证它」。答案要么是一篇文档，要么是一片空白；空白处就是你的学习清单。

地图不是领土。这篇替你省时间的方式是快速定位和避坑，不能替代走进那十七篇。直觉的修正发生在你亲手踩过 `DebugAllocator` 的泄漏报告、亲手被 ReleaseFast 的静默吓过之后。行李检查只是开箱，路要自己走。

---

三堆分完：直通的那堆最轻，指针、显式错误、对边界的警觉。改造的要重新打包：RAII 折成 defer，trait 拆成两副面孔，cargo 换成 build.zig。没收的堆在仓库里，那都是好东西，只是这个语言不进口。

但有一件行李是离开之后才会发现自己带上的：显式性本身。在这里住久了，「分配谁付钱、失败谁清理、数据活多久」写进签名会成为新的本能。等你哪天回到旧语言，会开始想念把成本写在签名明面上的日子。
