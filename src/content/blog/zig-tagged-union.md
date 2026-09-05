---
title: 状态只许记一遍：Zig 的 tagged union
description: 一条连接同时报告在线与重试，两行日志都没有说谎。本文从一份最小事故报告出发，把分开保管的状态标签与负载并回同一个值，看清穷尽 switch、字段捕获、运行时检查、布局与外部输入各自担保到哪里。文中代码在 0.16.0 上逐一验证。
pubDate: 2026-09-05
tags: [Zig, 编程语言]
---

凌晨三点十四分，同一个连接交出了两份说法。

```text
03:14:07.212 [monitor] conn#41 phase=online
03:14:07.214 [retry]   conn#41 attempt=3 next_ms=4000
03:14:09.881 [router]  conn#41 session route failed
```

相隔两毫秒，同一台机器，同一条连接。监控说它已经在线，重试定时器说它还在等待第四次尝试。两秒以后，路由代码相信了第一行日志，转身去取会话信息，进程倒在了那里。

两行日志都没有说谎。

后来把事故缩成最小复现，才看见真正的矛盾：它们读的从来不是同一个字段。连接状态被记了两遍，一遍是 `phase`，一遍是旁边 union 里当前存放的 payload。两份记录各自合法，合在一起却讲不通。

Zig 对这类问题有一种专门的数据模型：tagged union。它不负责让状态机永不出错，只先撤掉那种最荒唐的可能——让一个值同时声称自己处于两种状态。

前几篇谈过值在哪里写成、切片能活到几时；这一次换一种走法，从日志开始，沿代码、测试与编译器诊断逆向追查。文内示例和报错均在 Zig 0.16.0 上复核。

## 起案：一个通过的错误测试

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

现在构造案发时的值：

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

测试通过，程序仍是错的。

第一个断言证明监控没有说谎，第二个断言证明重试定时器也没有说谎。真正缺席的是第三条规则：类型里没有任何东西要求 `.online` 必须和 `.session` 同时出现。

一个状态被记了两遍，便有了不一致的机会。

## 裸 union 没有随身携带的标签

`Detail` 是 bare union，也就是没有附带 tag enum 的 union。它规定一组可能的字段，并让它们复用存储；同一时刻只有一个字段处于 active 状态。Zig 会为错误字段访问实施安全检查，却没有给业务代码一枚可以取出、比较或拿来 `switch` 的 attached enum。

```zig
var detail: Detail = .{
    .backoff = .{
        .attempt = 3,
        .next_ms = 4000,
    },
};
```

此刻 active field 是 `backoff`。然而 bare union 的值中没有一枚可供查询和 `switch` 的 tag。下面的代码会被拒绝：

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

于是事故版本另设一个 `phase`。一个字段说“当前是什么状态”，另一个字段保存“该状态的数据”，一致性全靠每条写入路径自觉维持。

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

某次重试之后，`detail` 仍是 `.backoff`，`phase` 却已经变成 `.online`。没有一行代码看起来惊天动地，甚至每一行都类型正确。

问题不只在于有人漏写了第二句。更深的根因是：这个模型允许一句话只说一半。

## 并案：让 tag 与 payload 成为同一个值

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

`union(enum)` 会为这些字段生成 tag enum。一个 `Connection` 同时保存 active tag 与对应 payload：

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

改变状态时，要给整个 union 赋一个新值。tag 变成 `.online`，`online` 所需的 payload 也在同一个初始化器里出现。

若只写：

```zig
conn = .online;
```

编译器报错的要点是（内部生成的类型名略去）：

```text
error: coercion from enum to union 'Connection'
must initialize payload field 'online'
```

`.closed` 若带 reason，也同样不能只改 tag；`.online` 若带 session，也不能留下空白。只有 payload 尺寸为零（如 `void`、`u0` 或空结构体）的状态，才可以直接用枚举字面量赋值。

Zig 没有提供一条“先偷偷改 tag，稍后再补 payload”的路径。要更换 active field，就整体赋值。

事故里的两份记录到这里不再需要同步，因为只剩一份记录。

## `switch` 开始逐一核对

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

这里没有 `else`。四种状态必须逐一处理。

删掉 `.closed` 分支，Zig 0.16.0 给出的诊断是：

```text
error: switch must handle all possibilities
note: unhandled enumeration value: 'closed'
```

这条错误不只是提醒“漏了一个 enum 值”。每个分支还可以取得该状态独有的 payload：

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

`|session|` 是值捕获。若要原地修改 active payload，可使用指针捕获：

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

tagged union 不只把“状态名”和“状态数据”绑在一起，也让控制流按同一份事实分岔。

## 读错字段时，两种 union 都会报警

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

这段 panic 并不是 tagged union 独有的能力。bare union 在 Debug 与 ReleaseSafe 下同样会追踪 active field，并对错误字段访问给出同类诊断；`extern union` 与 `packed union` 才没有这项安全检查。

真正的差别发生在访问之前。bare union 的 active field 不能作为 attached enum 取出、比较或交给 `switch`，事故模型才不得不另设 `phase`；tagged union 则把这份状态变成业务代码可见的类型事实，并让 tag 与 payload 无法分开构造。

错误字段访问属于 safety-checked Illegal Behavior。若 active field 在编译期已经确定，错误可能直接发生在编译期；若到运行时才知道，Debug 与 ReleaseSafe 会保留检查。

ReleaseFast 与 ReleaseSmall 默认不提供这道护栏。程序可能把 `backoff` 的字节当成 `online` 解释，后果不受语言约束。不能把 panic 当作业务分支，也不能靠它验证来自网络的 tag。

安全检查可以指出访问违反了当前 active field；tagged union 更早一步，让正常控制流不必依靠旁边另一份可能失真的状态记录。

## `else`：最安静的遗漏

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

新增 `.draining` 后，它仍会安静地编译，并自动落进 `else`。这可能正是想要的语义，也可能把尚待斟酌的新状态悄悄归为 `false`。

`else` 没有错。它只是明确放弃了逐项复核未来状态的机会。

如果各个未列出的状态在业务上确实同义，`else` 能减少重复；如果新增状态理应触发设计审查，就应把分支写全。编译器能检查的范围，到你写下 `else` 的地方为止。

## 状态迁移：把合法路径集中起来

tagged union 消除了“tag 与 payload 不一致”，却没有自动限制任意状态之间的跳转。`.closed` 仍可以直接变成 `.online`，只要给出合法 payload。

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

类型解决的是表示问题，转移函数解决的是过程问题。不要因为非法组合已经消失，就误以为非法迁移也一并消失。

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

但 `peer` 是切片。拷贝 payload 只复制它的指针与长度，不会复制底层字节：

```zig
try std.testing.expect(snapshot.online.peer.ptr == &peer);
```

统一状态事实，并不等于获得深拷贝。上一篇切片生命周期里那些期限与所有权问题，在 union payload 中照常成立。

一个状态快照可以保住 `.online` 这个 tag，却未必保得住 `online.peer` 指向的内存。值复制到哪里，借用就跟到哪里；底层存储并不会因此续期。

## 尺寸是观察，布局不是承诺

把独立 `phase` 合并进 tagged union，总要付出存储 tag 的成本。不过具体成本不能只靠“最大 payload 加一个字节”心算。

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

Debug 下 bare union 也需要保存足以实施 active-field 安全检查的信息，因此本例中与 tagged union 同为 32 字节；ReleaseFast 关闭这道检查后，bare union 缩到 24 字节，而 tagged union 的业务 tag 仍是值语义的一部分，尺寸保持 32 字节。

这些数字都是当前实现的观察，不是可供文件格式依赖的规则。它们反而说明，union 的实际表示不能只靠“最大 payload 加一个字节”心算。

普通 bare union 和 tagged union 都没有稳定的内存布局。下面的代码会被拒绝：

```zig
const raw: [@sizeOf(Connection)]u8 = @bitCast(conn);
```

```text
error: cannot @bitCast from 'Connection';
union does not have a guaranteed in-memory layout
```

所以 tagged union 适合表达程序内部状态，不等于它天然就是网络包、磁盘记录或 C union。

`extern union` 承诺匹配目标 C ABI，却不携带 Zig 的 active tag，也没有错误字段访问检查；`packed union` 面向位级重解释，同样不提供这份安全。跨边界时，应按协议显式编码 tag 与 payload，或按 C ABI 分开声明 discriminant 和 `extern union`。

能在本机量出尺寸，只说明这次构建的值占了多少空间；不能替它补上一份语言从未作出的布局保证。

## 外部 tag：先验明，再构造

网络字节 `1` 不会因为我们希望它代表 `.data`，就自动成为合法枚举值。

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

若把任意整数直接交给 `@enumFromInt`，而对应 enum 中没有这个值，就会触发 safety-checked Illegal Behavior。Debug 或 ReleaseSafe 的 panic 不是解析器应有的错误处理；ReleaseFast 更不会替协议拒绝坏包。

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

也可以先使用带 `_` 的非穷尽 enum 承接任意 `u8`，再在 `switch` 的 `_` 分支返回协议错误。但非穷尽 enum 能容纳未知整数，不代表 union 能凭空为未知 tag 造出一个不存在的字段。

类型系统会核对 active field 与访问是否一致；数据从外部进门时是否可信，仍要由解析代码审问。

## 新状态到来时，哪些地方会说话

现在正式加入 `.draining`，重走一次维护流程。

没有 `else` 的 `describe`、`report` 和其他 `switch` 会停止编译，并逐处报告：

```text
error: switch must handle all possibilities
note: unhandled enumeration value: 'draining'
```

这些报错不是维护负担，而是影响范围。新增一种状态之后，所有必须理解它的代码都来到了眼前。

可清单上少了一处：

```zig
const retryable = switch (conn) {
    .backoff => true,
    else => false,
};
```

它在前面已经选择沉默，今天自然不会突然开口。

这正是穷尽检查最值得珍惜的地方：它不能替人决定 `.draining` 应当怎样处理，却能指出哪些决策尚未发生。每一个 `else` 则是一张预先签过的空白答卷——以后出现的新状态，都默认接受旧答案。

## 结案之前

**tagged union 消除的是非法组合，不是所有业务错误。** `.online` 不可能携带 `.backoff` 的 payload，但 session id 仍可能过期，peer 切片仍可能悬空，状态迁移仍可能违反协议。

**穷尽检查取决于分支是否真的穷尽。** `else`、`inline else` 和 `_` 有各自正当用途，也都会缩小新增状态时的编译反馈。使用它们时，应知道自己放弃了哪一次复核。

**安全检查不是输入验证。** 读错 active field、构造非法 enum tag 都可能在安全构建中 panic；这不等于程序可以把不可信数据直接交给类型系统。协议错误应当成为普通 error，而不是 Illegal Behavior。

**tag 有空间成本，布局却没有固定答案。** 具体大小应在目标平台上测量；普通 tagged union 不能直接序列化。若要过 C ABI 或 wire format，必须另行表达边界。

**payload 仍有自己的生命史。** 切片、指针、allocator 所有权和别名关系不会因为进入 tagged union 就消失。tag 证明当前是哪一种 payload，不证明 payload 里面的地址仍然有效。

---

事故报告最后留下三件事。

第一，监控和重试日志当时都准确读取了各自的数据。第二，路由代码确实访问了错误的 payload。第三，真正使事故成为可能的，不是那一处漏写，而是类型允许状态被分开记录。

修复以后，连接不再同时拥有一个 `.online` 标签和一份 `.backoff` 数据。每次状态变化都整体产生新的 union 值，每次分派都从同一枚 tag 出发。那两行相隔两毫秒的矛盾日志，因此不再是“小概率时序问题”，而是无法构造的状态。

tagged union 没有让程序无懈可击。它也没有发明那条错误字段访问的警报——bare union 在安全构建中早已有同样的护栏。真正修掉事故的，是连接的状态从此只记一遍：`.online` 与 `.backoff` 不再有机会分别成立。

那夜的 panic 只能证明程序已经走进矛盾；新的类型则让那份矛盾在出发以前，就无处安放。
