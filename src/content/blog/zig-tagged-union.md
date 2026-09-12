---
title: 状态只许记一遍：Zig 的 tagged union
description: 一条连接同时报告在线与重试，两行日志都没有说谎：状态被记了两遍。这篇从一份最小事故复现出发，把分开保管的状态标签与数据并回同一个值，看清穷尽 switch、字段捕获、运行时检查、布局与外部输入各自管到哪里。事故复现与示例基于 Zig 0.16.0。
pubDate: 2026-09-05
category: zig
tags: [Zig, 编程语言]
---

凌晨三点十四分，同一个连接交出了两份说法：

```text
03:14:07.212 [monitor] conn#41 phase=online
03:14:07.214 [retry]   conn#41 attempt=3 next_ms=4000
03:14:09.881 [router]  conn#41 session route failed
```

相隔两毫秒，同一台机器，同一条连接。监控说它已经在线，重试定时器说它还在等第四次尝试。两秒以后，路由代码相信了第一行日志，转身去取会话信息，进程挂在了那里。

两行日志都没有说谎。把事故缩成最小复现之后才看清矛盾在哪：它们读的从来不是同一个字段。连接状态被记了两遍，一遍是 `phase`，一遍是旁边 union 里实际存放的 payload。两份记录各自合法，合在一起讲不通。

Zig 对这类问题有一个专门的数据模型：tagged union。它不保证状态机永不出错，但先撤掉最荒唐的那种可能——一个值同时声称自己处于两种状态。

前几篇讲过值在哪里写成、切片能活多久；这一篇从日志出发，沿着代码、测试和编译器诊断把事故反过来查一遍。示例和报错都在 Zig 0.16.0 上验证过。

## 先看出事的类型

事故版本的类型并不复杂：

```zig
const Phase = enum {
    dialing,
    online,
    backoff,
    closed,
};

const Detail = union {
    dialing: struct { started_ms: u64 },
    session: struct {
        id: u32,
        peer: []const u8,
    },
    backoff: struct {
        attempt: u32,
        next_ms: u64,
    },
    closed: struct { reason: []const u8 },
};

const Connection = struct {
    phase: Phase,
    detail: Detail,
};
```

`phase` 供监控和路由判断；`detail` 保存当前阶段需要的数据。在线时需要 session，退避时需要 attempt 与 next_ms。乍看职责分明。

现在构造事故时刻的值：

```zig
test "contradictory state is representable" {
    const conn: Connection = .{
        .phase = .online,
        .detail = .{
            .backoff = .{
                .attempt = 3,
                .next_ms = 4000,
            },
        },
    };

    try std.testing.expectEqual(Phase.online, conn.phase);
    try std.testing.expectEqual(
        @as(u32, 3),
        conn.detail.backoff.attempt,
    );
}
```

Zig 0.16.0 的结果：

```text
All 1 tests passed.
```

测试通过，程序仍是错的。第一个断言证明监控没有说谎，第二个断言证明重试定时器也没有说谎；真正缺席的是第三条规则——类型里没有任何东西要求 `.online` 必须和 `.session` 同时出现。一个状态被记了两遍，就有了不一致的机会。

## bare union 没有可查询的 tag

`Detail` 是 bare union，也就是没有附带 tag enum 的 union。它规定一组可能的字段，让它们复用存储，同一时刻只有一个字段处于 active 状态。Zig 会为错误字段访问实施安全检查，但没有给业务代码一枚可以取出来、比较或拿来 `switch` 的 enum：

```zig
var detail: Detail = .{
    .backoff = .{
        .attempt = 3,
        .next_ms = 4000,
    },
};
```

此刻 active field 是 `backoff`，然而 bare union 的值里没有一枚可供查询的 tag。下面的代码会被拒绝：

```zig
switch (detail) {
    .backoff => {},
    else => {},
}
```

```text
error: switch on union with no attached enum
note: consider 'union(enum)' here
```

于是事故版本另设了一个 `phase`。一个字段说「当前是什么状态」，另一个字段保存「该状态的数据」，一致性全靠每条写入路径自觉维持。

正常路径会改两处：

```zig
fn onSessionEstablished(
    conn: *Connection,
    id: u32,
    peer: []const u8,
) void {
    conn.phase = .online;
    conn.detail = .{
        .session = .{
            .id = id,
            .peer = peer,
        },
    };
}
```

事故路径只改了一处：

```zig
fn onLinkUp(conn: *Connection) void {
    conn.phase = .online;
}
```

某次重试之后，`detail` 仍是 `.backoff`，`phase` 却已经变成 `.online`。没有一行代码看起来有问题，每一行都类型正确。漏写第二句只是触发点，根本问题是这个模型允许一句话只说一半。

## 修复：把 tag 和 payload 合成一个值

修复后的类型只保留一份状态：

```zig
const Connection = union(enum) {
    dialing: struct {
        started_ms: u64,
    },
    online: struct {
        id: u32,
        peer: []const u8,
    },
    backoff: struct {
        attempt: u32,
        next_ms: u64,
    },
    closed: struct {
        reason: []const u8,
    },
};
```

`union(enum)` 会为这些字段生成 tag enum。一个 `Connection` 同时保存 active tag 与对应的 payload：

```zig
var conn: Connection = .{
    .backoff = .{
        .attempt = 3,
        .next_ms = 4000,
    },
};

conn = .{
    .online = .{
        .id = 41,
        .peer = "10.0.0.8",
    },
};
```

改变状态时，要给整个 union 赋一个新值：tag 变成 `.online`，`online` 所需的 payload 也在同一个初始化器里出现。

若只写：

```zig
conn = .online;
```

编译器报错的要点是（内部生成的类型名略去）：

```text
error: coercion from enum to union 'Connection'
must initialize payload field 'online'
```

`.closed` 带 reason，同样不能只改 tag；`.online` 带 session，也不能留下空白。只有 payload 尺寸为零（`void`、`u0` 或空结构体）的状态，才可以直接用枚举字面量赋值。

Zig 没有提供一条「先偷偷改 tag、稍后再补 payload」的路径，要更换 active field 就整体赋值。事故里的两份记录从此不需要同步，因为只剩一份记录。

## `switch` 逐一核对，不许漏

有了 tag，`switch` 才能看见当前状态：

```zig
fn describe(conn: Connection) []const u8 {
    return switch (conn) {
        .dialing => "dialing",
        .online => "online",
        .backoff => "backoff",
        .closed => "closed",
    };
}
```

这里没有 `else`，四种状态必须逐一处理。删掉 `.closed` 分支，Zig 0.16.0 给出的诊断是：

```text
error: switch must handle all possibilities
note: unhandled enumeration value: 'closed'
```

这条错误提醒的不只是「漏了一个 enum 值」。每个分支还可以取得该状态独有的 payload：

```zig
fn report(conn: Connection) void {
    switch (conn) {
        .dialing => |d| {
            std.debug.print("started={d}\n", .{d.started_ms});
        },
        .online => |session| {
            std.debug.print("peer={s}\n", .{session.peer});
        },
        .backoff => |retry| {
            std.debug.print("attempt={d}\n", .{retry.attempt});
        },
        .closed => |closed| {
            std.debug.print("reason={s}\n", .{closed.reason});
        },
    }
}
```

`|session|` 是值捕获。要原地修改 active payload，可以用指针捕获：

```zig
fn recordRetry(conn: *Connection) void {
    switch (conn.*) {
        .backoff => |*retry| retry.attempt += 1,
        else => {},
    }
}
```

测试从 3 递增到 4：

```zig
var conn: Connection = .{
    .backoff = .{ .attempt = 3, .next_ms = 4000 },
};
recordRetry(&conn);
try std.testing.expectEqual(@as(u32, 4), conn.backoff.attempt);
```

```text
All 1 tests passed.
```

tagged union 把状态名和状态数据绑在一起，控制流也从同一份事实分岔。

## 读错字段时，两种 union 都会 panic

事故版本里，路由先读 `phase`，再相信它去取 `detail.session`。两者不一致时，bare union 在安全构建中也能因错误字段访问而 panic；但它没有 attached enum 可供正常控制流查询，业务判断仍依赖旁边那份可能失真的 `phase`。

换成 tagged union 后，故意对 `.backoff` 状态读取 `.online`：

```zig
var runtime = false;
_ = &runtime;

const conn: Connection = if (runtime)
    .{ .online = .{ .id = 41, .peer = "10.0.0.8" } }
else
    .{ .backoff = .{ .attempt = 3, .next_ms = 4000 } };

std.debug.print("id={d}\n", .{conn.online.id});
```

Debug 构建当场停止：

```text
panic: access of union field 'online' while field 'backoff' is active
```

这个 panic 并非 tagged union 独有的能力。bare union 在 Debug 与 ReleaseSafe 下同样会追踪 active field，对错误字段访问给出同类诊断；`extern union` 与 `packed union` 才没有这项检查。

真正的差别发生在访问之前。bare union 的 active field 不能作为 attached enum 取出、比较或交给 `switch`，事故模型才不得不另设 `phase`；tagged union 把这份状态变成业务代码可见的类型事实，并让 tag 与 payload 无法分开构造。

错误字段访问属于 safety-checked Illegal Behavior。active field 在编译期已确定的话，错误可能直接发生在编译期；到运行时才知道的话，Debug 与 ReleaseSafe 会保留检查，ReleaseFast 与 ReleaseSmall 默认没有——程序可能把 `backoff` 的字节当成 `online` 解释，后果不受语言约束。所以不能把 panic 当业务分支，也不能靠它验证来自网络的 tag。

## `else` 分支会安静地吞掉新状态

穷尽 `switch` 有一项很实际的收益：状态集合改变以后，旧代码会拒绝继续编译。

假设连接关闭前新增一个阶段：

```zig
const Connection = union(enum) {
    dialing: Dialing,
    online: Session,
    backoff: Retry,
    draining: struct { remaining: usize },
    closed: Closed,
};
```

原先没有 `else` 的每一处 `switch`，都会指出尚未处理 `.draining`。这些编译错误构成一份待办清单，带着维护者走遍所有状态分派点。

但若旧代码写成：

```zig
const retryable = switch (conn) {
    .backoff => true,
    else => false,
};
```

新增 `.draining` 后，它仍会安静地编译，新状态自动落进 `else`。这可能正是想要的语义，也可能把尚待斟酌的新状态悄悄归为 `false`。

`else` 没有错，它只是明确放弃了逐项复核未来状态的机会。如果各个未列出的状态在业务上确实同义，`else` 能减少重复；如果新增状态理应触发设计审查，就把分支写全。编译器的检查范围，到你写下 `else` 的地方为止。

## 状态迁移：把合法路径集中到一处

tagged union 消除了 tag 与 payload 的不一致，但没有限制任意状态之间的跳转。`.closed` 仍可以直接变成 `.online`，只要给出合法 payload。

若状态迁移本身也有规则，可以把事件建成另一个 tagged union：

```zig
const Event = union(enum) {
    connect,
    established: struct {
        id: u32,
        peer: []const u8,
    },
    timeout,
    shutdown: []const u8,
};
```

再让转移函数成为唯一入口：

```zig
fn step(conn: Connection, event: Event) Connection {
    return switch (conn) {
        .dialing => switch (event) {
            .established => |e| .{
                .online = .{ .id = e.id, .peer = e.peer },
            },
            .timeout => .{
                .backoff = .{ .attempt = 1, .next_ms = 1000 },
            },
            .shutdown => |reason| .{
                .closed = .{ .reason = reason },
            },
            else => conn,
        },
        .online => switch (event) {
            .shutdown => |reason| .{
                .closed = .{ .reason = reason },
            },
            else => conn,
        },
        .backoff => switch (event) {
            .connect => .{ .dialing = .{ .started_ms = 0 } },
            .shutdown => |reason| .{
                .closed = .{ .reason = reason },
            },
            else => conn,
        },
        .closed => conn,
    };
}
```

状态与事件各自只有一个 active variant，二维 `switch` 把允许的转移集中在一处。这里的 `else => conn` 表示忽略某些事件，是一项明确的产品决定；若每个非法事件都应报错，可以让 `step` 返回 error union。

类型解决表示问题，转移函数解决过程问题。非法组合消失了，非法迁移没有。

## 拷贝带走 tag，也带走 payload 的值

tagged union 仍然服从 Zig 的值语义：

```zig
var peer = [_]u8{ 'n', 'o', 'd', 'e' };

var conn: Connection = .{
    .online = .{
        .id = 41,
        .peer = &peer,
    },
};

const snapshot = conn;
conn = .{ .closed = .{ .reason = "shutdown" } };
```

`snapshot` 拷走了当时的 tag 和 payload。之后原变量变成 `.closed`，副本仍是 `.online`：

```zig
try std.testing.expect(snapshot == .online);
try std.testing.expect(conn == .closed);
```

但 `peer` 是切片，拷贝 payload 只复制它的指针与长度，不复制底层字节：

```zig
try std.testing.expect(snapshot.online.peer.ptr == &peer);
```

统一状态事实，不等于获得深拷贝。上一篇切片生命周期里的期限与所有权问题，在 union payload 中照常成立：一个状态快照保得住 `.online` 这个 tag，未必保得住 `online.peer` 指向的内存。

## 量出来的尺寸，不等于布局保证

把独立 `phase` 合并进 tagged union，总要付出存储 tag 的成本，而具体成本不能靠「最大 payload 加一个字节」心算。

对本文的两种 union，在这台 x86_64 机器和 Zig 0.16.0 上，构建模式还会改变观察结果：

```zig
std.debug.print(
    "bare={d} tagged={d} align={d}\n",
    .{
        @sizeOf(Detail),
        @sizeOf(Connection),
        @alignOf(Connection),
    },
);
```

Debug 构建输出：

```text
bare=32 tagged=32 align=8
```

ReleaseFast 构建则是：

```text
bare=24 tagged=32 align=8
```

Debug 下 bare union 也要保存足以实施 active-field 安全检查的信息，因此本例中与 tagged union 同为 32 字节；ReleaseFast 关闭这道检查后，bare union 缩到 24 字节，而 tagged union 的业务 tag 是值语义的一部分，尺寸保持 32 字节。

这些数字都是当前实现的观察，不能当作文件格式可以依赖的规则。普通 bare union 和 tagged union 也都没有稳定的内存布局，下面的代码会被拒绝：

```zig
const raw: [@sizeOf(Connection)]u8 = @bitCast(conn);
```

```text
error: cannot @bitCast from 'Connection';
union does not have a guaranteed in-memory layout
```

所以 tagged union 适合表达程序内部状态，要过 C ABI 或 wire format 时得另行安排：`extern union` 承诺匹配目标 C ABI，但不携带 Zig 的 active tag，也没有错误字段访问检查；`packed union` 面向位级重解释，同样不提供这份安全。跨边界时应按协议显式编码 tag 与 payload，或按 C ABI 分开声明 discriminant 和 `extern union`。

## 外部来的 tag，先验证再构造

网络字节 `1` 不会因为我们希望它代表 `.data`，就自动成为合法枚举值：

```zig
const WireTag = enum(u8) {
    data = 1,
    close = 2,
};

const WireMessage = union(WireTag) {
    data: u8,
    close: void,
};
```

把任意整数直接交给 `@enumFromInt`，而对应 enum 中没有这个值，就触发 safety-checked Illegal Behavior。Debug 或 ReleaseSafe 的 panic 不能当解析器的错误处理用；ReleaseFast 更不会替协议拒绝坏包。

应当先做业务校验，再构造 tagged union：

```zig
fn decode(tag: u8, payload: u8) !WireMessage {
    if (tag != 1 and tag != 2) {
        return error.BadTag;
    }

    return switch (@as(WireTag, @enumFromInt(tag))) {
        .data => .{ .data = payload },
        .close => .close,
    };
}
```

测试既接受合法消息，也拒绝未知 tag：

```zig
const message = try decode(1, 42);
try std.testing.expectEqual(@as(u8, 42), message.data);
try std.testing.expectError(error.BadTag, decode(200, 0));
```

```text
All 1 tests passed.
```

也可以先用带 `_` 的非穷尽 enum 承接任意 `u8`，再在 `switch` 的 `_` 分支返回协议错误。但非穷尽 enum 能容纳未知整数，不代表 union 能凭空为未知 tag 造出一个不存在的字段。

类型系统核对 active field 与访问是否一致；外部数据可不可信，要由解析代码负责。

## 新增状态时，哪些地方会报错

现在正式加入 `.draining`，重走一次维护流程。没有 `else` 的 `describe`、`report` 和其他 `switch` 会停止编译，并逐处报告：

```text
error: switch must handle all possibilities
note: unhandled enumeration value: 'draining'
```

这些报错不是负担，而是影响范围的清单：新增一种状态之后，所有必须理解它的代码都来到了眼前。可清单上少了一处：

```zig
const retryable = switch (conn) {
    .backoff => true,
    else => false,
};
```

它在前面已经选择了沉默——用了 `else` 的 switch 不会报错。每一处 `else` 都相当于提前替未来的新状态签了字：默认按旧逻辑处理。穷尽检查最值得珍惜的地方就在这里——它不能替人决定 `.draining` 应当怎样处理，但能指出哪些决策尚未发生。

## 它管不到的事

tagged union 消除的是非法组合，不是所有业务错误。`.online` 不可能携带 `.backoff` 的 payload，但 session id 仍可能过期，peer 切片仍可能悬空，状态迁移也可能违反协议——这些都不在它的管辖范围里。

穷尽检查的效力取决于分支是否真的穷尽。`else`、`inline else` 和 `_` 各有正当用途，也都会缩小新增状态时的编译反馈，用它们时应知道自己放弃了哪一次复核。

安全检查不是输入验证。读错 active field、构造非法 enum tag 都可能在安全构建中 panic，这不等于程序可以把不可信数据直接交给类型系统；协议错误应当成为普通 error，而不是 Illegal Behavior。

tag 有空间成本，布局没有固定答案。具体大小应在目标平台上测量，普通 tagged union 不能直接序列化；要过 C ABI 或 wire format，必须另行表达边界。

payload 仍有自己的生命周期。切片、指针、allocator 所有权和别名关系不会因为进了 tagged union 就消失；tag 证明当前是哪一种 payload，不证明 payload 里面的地址仍然有效。

---

事故复盘到这里可以收了。监控和重试日志各自读的数据都是对的；路由代码确实访问了错误的 payload；而真正让事故成为可能的，是类型允许状态被分开记录。

修复之后，连接不再同时拥有一个 `.online` 标签和一份 `.backoff` 数据：每次状态变化整体产生新的 union 值，每次分派从同一枚 tag 出发。那两行相隔两毫秒的矛盾日志，不再是「小概率时序问题」，而是构造不出来的状态。

下一篇讲安全模式与 Illegal Behavior。读错 union 字段、非法 enum tag 都属于 safety-checked 那一类，这篇里出现的几次 panic，正好到那边说清它们的边界。
