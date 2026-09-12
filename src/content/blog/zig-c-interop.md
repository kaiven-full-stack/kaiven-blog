---
title: Zig 与 C 的互操作：从 ABI 到所有权
description: 一份数据从 Zig 交给 C，切片要拆成指针与长度，error 要译成返回码，回调还得带着无类型的 context 原路回来。这篇以一份最小 C 库为全程案例，讲清 ABI、字符串、opaque handle、内存释放与 translate-c 各自负责到哪里。案例全程在 Zig 0.16.0 上编译运行。
pubDate: 2026-09-05
category: zig
tags: [Zig, 编程语言]
---

C 那边，字符串常是一枚以零结尾的裸指针，数组参数只剩地址，失败写进返回码或 `errno`；Zig 这边，切片带着长度，失败可以成为 error，指针还分单项、多项、可选与哨兵。两侧各有各的表达，往来依赖的是同一套 ABI。

数据能不能跨过这条边界，先看形状；过界之后还能不能安全使用，是另一组问题——长度、有效期、所有权、失败语义，ABI 一个都不管。这个系列已经几次走到这条边界上：指针篇见过 `[*c]T`，布局篇核对过 `extern struct`，切片篇追问过借用期限，安全模式篇划清了 panic 的效力范围。这一篇把这些线索放进同一次交接，用一份小型 C 库走完全程。

文中代码与输出全部取自 Zig 0.16.0、x86_64 Linux 上的实测。

## 函数原型：声明只是单方面的

假设 C 库管理一列浮点数据：

```c
typedef struct Series Series;

Series *series_create(size_t capacity);
void series_destroy(Series *series);

int series_add(
    Series *series,
    const double *values,
    size_t count
);
```

Zig 可以手写对应声明：

```zig
const Series = opaque {};

extern fn series_create(capacity: usize) ?*Series;
extern fn series_destroy(series: ?*Series) void;
extern fn series_add(
    series: *Series,
    values: [*c]const f64,
    count: usize,
) c_int;
```

`extern fn` 声明一个实现在别处的符号。参数怎样进入寄存器或栈、返回值怎样交回、符号以什么规则连接，都要遵守目标平台的 C 调用约定。

反过来，Zig 也能向 C 导出函数：

```zig
export fn zig_add(a: c_int, b: c_int) c_int {
    return a + b;
}
```

普通函数或函数指针则可显式写出：

```zig
fn zig_mul(a: c_int, b: c_int) callconv(.c) c_int {
    return a * b;
}

const BinaryOp = *const fn (
    c_int,
    c_int,
) callconv(.c) c_int;
```

`extern` 与 `export` 默认取得目标平台的 C calling convention，`callconv(.c)` 把这件事明写在类型中。

要注意的是，原型只是单方面声明。Zig 编译器能检查这份声明内部是否成立，链接器能寻找同名符号，却不会打开 C 实现去核对参数个数、字段含义和所有权说明。原型写错而恰好链接成功，往往比链接失败更危险。

## 切片跨边界，拆成指针和长度

Zig 里最自然的只读序列是切片：

```zig
[]const f64
```

C 函数却收两个参数：

```c
const double *values,
size_t count
```

包装层负责拆开：

```zig
fn add(
    self: SafeSeries,
    values: []const f64,
) Error!void {
    try statusToError(series_add(
        self.handle,
        values.ptr,
        values.len,
    ));
}
```

出境时，`values.ptr` 与 `values.len` 分开填写；回到 Zig 一侧时，要把 C 的地址与长度重新组成切片：

```zig
const bytes = c_ptr[0..c_len];
```

C 的数组形参本质上仍是指针，不携带长度，不提供 Zig 切片的边界检查，也不自动记住底层分配有多大。长度参数若填错，ABI 完全正确，程序照样越过实际边界——跨语言边界最常见的 bug 就出在这里，两边形状对上了，掌握的信息却差着一份长度。

## `[*c]T`：translate-c 带回来的模糊指针

手写 Zig API 时，通常愿意用更精确的指针类型；translate-c 面对 C 头文件，却经常生成：

```zig
[*c]const f64
```

`[*c]T` 是 C pointer。它要容纳 C 指针常见的含混：可能为空，不知道长度，对齐承诺也比普通 Zig 指针弱。多种 Zig 指针可以向它转换，`null` 也可以；从它回到精确的 `*T` 或切片，则需要显式处理。

例如 C API 返回一个可能为空的字符串：

```zig
const raw: [*c]const u8 = get_name();
```

不要未经判断就调用 `std.mem.span(raw)`。Zig 0.16.0 的实现会对空 C 指针断言，Debug 与 ReleaseSafe 下可能直接 panic。更稳妥的手写声明是：

```zig
extern fn get_name() ?[*:0]const u8;

const name = if (get_name()) |ptr|
    std.mem.span(ptr)
else
    null;
```

这里把两个事实分别写进类型：`?` 表示可能为空，`:0` 表示沿指针前行会遇到零终止符。`std.mem.span` 再把哨兵指针变成带长度的 sentinel slice。

`[*c]T` 的价值在于如实承接 C 的模糊；它不该把模糊继续带进整个 Zig 程序。过界之后，尽早判空、补回长度，收紧成准确的本地类型。

## `extern struct`：两侧一致的布局

C 库还会写出统计结果：

```c
typedef struct Sample {
    double mean;
    uint32_t count;
    int16_t flags;
} Sample;

int series_stats(const Series *series, Sample *out);
```

Zig 侧必须使用 `extern struct`：

```zig
const Sample = extern struct {
    mean: f64,
    count: u32,
    flags: i16,
};
```

本机实测结果：

```text
size=16 align=8
mean=0 count=8 flags=12
```

C 侧的 `sizeof`、`_Alignof` 与 `offsetof` 得到相同数字。

`extern struct` 保证遵循目标平台的 C ABI，包括字段顺序、对齐与 padding。普通 Zig `struct` 没有这份布局保证，即使今天量出来恰好相同，也不能拿来替代。

0.16.0 还收紧了一项边界：enum 或 packed 类型若出现在 extern 上下文中，不能让 backing integer 完全依靠推断，需要明确写出：

```zig
const Status = enum(c_int) {
    ok = 0,
    empty = -1,
    no_mem = -2,
    range = 100,
};
```

旧式 `extern enum` 已不再支持。显式 backing type 让 ABI 不至于由一项隐含选择决定。

两侧布局一致，证明的是字段按同一方式落进内存；字段里的地址是否仍有效、数值是否合法，不在布局保证之内。

## opaque handle：只许持有，不许查看

C 头文件常把实现藏在不完整类型后面：

```c
typedef struct Series Series;
```

Zig 的对应表达是：

```zig
const Series = opaque {};
```

它不能按值实例化，不能读取字段，也不能询问对象内部布局；只能持有指针，再交回知道其真实结构的 C 函数。

一层 Zig 包装可以把句柄的使用范围收紧：

```zig
const SafeSeries = struct {
    handle: *Series,

    fn create(capacity: usize) error{NoMemory}!SafeSeries {
        const handle = series_create(capacity) orelse {
            return error.NoMemory;
        };
        return .{ .handle = handle };
    }

    fn deinit(self: SafeSeries) void {
        series_destroy(self.handle);
    }
};
```

调用处便可以写：

```zig
var series = try SafeSeries.create(4);
defer series.deinit();
```

`opaque` 没有让句柄自动获得所有权语义，真正保证 `destroy` 恰好调用一次的，仍是包装层约定与调用者的 `defer`；它做的只是禁止 Zig 代码窥探一份本不属于自己的布局。

## 返回码在包装层翻译成 error

C API 常用整数报告失败：

```c
#define STAT_OK       0
#define STAT_EMPTY   -1
#define STAT_NOMEM   -2
#define STAT_RANGE  100
```

Zig 包装层不必把这些数字继续传给所有调用者：

```zig
const Status = enum(c_int) {
    ok = 0,
    empty = -1,
    no_mem = -2,
    range = 100,
};

const Error = error{
    Empty,
    NoMemory,
    OutOfRange,
    UnknownStatus,
};

fn statusToError(status: c_int) Error!void {
    return switch (status) {
        0 => {},
        -1 => error.Empty,
        -2 => error.NoMemory,
        100 => error.OutOfRange,
        else => error.UnknownStatus,
    };
}
```

C 返回码在边界内被消费，Zig 一侧的 API 返回普通 error union。这里让底层函数直接返回 `c_int`，再用整数 `switch` 翻译，未知码也能落进 `error.UnknownStatus`；不要先把未经验证的返回值强转成穷尽 enum。

`errno` 更讲究时机。它是一份线程局部的附加状态，任何后续库调用都可能覆盖。一次失败的 C 调用之后，应立即读取：

```zig
const value = series_at(self.handle, index);
const err = std.c.errno(@as(c_int, if (std.math.isNan(value)) -1 else 0));
```

我在本机故意先执行一次调试输出，再读失败的 `open` 所留下的 `errno`，原本的 `ENOENT` 已被 I/O 初始化过程改成另一个值。返回码还在原处，`errno` 已经被后来的调用写过。

若能设计新 C API，显式返回码通常比隐式 `errno` 更容易封装和测试。

## C 字符串：终止符与生命周期是两回事

C 的字符串通常写成：

```c
const char *status_name(int status);
```

若函数保证非空、零终止，并且返回静态存储，手写绑定可以是：

```zig
extern fn status_name(status: Status) [*:0]const u8;
```

使用时恢复长度：

```zig
const name: [:0]const u8 = std.mem.span(status_name(.ok));
std.debug.print("{s}\n", .{name});
```

本机输出：

```text
ok
```

哨兵说明的是在哪里停止，说明不了指针活多久。上例可以长期保存，是因为 C 头文件约定返回静态字符串；若函数返回内部缓冲区，它可能在下一次调用时失效；若返回 malloc 内存，调用者还要负责释放。相同的 `const char *` 可以承载三种完全不同的生命周期，Zig 类型只能表达其中一部分，余下必须从 C API 文档里读出来。

## 谁分配，谁释放

`series_create` 在 C 中使用 `malloc`，`series_destroy` 负责释放。Zig 只保存 handle：

```zig
var series = try SafeSeries.create(4);
defer series.deinit();
```

不能把 `series.handle` 交给 `std.heap.DebugAllocator`、arena 或其他 Zig allocator 的 `free`。指针值可以跨境，分配器内部保存的 bookkeeping 不会跟着走；用错误的释放函数处理一块内存，属于非法行为。

反方向也一样：若 Zig allocator 分配一块内存交给 C 临时使用，C 不应擅自调用 `free`，除非双方明确约定该内存来自兼容的 C allocator。

`std.heap.c_allocator` 是特例，它以 C `malloc` 系列为后端，可以和 C `free` 互通；使用它仍应在 API 上明确所有权，而不是见到裸指针就猜来源。

最稳的边界通常是成对函数：

```c
Series *series_create(size_t capacity);
void series_destroy(Series *series);
```

或者由调用者提供缓冲区，C 只负责填写。谁分配、谁释放、何时失效，应当出现在同一份接口说明里。

## 回调：`void *` 原路返回

C 用函数指针和 context pointer 模拟闭包：

```c
typedef void (*observe_cb)(
    void *ctx,
    size_t index,
    double value
);

void series_observe(
    const Series *series,
    observe_cb callback,
    void *ctx
);
```

Zig 侧的回调必须使用 C calling convention：

```zig
const Observer = struct {
    count: usize = 0,
    sum: f64 = 0,

    fn callback(
        ctx_opt: ?*anyopaque,
        index: usize,
        value: f64,
    ) callconv(.c) void {
        const ctx = ctx_opt orelse return;
        const self: *Observer = @ptrCast(@alignCast(ctx));

        self.count += 1;
        self.sum += value;
        _ = index;
    }
};
```

注册时把对象地址擦成 `void *`：

```zig
var observer: Observer = .{};
series_observe(series.handle, Observer.callback, &observer);
```

C 原样保存并传回 `ctx`，回调再用 `@alignCast` 与 `@ptrCast` 恢复类型。本机四次回调以后：

```text
observer: count=4 sum=10
```

这个指针上没有附带任何类型标签。C 不知道里面是 `Observer`，也不保证地址仍然有效；Zig 的转换只表达「程序员声称它就是这个类型」，成立与否完全靠约定。因此 context 必须活过所有可能的回调，线程规则必须由双方约定，回调函数也不应让 panic 或异语言异常越过 ABI 边界。

## 可变参数：类型必须先说清

C variadic 函数是边界上类型信息最少的一类接口：

```c
double series_dot(size_t count, ...);
```

Zig 声明：

```zig
extern fn series_dot(count: usize, ...) f64;
```

调用时必须显式给出 C 可变参数所要求的类型：

```zig
const result = series_dot(
    3,
    @as(f64, 1.5),
    @as(f64, 2.5),
    @as(f64, 3.0),
);
```

输出：

```text
dot=7
```

Zig 要求传给 variadic 函数的数字字面量先明确成固定大小类型，否则会报：

```text
error: integer and float literals passed to variadic function must be casted to a fixed-size number type
```

对于已经定型的窄整数和 `f32`，Zig 0.16.0 会按 C 默认实参提升传递；但 variadic 参数之间仍没有静态类型联系，格式字符串也不会替你核对后续参数。因此显式写出 `c_int`、`c_uint` 或 `f64`，仍是更清楚也更稳妥的边界代码。

自己的 API 若能选择，优先使用指针加长度、`extern struct` 或固定参数；variadic 适合兼容已有 C 接口，不适合把类型检查留在边界之外。

## 自动翻译进了构建系统

过去常见的写法是：

```zig
const c = @cImport({
    @cInclude("statlib.h");
});
```

Zig 0.16.0 已将 `@cImport` 标记为 deprecated。官方方向是把 C translation 放进构建系统：

```zig
const translated = b.addTranslateC(.{
    .root_source_file = b.path("statlib.h"),
    .target = target,
    .optimize = optimize,
});

const c_module = translated.createModule();
```

再把模块加入可执行文件的 root module：

```zig
exe.root_module.addImport("c", c_module);
```

业务代码只需：

```zig
const c = @import("c");
```

这条路径在本机已完整构建运行。translate-c 会把不完整 struct 译成 opaque 类型，把 C 指针译成 `[*c]T`，把可空回调译成可选 C 函数指针，也会如实保留 C API 中那些含混之处。

翻译器解决的是批量声明，不负责把接口设计成 Zig 习惯的样子。宏、条件编译、平台 typedef 和不连续 enum 都可能让产物比手写绑定更宽松；生成层之外，通常仍值得再包一层只暴露 slice、error union 和明确所有权的 Zig API。

## 包装层：让边界集中在一个模块

完整包装层可以把跨界的细节限制在一个模块：

```zig
const SafeSeries = struct {
    handle: *Series,

    fn create(capacity: usize) error{NoMemory}!SafeSeries {
        return .{
            .handle = series_create(capacity) orelse {
                return error.NoMemory;
            },
        };
    }

    fn deinit(self: SafeSeries) void {
        series_destroy(self.handle);
    }

    fn add(self: SafeSeries, values: []const f64) Error!void {
        try statusToError(series_add(
            self.handle,
            values.ptr,
            values.len,
        ));
    }

    fn stats(self: SafeSeries) Error!Sample {
        var out: Sample = undefined;
        try statusToError(series_stats(self.handle, &out));
        return out;
    }
};
```

调用方看到的是：

```zig
var series = try SafeSeries.create(4);
defer series.deinit();

try series.add(&.{ 1.0, 2.0, 3.0, 4.0 });
const sample = try series.stats();
```

本机完整运行结果：

```text
count=4 mean=2.50 size(Sample)=16
status_name(.ok)=ok
observer: count=4 sum=10
at(2)=3
dot=7
```

Zig 一侧的代码从此不再接触 `[*c]T`、整数返回码和裸 handle。边界集中以后，编译选项、平台差异、所有权说明和错误翻译也有了唯一落点。好的 FFI 包装做的不只是给 C API 换名字，而是把对岸默认靠习惯维持的事实，重新写成 Zig 一侧可检查、可组合的类型与控制流。

## 这套边界的代价

原型没有双边核验。手写 `extern fn` 若与头文件不符，链接器未必能发现；应让头文件成为单一来源，使用 translate-c，或至少在 CI 中同时编译 C 与 Zig，并对关键结构体做尺寸与偏移断言。

布局兼容不等于语义兼容。`extern struct` 只保证 C ABI 布局；指针有效期、enum 值域、字符串终止、布尔合法值和线程规则仍要另行确认。

错误不会自动翻译。Zig error 不能直接成为 C ABI 返回值，C 返回码和 `errno` 也不会自动变成 error union；边界函数必须把失败从一种约定翻译成另一种约定。

分配记录不会跟着指针走。C `malloc`、库自己的 create/destroy 与 Zig allocator 各有管辖；释放函数配错，比忘记释放更快进入非法行为。

回调恢复类型靠的是约定。`void *` context 可以承载任何地址，也因此不证明任何类型、对齐、生命周期或线程安全；擦除之前和恢复之后必须由同一份设计负责。

自动翻译仍需要人工收口。translate-c 擅长如实映射头文件，如实也意味着把 C 的模糊原样带回；生成绑定之上再建一层原生包装，才能把风险留在边界上。

---

回看这一程：函数原型声明形状，`extern struct` 统一布局，返回码换回执，切片拆成地址与长度，C 字符串凭零终止符找到尽头，opaque handle 保持封闭，`void *` 带着回调上下文原路返回。这些保证都属于「形状」这一层。

形状之下那些更沉的事——内存归谁、借用多久、错误怎样处理、未知值是否可信——ABI 一个都不担保，要由包装层逐项接住。指针篇那只 `[*c]T` 的旧箱，到这里终于开过一次封：它并不肮脏，只是保留着 C 世界本来的含混；要紧的是数据过界之后，别让整个 Zig 程序继续按那套含混生活。

下一篇换一个方向：Zig 的工具链出去编译 C 项目。那边是 C 代码进 Zig，这边是 `zig cc` 送 C 出门，正好互为镜像。
