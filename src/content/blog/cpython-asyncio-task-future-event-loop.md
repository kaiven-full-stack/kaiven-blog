---
title: 协程停在 await，后来是谁把它叫醒的：asyncio 的 Task、Future 与事件循环
description: 等待对象尚未就绪时，await 会交出控制权，却不会替协程等待时间或监视套接字。本文从一只暂停在 Future 上的 Task 出发，沿 Task step、Future 回调、ready queue、timer heap、selector 与 _run_once() 追踪协程如何再次就绪，并分清 set_result、取消、sleep(0) 和跨线程唤醒各自发生在哪一层。实验基于 CPython 3.14.7，并与 3.12.13 对照。
pubDate: 2026-09-09T11:00:00+08:00
category: cpython
tags: [CPython, 编程语言, 异步, asyncio]
---

Future 已经完成，等待它的 Task 还没有完成，协程也还没有从 await 后面继续。这三种状态可以同时成立：

```python
import asyncio


async def main():
    events = []
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    async def worker():
        events.append("worker:start")
        value = await future
        events.append(f"worker:resume:{value}")
        return value * 2

    task = asyncio.create_task(worker())
    await asyncio.sleep(0)

    future.set_result(21)
    print(events, future.done(), task.done())

    await asyncio.sleep(0)
    print(events, future.done(), task.done(), task.result())


asyncio.run(main())
```

CPython 3.14.7 输出：

```text
['worker:start'] True False
['worker:start', 'worker:resume:21'] True True 42
```

`set_result(21)` 已经把 Future 变成 finished，Task 却没有在这次方法调用里同步钻回协程。等主协程也交出控制权，事件循环才执行排好的唤醒回调，让 worker 从原来的 `await` 后面醒来。

所以“Future 完成以后协程继续执行”中间还有几层：

```text
Future 状态变为 finished
        ↓
把 Task 的唤醒回调排入 ready queue
        ↓
事件循环取出回调
        ↓
Task 再次推进 coroutine
        ↓
原来的 coroutine frame 从 await 处恢复
```

上一篇停在 CPython 的执行层：`SEND`、`YIELD_VALUE` 与内嵌 frame 解释了 coroutine 怎样暂停、怎样恢复。这一篇进入 `asyncio` 调度层，回答另一半问题：谁决定何时再去恢复它。

本文实验以 CPython 3.14.7、x86_64 Linux、默认 `asyncio` 事件循环为主，并与 CPython 3.12.13 对照。Linux 本机默认得到 `_UnixSelectorEventLoop` 与 `EpollSelector`；Windows、第三方 event loop 和自定义 loop 可以使用不同 I/O 后端。Task/Future 的默认对象来自 `_asyncio` C 扩展，文中同时借助标准库保留的 Python 等价实现解释状态机，并以 `_asynciomodule.c` 校验主路径。私有字段与函数名属于当前实现，不是稳定 API。

## coroutine、Task 与 Future 不是三个名字

先把三种对象分开。

### coroutine 保存可恢复的执行

调用原生协程函数会得到 coroutine object。它拥有上一篇追过的内嵌 `_PyInterpreterFrame`，能够在 `await` 处保存：

- 指令位置；
- 局部变量；
- 操作数栈；
- 异常状态；
- 当前委托的 awaitable。

coroutine 回答的是：

> 这段异步函数当前执行到哪里，下一次怎样从原处继续？

它不会自己选择 CPU 时间，也不会自己监听文件描述符。若没有外部驱动，创建一只 coroutine object 并不会让正文自动运行。

### Future 表示以后才有的结果

`asyncio.Future` 是一只状态容器。主状态可以概括为：

```text
PENDING
   ├── set_result(value)    → FINISHED，保存结果
   ├── set_exception(exc)   → FINISHED，保存异常
   └── cancel()             → CANCELLED
```

它还保存所属事件循环和完成回调。Future 回答的是：

> 这项结果是否已经产生；若产生，是值、异常还是取消？谁需要在它完成后收到通知？

Future 本身不一定执行工作。套接字可读、定时器到点或另一个任务结束时，相应代码会改变它的状态。

### Task 驱动 coroutine，也是一种 Future

`asyncio.Task` 把 coroutine 包起来，负责一次次推进它。Task 自己同时满足 Future 接口：其他协程可以 `await task`，因为 Task 完成时也会保存返回值、异常或取消状态。

```text
Task
├── 作为驱动者：保存并推进 coroutine
└── 作为 Future：向外代表这次 coroutine 执行的最终结果
```

但 Task 不是普通 Future。调用者不能对 Task 使用 `set_result()` 或 `set_exception()`；它的结果必须由被包装 coroutine 的 return 或异常决定。

因此更准确的关系是：

```text
coroutine   可暂停的计算过程
Task        调度并推进这段计算，也代表它的最终结果
Future      可等待的结果占位与完成通知机制
```

## `create_task()` 先排一次推进，不默认同步执行正文

先看最小实验：

```python
import asyncio


async def worker(events):
    events.append("worker body")


async def main():
    events = []
    task = asyncio.create_task(worker(events))
    events.append("after create_task")

    print("created   ", events)
    await asyncio.sleep(0)
    print("next turn ", events)

    await task


asyncio.run(main())
```

CPython 3.14.7 输出：

```text
created    ['after create_task']
next turn  ['after create_task', 'worker body']
```

默认路径下，`create_task()` 创建 Task 后把它的首次 step 交给 `loop.call_soon()`。也就是说：

```text
create_task(coro)
        ↓
Task 保存 coro
        ↓
call_soon(Task step)
        ↓
Task 返回给当前调用者
        ↓
事件循环稍后取出 step
        ↓
coro.send(None)
```

这份“稍后”不是另起一条线程，也不保证经过一段真实时间；它只表示 step 已进入当前事件循环的就绪调度。

CPython 3.14 还有 eager task factory 与 `eager_start` 能改变首次推进时机，自定义 task factory 也可以替换默认构造行为。因此结论必须带上“默认 Task 创建路径”的限定，不能把“`create_task()` 永远不执行正文”写成 `asyncio` 的绝对规则。

## Task step 是 coroutine 与事件循环之间的驱动轴

CPython 3.14 默认暴露的是：

```text
<class '_asyncio.Task'>
<class '_asyncio.Future'>
```

也就是 `_asynciomodule.c` 中的 C 实现。标准库 `asyncio/tasks.py` 仍保留 `_PyTask`，它把同一状态机写得更容易阅读。

一次 step 的核心逻辑可以压缩成：

```python
if incoming_exception is None:
    result = coroutine.send(None)
else:
    result = coroutine.throw(incoming_exception)
```

随后依据推进结果分流：

```text
coroutine return value
        → Task FINISHED，保存 value

coroutine raise CancelledError
        → Task CANCELLED

coroutine raise other exception
        → Task FINISHED，保存 exception

coroutine yield pending Future
        → 注册唤醒回调，Task 暂停等待

coroutine bare yield
        → 把下一次 step 重新排入 ready queue
```

C 实现不会真的用 Python 语法调用每一步：普通推进通过 `PyIter_Send(coro, Py_None, &result)` 进入生成器/协程协议，返回时再区分 `PYGEN_NEXT`、`PYGEN_RETURN` 与错误。但控制结构与 Python 等价实现相同。

Task 在尚未结束时可以处于三种重要状态：

```text
1. 等待 pending Future
   _fut_waiter 指向 Future，Task step 没有排队

2. 等待下一次 step
   没有未完成 waiter，step 已经进入 ready queue

3. 正在执行 step
   没有 waiter，step 也不在队列中
```

Task 并不是后台持续轮询 coroutine。它每次只推进到 coroutine 再次 yield、return 或抛异常，然后把控制权还给事件循环。

## `await Future` 怎样把等待对象交给 Task

上一篇已经看过一个 `await` 的逻辑字节码：

```text
GET_AWAITABLE
LOAD_CONST None
SEND
YIELD_VALUE
RESUME
JUMP_BACKWARD_NO_INTERRUPT
END_SEND
```

这一篇把 receiver 换成 `asyncio.Future`。它的 Python 等价 `__await__()` 很短：

```python
def __await__(self):
    if not self.done():
        self._asyncio_future_blocking = True
        yield self
    if not self.done():
        raise RuntimeError("await wasn't used with future")
    return self.result()
```

pending Future 第一次被 await 时，会把自己 yield 给外层驱动者。这里的外层驱动者就是 Task step：

```text
worker coroutine
    ↓ await future
Future.__await__ iterator
    ↓ yield future
Task step 收到 future
```

Task 检查它属于同一个事件循环、确实来自合法 await 路径，也不是 Task 自己，然后建立两条关系：

```text
Task._fut_waiter ───────────────> Future
Future done callbacks ──────────> Task wakeup
```

在 CPython 3.14 的等待现场可以观察到：

```python
task._fut_waiter is future   # True
len(future._callbacks)       # 1
len(task.get_stack())        # 1
```

这些下划线字段只是诊断当前实现，业务代码不应依赖。它们恰好把两层状态连起来：coroutine frame 停在 `await`，Task 停在 Future，Future 则保存“完成后通知谁”。

3.14 还维护 awaited-by 关系，供异步调用链捕获和调试使用；这不是推进协议本身的替代品。真正让 Task 再次运行的仍是完成回调。

## `set_result()` 只发通知，不在原地重入协程

回到开场实验。调用：

```python
future.set_result(21)
```

Future 完成路径会：

1. 确认状态仍为 pending；
2. 保存结果 21；
3. 把状态改为 finished；
4. 取出完成回调；
5. 对每个回调调用事件循环的 `call_soon()`；
6. 清空 Future 自己的回调列表。

关键是第 5 步。Future 不直接执行 Task wakeup，而是把它包装成 Handle 放入 ready queue：

```text
future.set_result(21)
        ↓
Future = FINISHED
        ↓
loop.call_soon(task wakeup, future)
        ↓
_ready.append(handle)
        ↓
set_result() 返回
```

可以单独验证这条边界：

```python
async def main():
    events = []
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    future.add_done_callback(
        lambda done: events.append(f"callback:{done.result()}")
    )
    future.set_result(7)

    print("after set_result", events)
    await asyncio.sleep(0)
    print("after sleep(0)", events)
```

```text
after set_result []
after sleep(0) ['callback:7']
```

这种安排避免 `set_result()` 的调用栈突然同步执行任意数量的等待者。生产结果与消费结果被 ready queue 隔开，回调顺序也由事件循环统一管理。

不过“await 总会暂停到下一轮”同样是错的。若 Future 在执行 `await` 以前已经完成，`Future.__await__()` 不会 yield：

```python
future = loop.create_future()
future.set_result("ready")
value = await future
```

本机实验中，`await` 后面的代码在同一次 Task step 内继续执行，甚至早于此前 `call_soon()` 排好的普通回调。是否真的暂停，取决于 awaitable 当前能否立刻给出结果。

## wakeup 怎样让原来的 frame 醒来

Future 的完成回调最终调用 Task wakeup。它先读取 Future 的结果：

```text
Future 正常完成
    future.result() 得到值
    Task step 正常推进 coroutine

Future 保存异常或被取消
    future.result() 抛出异常
    Task step 把异常 throw 进 coroutine
```

正常结果看起来没有显式执行 `coroutine.send(value)`。Task 只再次正常推进 coroutine，Future 的 await iterator 在恢复后调用自己的 `result()`，再通过 `StopIteration.value` 把值交回 `SEND` 委托链：

```text
Task wakeup
    ↓ 正常 step
coroutine / Future.__await__ 恢复
    ↓ Future.result()
Future.__await__ return 21
    ↓ StopIteration.value
SEND / END_SEND 得到 21
    ↓
worker 中 value = 21
```

若 Future 保存异常，wakeup 则把异常注入 Task 驱动的 coroutine；`await future` 在语言层表现为抛出那只异常。

于是从开场到恢复的完整链路是：

```text
Task 首次 step
    ↓ coro.send(None)
worker 执行到 await future
    ↓ pending Future yield 自己
Task 记录 _fut_waiter，注册 wakeup
    ↓
Task 暂停

某处 future.set_result(21)
    ↓
wakeup Handle 进入 ready queue
    ↓
事件循环执行 wakeup
    ↓
Task 再次 step
    ↓
Future.__await__ 返回 21
    ↓
原 coroutine frame 从 await 后继续
```

## `_run_once()` 把就绪、定时器与 I/O 汇到一轮

Task 与 Future 只建立“完成以后请再推进我”的关系。真正决定何时执行 Handle 的，是事件循环。

`run_forever()` 的核心是一条循环：

```text
while not stopping:
    _run_once()
```

在本文 Linux selector loop 中，一次 `_run_once()` 可以概括为：

```text
清理已取消的 timer handles
        ↓
根据 _ready 和最近定时器计算 selector timeout
        ↓
selector.select(timeout)
        ↓
把发生的 I/O 事件转成 ready callbacks
        ↓
把已经到点的 timer handles 移入 _ready
        ↓
执行本轮开始执行阶段时已有的 ready handles
```

三类来源最终汇入同一只 ready deque：

| 来源 | 怎样进入 ready queue |
| --- | --- |
| 立即回调 | `call_soon()` 直接追加 Handle |
| 定时器 | `call_at()` / `call_later()` 先进入最小堆，到点后移入 ready |
| I/O | selector 报告 fd 可读/可写，`_process_events()` 加入对应 Handle |

因此事件循环不是逐个扫描所有 Task，问“你现在好了吗”。等待 I/O 的 Task 已经把唤醒关系挂在 Future 上；selector 只监视注册过的文件描述符。I/O callback 取得数据并完成 Future，Future 再把 Task wakeup 排入 ready queue。

## ready queue 有明确的批次边界

`_run_once()` 在执行 ready callbacks 前先记录：

```python
ntodo = len(self._ready)
```

然后只处理这 `ntodo` 个 Handle。某个回调在执行期间又通过 `call_soon()` 排入的新 Handle，要等下一轮。

```python
async def main():
    events = []
    loop = asyncio.get_running_loop()

    loop.call_soon(events.append, "A")
    loop.call_soon(lambda: loop.call_soon(events.append, "C"))
    loop.call_soon(events.append, "B")

    await asyncio.sleep(0)
    print("after one turn ", events)

    await asyncio.sleep(0)
    print("after two turns", events)
```

CPython 3.14.7 输出：

```text
after one turn  ['A', 'B']
after two turns ['A', 'B', 'C']
```

`call_soon()` 对注册顺序提供 FIFO 语义，但它不意味着回调中新注册的工作会无限接在同一轮尾部执行。固定批次可以避免一串不断追加的 ready callbacks 让本轮永不结束，也给下一次 I/O poll 留出边界。

开场实验里的 Future wakeup 正是同一规则：`set_result()` 在当前 callback 中追加 wakeup，它通常不会在这只 callback 尚未返回时立刻执行。

“轮”也不是语言层精确计时单位。上层协程自己的 `sleep(0)`、Task step、I/O callback 和 wakeup 都可能分别占用 Handle；用几次 `await sleep(0)` 猜测所有 I/O 一定完成并不可靠。

## `asyncio.sleep()` 把 timer heap 接到 Future

正延迟的 `asyncio.sleep(delay)` 展示了最干净的定时链路。3.14 的 Python 实现可以概括为：

```python
loop = get_running_loop()
future = loop.create_future()
handle = loop.call_later(
    delay,
    set_result_unless_cancelled,
    future,
    result,
)
try:
    return await future
finally:
    handle.cancel()
```

于是：

```text
await asyncio.sleep(1)
        ↓
创建 pending Future
        ↓
TimerHandle 放入 _scheduled 最小堆
        ↓
Task await Future 并暂停
        ↓
_run_once() 用最近 deadline 计算 select timeout
        ↓
定时器到点，Handle 移入 _ready
        ↓
Handle 完成 Future
        ↓
Future 排入 Task wakeup
        ↓
Task 恢复
```

`await` 没有自己睡一秒。真正保存 deadline 的是 TimerHandle，真正让线程等待的可能是 selector 的 timeout，Future 只是把“时间到了”表示成可等待结果。

`asyncio.sleep(0)` 是重要例外。3.14 用带 `types.coroutine` 标记的私有 `__sleep0()` 执行 bare `yield`，避免创建 Future：

```text
sleep(0)
    ↓ bare yield None
Task 看见 None
    ↓ call_soon(next step)
下一轮再推进
```

所以它适合主动让出一次调度机会，却不是“建立一个零秒 Timer Future”的同义写法。

## I/O 就绪也只负责接力，不直接执行协程

在 Linux 默认 selector loop 中，非阻塞 socket 读大致经历：

```text
Task 调用 loop.sock_recv()
        ↓
当前无法立即读取
        ↓
创建 Future，向 selector 注册 fd reader
        ↓
Task await Future
        ↓
selector.select(timeout) 等到 fd 可读
        ↓
_process_events() 把 reader Handle 放入 _ready
        ↓
reader callback 执行 recv
        ↓
Future.set_result(data)
        ↓
Task wakeup 放入 _ready
        ↓
下一次执行 wakeup 时恢复 coroutine
```

这里至少有两个回调边界：I/O reader callback 与 Task wakeup。selector 报告“fd 可读”时，不会直接跳进任意一只暂停 coroutine 的 frame；它先让负责这项 I/O 的 callback 运行，再由 Future/Task 协议完成最后一跳。

不同平台不必使用 epoll。macOS、BSD、Windows 以及第三方事件循环可以换掉 selector 或整个 loop 实现。相对稳定的是高层约定：awaitable 交出控制权，完成事件让等待对象就绪，Task 再推进 coroutine；`_selector`、`_ready` 与 `_scheduled` 是本文实现中的具体机器。

## `cancel()` 是请求沿等待链注入，不是立即销毁 Task

取消最容易被一句话写得过于绝对：

```text
task.cancel() == task 立即变成 cancelled
```

对运行中的 Task，这通常不成立。Task 的取消路径会优先取消它正在等待的 Future；若没有可取消 waiter，则记下必须取消。随后在下一次 step 中，把 `CancelledError` throw 进 coroutine。

```text
task.cancel()
    ↓
若正在 await Future，先请求 Future.cancel()
    ↓
Future 变为 cancelled，并排入 Task wakeup
    ↓
wakeup 读取 Future 时得到 CancelledError
    ↓
Task step 把 CancelledError 注入 coroutine
```

可复现实验：

```python
async def main():
    events = []
    blocker = asyncio.get_running_loop().create_future()

    async def worker():
        try:
            await blocker
        except asyncio.CancelledError:
            events.append("caught cancellation")
            return "survived"

    task = asyncio.create_task(worker())
    await asyncio.sleep(0)

    print("cancel returned ", task.cancel())
    print("immediately     ", task.done(), task.cancelled(), blocker.cancelled())

    await asyncio.sleep(0)
    print("next turn       ", task.done(), task.cancelled(), task.result())
    print("events          ", events)
```

CPython 3.14.7 输出：

```text
cancel returned  True
immediately      False False True
next turn        True False survived
events           ['caught cancellation']
```

底层 blocker 立即进入 cancelled，Task 当下仍是 pending。worker 收到 `CancelledError` 后选择捕获并正常 return，最终 Task 是 finished，而不是 cancelled。

若 coroutine 不抑制 `CancelledError`，异常越过最外层后，Task 才会把自己标记为 cancelled。`finally` 也会在异常传播期间运行。因此取消是协作式控制流，不是从外面销毁 frame 或抢占正在执行的 Python 指令。

这也解释了为什么 CPU 密集、长期不 await 的 coroutine 无法及时响应取消：事件循环没有机会运行下一次 Task step，异常也就没有注入点。

## `call_soon_threadsafe()` 还要叫醒阻塞中的 selector

普通 `call_soon()` 假设由事件循环所在的线程调用。若另一线程追加工作，仅把 Handle 放进 `_ready` 还不够：loop 线程可能正阻塞在一次很长的 `selector.select(timeout)` 中，并不知道 deque 已经变化。

selector loop 为此维护一对 self-pipe socket：

```text
其他线程 call_soon_threadsafe(callback)
        ↓
线程安全地把 Handle 放入 _ready
        ↓
向 self-pipe 写入一个字节
        ↓
selector 发现 self-pipe 可读并返回
        ↓
事件循环处理新加入的 Handle
```

因此 `call_soon_threadsafe()` 的“threadsafe”不仅关乎共享队列，还包含唤醒阻塞 I/O poll 的机制。信号处理和主线程收到第一次 Ctrl-C 后请求取消主 Task，也会利用类似路径让 loop 尽快从等待中回来。

`asyncio.Future` 自己并不是通用线程安全 Future。跨线程完成结果时，应通过相应线程安全入口把动作安排回所属事件循环，而不是把本文单线程状态机理解为任意线程都可直接修改。

## `asyncio.run()` 只是把最外层也放进同一机器

最外层入口并没有绕开 Task/Future 模型。3.14 的 `asyncio.run(main())` 使用 Runner：

```text
创建新 event loop
        ↓
把 main coroutine 包成 Task
        ↓
run_until_complete(main_task)
        ↓
main_task 注册“完成后停止 loop”的回调
        ↓
run_forever() 反复执行 _run_once()
        ↓
main_task 完成，loop.stop()
        ↓
取出 main_task.result()
        ↓
清理异步生成器、executor 与 event loop
```

所以“程序入口正在等待 main”也不是一层隐藏的同步魔法。最外层 main Task 和里面创建的其他 Task 一样，靠事件循环一轮轮推进；区别只是 Runner 负责建立、关闭和善后这套运行环境。

## 3.12、3.14 与开发源码的边界

本文核心实验在 CPython 3.12.13 也得到相同主结论：默认 Task/Future 来自 `_asyncio`；pending Future 完成后先调度 wakeup；Task 到下一次推进才恢复 coroutine。

但实现仍在演进：

- 3.14 的 Task 构造支持 `eager_start`，首次执行时机不能脱离 task factory 单独断言；
- 3.14 增加 awaited-by 关系与异步调用链捕获能力；
- 当前 3.16.0a0 开发源码在 `_asynciomodule.c` 中大量使用对象 critical section，为 free-threaded 构建保护 Task/Future 状态；
- event-loop policy API 正在弃用，默认 loop 创建方式也会继续调整；
- Windows 默认 loop 与本文 Linux epoll 路径不同；
- uvloop 等实现可以保留高层协议，却完全不复用 `base_events.py` 的具体数据结构。

因此下面三层不能混写：

### Python 语言与 awaitable 协议

它规定 coroutine、`await`、`__await__()`、异常与返回的可观察语义，但不规定 Task、Future 或 `_run_once()` 必须存在。

### `asyncio` 公共接口

`create_task()`、Future、event loop、`call_soon()`、`call_later()` 与取消行为属于标准库接口；具体首次执行模式和部分顺序仍要看 API 参数与文档约束。

### CPython 当前实现

`_asyncio.Task`、`TaskStepMethWrapper`、`_fut_waiter`、`_ready`、`_scheduled`、self-pipe 与 `_run_once()` 都是帮助解释本机构建的实现事实。调试器可以观察它们，业务逻辑不应绑定私有布局。

## 谁叫醒了协程

coroutine 保存现场，Task 负责推进，Future 表示以后才有的结果；三者互相协作，却不是同一种对象的不同叫法。默认 `create_task()` 先把首次 step 排入 ready queue，coroutine 正文通常稍后执行，eager start 与自定义 task factory 是需要明确标出的例外。

pending Future 的 `__await__()` 会 yield 自己，Task 收到后记录 waiter，并把 wakeup 注册为 Future 的完成回调。`set_result()` 不同步重入等待者：它先改变 Future 状态，再通过 `call_soon()` 排入回调，Task 不会因此立即完成。反过来，等待已完成的 Future 可能根本不暂停，`await` 是否交出控制权取决于 awaitable 当下是否 yield。

`_run_once()` 把立即回调、到期定时器和 I/O 事件汇入同一只 ready queue；selector 不轮询所有 Task，也不直接恢复 coroutine。ready queue 按批次执行，当前批次中新增的 Handle 留到下一轮，一轮不会被不断追加的工作无限延长。正延迟的 sleep 通过 TimerHandle 完成 Future，`sleep(0)` 走 bare yield 快路，只请求下一轮再推进。

取消是异常注入协议：Task 可以在 `finally` 中清理，也可以捕获取消后正常返回，`cancel()` 不立即销毁执行现场。跨线程调度还要唤醒 selector，`call_soon_threadsafe()` 既追加 Handle，也通过 self-pipe 让阻塞中的 loop 注意到新工作。这些实现细节都带着版本与后端：CPython C Task、Python 等价实现、Linux selector loop 和第三方 event loop，不能画成唯一的永久结构。

回到开头的问题：叫醒协程的不是 `await` 自己。外部事件先让 Future 完成，Future 通知 Task，事件循环执行这条通知，Task 才再次推进那份一直保存在 coroutine object 里的 frame。

下一篇可以继续追更难的一层：当 GIL 不再替这些状态提供全局串行背景，Task、Future、frame 与引用计数怎样在 free-threaded CPython 中加入对象锁、原子状态和新的并发边界。
