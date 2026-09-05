---
title: 先写的不是先到的：Zig 的原子操作与内存顺序
description: 生产者先写数据再挂标志，消费者先见到标志再读数据，两边的记录各自都对，合在一起却未必对得上。本文以两栏交错的时间记录为骨架，拆开原子性、可见性、release/acquire 与全序。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-05
tags: [Zig, 编程语言]
---

```text
P 09:41:00  数据写完。挂出 ready。
C 09:41:00  看见 ready。读取数据。
```

两栏都是真的。

生产者的记录里，数据在前，标志在后；消费者的记录里，标志已经抵达，数据却未必跟着抵达。单线程时，一本日记足够说明先后。多出一个线程，便多出一份观察；两边各自保持顺序，不代表世界天然只有一条所有人同时看见的时间线。

上一篇让数据跨过 Zig 与 C 的桥，这一篇让数据跨过线程。前者要对齐 calling convention，后者要建立 memory ordering；两种边界都允许字节抵达，却不自动保证语义一同抵达。

Zig 0.16.0 已提供完整的原子内建与 `std.atomic.Value`，但语言参考尚未写出一套完整、正式的 Zig 内存模型。本文涉及 happens-before、release sequence 和全序的解释，依据当前编译器对 LLVM 原子语义的映射与标准库用法；API 签名以 Zig 0.16.0 语言参考为准，ordering 枚举取自 `std.builtin`，合法组合则以编译器的 comptime 检查为准。三层会明确分开，不借别人的术语替 Zig 写一份尚未完成的规范。

代码与输出均在 Zig 0.16.0、x86_64 Linux 上复核。

## 两个时刻，各记各的

先看最朴素的数据交接：

```zig
var payload: u64 = 0;
var ready: bool = false;

fn producer() void {
    payload = 42;
    ready = true;
}

fn consumer() u64 {
    while (!ready) {}
    return payload;
}
```

人眼沿源码向下读，自然得到一条顺序：

```text
P1 写 payload
P2 写 ready
C1 读 ready == true
C2 读 payload
```

于是似乎可以推出：既然消费者看见了 P2，P1 必然也已完成。

但按当前编译器采用的 LLVM/C++ 内存语义推论，这段程序首先就不合法：两个线程并发读写普通 `ready`，且没有同步，构成数据竞争；生产者写 `payload` 与消费者读 `payload` 同样没有建立跨线程顺序。Zig 0.16.0 的语言参考尚未明文规定数据竞争的后果，因此这里不把这项推论冒充已经写定的 Zig 规范。

在循环里加 `yield`，不能修正它：

```zig
while (!ready) {
    std.Thread.yield() catch {};
}
```

等待得更礼貌，不等于建立同步。把变量改成 `volatile` 也不行。Zig 语言参考明说，volatile 与并发、原子操作无关；它主要服务于内存映射 I/O。

问题不是消费者等得不够久，而是两份记录之间没有一条语言承认的先后关系。

## 原子性只管这一笔完整

先把标志改成原子值：

```zig
const std = @import("std");

var ready = std.atomic.Value(bool).init(false);
```

写入与读取都要明确给出 ordering：

```zig
ready.store(true, .monotonic);
const observed = ready.load(.monotonic);
```

`.monotonic` 对应当前 LLVM/C++ 语义中的 relaxed ordering。它保证对 `ready` 自身的访问是原子的，并维持这个原子对象的 modification order；它不把旁边普通变量的写入一起发布。

因此下面的意图仍没有成立：

```zig
fn producer() void {
    payload = 42;
    ready.store(true, .monotonic);
}

fn consumer() u64 {
    while (!ready.load(.monotonic)) {
        std.atomic.spinLoopHint();
    }
    return payload;
}
```

标志不会被撕成半个 `true`，却没有一条同步边要求消费者在读到 `true` 后也看见 `payload = 42`。

原子性回答的是“这一笔会不会被并发访问撕裂”；内存顺序回答的是“别的读写能否随这一笔建立先后”。两件事常在同一个 API 上出现，却不是同一份保证。

```text
P 09:43:12  ready 已完整写成 true。
C 09:43:12  ready 已完整读成 true。
```

两边对这一位布尔值没有争议。争议仍在旁边那份普通数据。

## release 与 acquire：一次交接

发布数据的惯用形式是：生产者先写普通数据，最后用 release store 发布标志；消费者先用 acquire load 接住标志，再读普通数据。

```zig
var flag = std.atomic.Value(u32).init(0);
var payload: u64 = 0;

fn producer() void {
    payload = 42;
    flag.store(1, .release);
}

fn consumer() u64 {
    while (flag.load(.acquire) == 0) {
        std.atomic.spinLoopHint();
    }
    return payload;
}
```

当前实现采用的 LLVM/C++ 内存模型中，若 acquire load 读到了 release store 写出的值，二者建立 synchronizes-with；生产者在 release 之前的操作，通过这条边 happens-before 消费者在 acquire 之后的操作。

可以把两栏对成四行：

```text
生产者                         消费者
P1  payload = 42
P2  flag.store(1, .release) ──┐
                              ├── synchronizes-with
                         ┌────┘
                         C1  flag.load(.acquire) == 1
                         C2  read payload
```

P1 在 P2 之前，P2 同步到 C1，C1 又在 C2 之前。于是 P1 happens-before C2，消费者可以合法读取 `42`。

本机运行：

```text
consumer saw payload = 42
```

输出不是证明，ordering 才是证明。测试只是确认实现与推理没有明显背离。

## 先写的，为何可能后到

生产者没有撒谎。它确实按源码顺序执行了“写数据，再写标志”。问题在于程序顺序不是另一颗核心看见写入的时间表。

中间至少有两层可以影响观察顺序：

- 编译器会在不破坏单线程可观察行为的前提下重排或消除内存操作；
- 处理器有缓存、store buffer 与自身的内存模型，不同写入对其他核心可见的时刻可能不同。

原子 ordering 同时约束编译器与目标架构的 lowering。release 禁止必要的先前访问越过发布点，acquire 禁止必要的后续访问越过接收点；目标后端再用相应指令或屏障实现这份约束。

在 x86_64 上，release store 与 monotonic store 常常都只是一条普通 `mov`，acquire load 与 monotonic load 也可能生成相同的 `mov`。这不表示 ordering 没有意义。

一方面，语义仍约束编译器重排；另一方面，换到 AArch64 等较弱内存序架构，acquire/release 可能需要不同指令。代码若只因 x86 硬件顺序较强而“跑得一直正确”，移植以后才会显出缺口。

汇编相同是某次 lowering 的结果，源码 ordering 才是程序跨优化器与架构携带的意图。

## 六种 ordering，不是一条简单刻度

Zig 0.16.0 的 `std.builtin.AtomicOrder` 包含：

```zig
pub const AtomicOrder = enum {
    unordered,
    monotonic,
    acquire,
    release,
    acq_rel,
    seq_cst,
};
```

它们不能任意放进每个操作：

| 操作 | 可用 ordering |
| --- | --- |
| atomic load | `unordered`、`monotonic`、`acquire`、`seq_cst` |
| atomic store | `unordered`、`monotonic`、`release`、`seq_cst` |
| atomic RMW | `monotonic`、`acquire`、`release`、`acq_rel`、`seq_cst` |
| compare-exchange 成功 | `monotonic`、`acquire`、`release`、`acq_rel`、`seq_cst` |
| compare-exchange 失败 | `monotonic`、`acquire`、`seq_cst`，且不得强于成功序 |

ordering 是 comptime 参数，非法组合会在编译时被拒绝。例如 load 不能使用 `.release`，失败的 compare-exchange 也不能使用 `.release`：失败路径只读到当前值，没有任何新值可供发布。

`.unordered` 比 `.monotonic` 更弱，在当前 C 后端中二者都会映射为 relaxed；它只适用于 load/store。工程代码若没有明确理由，通常从 `.monotonic` 开始表达“只要该原子本身正确”更容易与既有内存模型术语对照。

`.seq_cst` 不只是“更强的 acquire/release”。它还要求所有 sequentially consistent 操作进入一条全局单一顺序，解决某些仅靠成对发布无法约束的多方观察问题。

## release/acquire 是成对的，不是广播

```text
P 10:05:01  我用 release 写了 flag。
C 10:05:02  我用 acquire 读到那次写入。
O 10:05:03  我只做 monotonic load。
```

P 与 C 建立同步，不代表第三个观察者 O 自动获得同一保证。acquire 必须读到相应 release 写入，或由 release sequence 连接的值，才建立那条 happens-before 路径。

同样，消费者若 acquire 读到的是旧值 `0`，它也不能据此访问 payload；必须继续等待，直到读到发布值。

这就是为什么发布协议要把“数据已完成”集中在一个明确的原子状态上。若用多个标志分别发布同一批数据，每个消费者又读取不同标志，局部的 release/acquire 关系未必能拼出需要的全局结论。

同步是一条有方向、有端点的边，不是一阵吹过所有线程的风。

## `cmpxchg`：成功与失败各有一条时间线

compare-exchange 比普通 load/store 多一层：它可能成功，也可能失败。

Zig 内建返回 `?T`：

```zig
const old = @cmpxchgStrong(
    T,
    ptr,
    expected,
    desired,
    success_order,
    failure_order,
);
```

返回 `null` 表示当前值等于 expected，交换成功；非 null 则返回实际旧值。

一个最小自旋锁可以写成：

```zig
const SpinLock = struct {
    const State = enum(u8) { unlocked, locked };

    state: std.atomic.Value(State) = .init(.unlocked),

    fn lock(self: *SpinLock) void {
        while (true) {
            if (self.state.cmpxchgStrong(
                .unlocked,
                .locked,
                .acquire,
                .monotonic,
            ) == null) return;

            while (self.state.load(.monotonic) == .locked) {
                std.atomic.spinLoopHint();
            }
        }
    }

    fn unlock(self: *SpinLock) void {
        self.state.store(.unlocked, .release);
    }
};
```

成功获取锁时需要 acquire，接住前任持锁者 release unlock 之前的临界区写入；交换失败只得到当前锁状态，用 monotonic 即可。

`cmpxchgWeak` 允许虚假失败，即当前值等于 expected 也可能报告失败。它适合本来就会重试的循环，在某些架构上能更直接映射机器指令；只尝试一次的场景通常用 strong。

本机四个线程各在锁内递增二十万次，最终结果：

```text
counter = 800000
```

这个数字说明本次实现运行符合预期；锁是否正确，仍要从 acquire/release 的交接关系证明。

## 两面旗子，需要一条全序

release/acquire 很适合单向发布，但并非所有算法都只需要两方交接。

设两个线程分别写 `x`、`y`，随后读取对方：

```text
线程 A                         线程 B
x.store(true, release)         y.store(true, release)
read_y = y.load(acquire)       read_x = x.load(acquire)
```

若两个 acquire 都没有读到对方的 release 写入，就没有 synchronizes-with 边。当前 LLVM/C++ 模型允许 `read_x == false` 且 `read_y == false`。

如果算法要求所有参与者对这些原子操作共享一条全局顺序，可以把相关操作提升为 `.seq_cst`。在 sequentially consistent 的单一全序中，两次 store 不可能都排在对方 load 之后，因此两个读取不能同时为 false。

代价由平台决定。x86 上 seq_cst store 常需要 `xchg` 或等价的强指令，而普通 release store 可能只需 `mov`；其他架构则通过不同屏障和原子指令实现。

不要因为 release/acquire 比 seq_cst “更快”就先用它。先写清算法需要两两同步，还是需要所有原子操作进入一条共同秩序；再选恰好足够的 ordering。

## 没有 `@fence` 的 0.16.0

旧资料里可能看到：

```zig
@fence(.seq_cst);
```

Zig 0.16.0 会直接报错：

```text
error: invalid builtin function: '@fence'
```

`@fence` 从 Zig 0.14 起已经移除。原因之一是 C11 风格 fence 影响周围多项原子操作，难以被 ThreadSanitizer 准确建模；常见需求可以通过提升相关原子操作的 ordering，或增加明确的原子操作表达。

因此，新代码不应从旧教程抄回 `@fence`，标准库也没有一枚同义的 `std.Thread.fence` 可供替换。需要 StoreLoad 全序时，应让参与协议的操作本身使用 `.seq_cst`。

被移除的不只是一个函数名，也是一种把同步关系写在协议之外的习惯。

## 原子字段不会让整个结构体自动安全

发布示例里，`payload` 是普通变量，只有 `flag` 是原子变量。这并不矛盾，因为协议保证：

- 发布之前，只有生产者写 payload；
- acquire 成功之后，消费者才读 payload；
- 两者之间存在 happens-before。

若消费者在看到 flag 前就读 payload，或生产者在发布以后继续无同步修改，普通变量仍会发生数据竞争。

```zig
const State = struct {
    generation: std.atomic.Value(u64),
    name: []const u8,
    count: usize,
};
```

`generation` 是原子的，不会给 `name` 和 `count` 自动镀上一层线程安全。每个普通字段都必须由同一份同步协议、锁或线程所有权保护。

volatile 更不能代替 atomic。它要求某些内存访问真实发生，适合 MMIO；它不提供跨线程原子性，也不建立 happens-before。

原子操作保护的是明确参与协议的那几笔访问，不是它附近的所有字节。

## 一次初始化与单生产者队列

release/acquire 的发布模式可以继续扩展。

一次初始化可以让一个线程构造数据，再发布完成状态；其余线程 acquire 读取状态后共享结果。实测四个线程最终都看到 `42`：

```text
once-init: all threads saw 42: true
```

单生产者、单消费者环形队列则让生产者先写槽位，再 release 更新 tail；消费者 acquire 读取 tail 后再读槽位。反方向由消费者 release 更新 head，生产者 acquire 确认空位可重用。

本机传递十万项，顺序完整：

```text
SPSC OK: 100000 items in exact order
```

这些结构适合原子协议，是因为每个位置由谁写、谁读、哪一个索引负责发布都能明确列出。参与者一多、状态一复杂，证明成本会急剧上升。

多数共享状态并不需要手写无锁算法。`std.atomic.Mutex` 提供 `tryLock` / `unlock` 的朴素原子锁，Zig 0.16.0 的阻塞同步原语则已转向 `std.Io.Mutex` 等接口。先用锁把所有权与临界区说清，往往比过早追求 lock-free 更快，也更容易验证。

## 没有默认 ordering，是一种提醒

`std.atomic.Value` 的每次操作都要求明确给出 ordering：

```zig
counter.fetchAdd(1, .monotonic);
ready.store(true, .release);
ready.load(.acquire);
```

Zig 没有替所有原子操作默认选择 `.seq_cst`。这与 allocator 由调用者传入、整数溢出由操作符说明、错误由调用方处理，是同一种语言倾向：成本与语义不藏在默认行为里。

但显式并不自动意味着正确。写下 `.monotonic` 很容易，证明它足够则可能需要完整画出每条同步边。若没有能力证明较弱 ordering，`.seq_cst` 或成熟锁通常是更好的起点。

内存顺序不是性能口令，也不是从弱到强逐级试跑。它描述算法允许哪些观察；选错以后，压力测试可能仍安静地通过数十亿次。

## 测试只能发现反例，不能完成证明

错误的 monotonic message passing 在本机 x86_64 上反复运行，消费者仍可能每次都读到正确 payload。x86 的强内存顺序替程序遮住了缺口，编译器也未必在这个小例子里作出能暴露问题的重排。

反过来，正确的 release/acquire 版本运行五十次全部通过，也不构成数学证明。并发执行的交错数量巨大，一次压力测试只看见其中极少部分。

可采用的工程手段包括：

- 从 ordering 规则画出 happens-before 图；
- 在 AArch64、RISC-V 等较弱内存序架构上测试；
- 使用 ThreadSanitizer 等工具寻找数据竞争；
- 对状态空间较小的算法做模型检查；
- 压力运行，用来发现反例，而不是宣布没有反例；
- 优先选择标准库同步原语，减少自建协议。

文章中的运行输出都只能说明探针成功执行，不能证明所有 interleaving 都正确。并发代码最危险的胜利，是在一台机器上运行很久，从未失败。

## 代价，对表以后再说

**较强 ordering 可能有成本，也可能在当前架构上与较弱 ordering 生成同一条指令。** 性能不能靠枚举名字心算。应在目标平台、真实竞争强度与实际数据结构上测量。

**较弱 ordering 把成本转移给证明。** 少一条屏障可能换来更复杂的 happens-before 推理、更困难的代码审查和更高的跨架构测试要求。机器省下的，往往由人补上。

**自旋会消耗处理器时间。** 极短临界区、低竞争和无法阻塞的环境适合自旋；普通应用中的长等待通常应使用 mutex、semaphore 或事件机制。

**false sharing 会让无关原子彼此拖累。** 两个线程即使更新不同变量，只要它们落在同一 cache line，缓存一致性流量仍会来回争夺。Zig 提供 `std.atomic.cache_line` 供布局时参考，但具体收益仍需测量。

**生命周期与内存顺序是两份证明。** acquire 能保证发布前写入对当前读取可见，不能让已经释放的指针重新有效。若 payload 中含切片或指针，上一篇的所有权问题仍然原封不动。

---

```text
P 23:58:00  payload 写完。release 发布 flag。
C 23:58:00  acquire 读到 flag。payload 是 42。
```

两份日记第一次可以在同一条关系上对表。

不是两颗核心的时钟忽然一致，也不是所有内存操作从此排成一列。只是 P2 与 C1 之间建立了一条同步边，于是 P1 发生在 C2 之前。happens-before 没有消灭并发，只为必须有先后的那部分事实写下方向。

有些计数只需 monotonic，有些交接需要 release/acquire，有些多方协议必须进入 seq_cst 全序。ordering 越弱，允许的世界越多；写下它的人，便要证明自己能在每一个允许的世界里得到正确答案。

两栏记录到此合上。线程仍各自前行，只在真正需要相遇的地方，共享同一个先后。
