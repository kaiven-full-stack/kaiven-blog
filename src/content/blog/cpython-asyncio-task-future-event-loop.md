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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 288" role="img" aria-label="从 Future 完成到协程恢复的五层：Future 状态变为 finished；Task 的唤醒回调被排入 ready queue；事件循环取出回调；Task 再次推进 coroutine；原来的 coroutine frame 从 await 处恢复" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="140" y="20" width="380" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="43" text-anchor="middle" font-size="10.5" fill="#2b2a26">Future 状态变为 finished</text>
<text class="ts" x="536" y="43" font-size="9.5" fill="#6b675e">① 改状态</text>
<line class="fl" x1="330" y1="56" x2="330" y2="70" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA1)"/>
<rect class="bx-q" x="140" y="74" width="380" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="97" text-anchor="middle" font-size="10.5" fill="#2b2a26">把 Task 的唤醒回调排入 ready queue</text>
<text class="ts" x="536" y="97" font-size="9.5" fill="#6b675e">② 只排队</text>
<line class="fl" x1="330" y1="110" x2="330" y2="124" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA1)"/>
<rect class="bx-q" x="140" y="128" width="380" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="151" text-anchor="middle" font-size="10.5" fill="#2b2a26">事件循环取出回调</text>
<text class="ts" x="536" y="151" font-size="9.5" fill="#6b675e">③ 轮到它</text>
<line class="fl" x1="330" y1="164" x2="330" y2="178" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA1)"/>
<rect class="bx-q" x="140" y="182" width="380" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="205" text-anchor="middle" font-size="10.5" fill="#2b2a26">Task 再次推进 coroutine</text>
<text class="ts" x="536" y="205" font-size="9.5" fill="#6b675e">④ 推一步</text>
<line class="fl" x1="330" y1="218" x2="330" y2="232" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA1)"/>
<rect class="bx" x="140" y="236" width="380" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="259" text-anchor="middle" font-size="10.5" fill="#2b2a26">原来的 coroutine frame 从 await 处恢复</text>
<text class="ts" x="536" y="259" font-size="9.5" fill="#6b675e">⑤ 醒在原处</text>
</svg>
</figure>

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="Future 状态机：PENDING 经 set_result 保存结果或 set_exception 保存异常进入 FINISHED，经 cancel 进入 CANCELLED；状态单向，进入终态不再回退" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="40" y="72" width="150" height="52" rx="6" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="t" x="115" y="94" text-anchor="middle" font-size="11.5" fill="#2b2a26">PENDING</text>
<text class="ts" x="115" y="112" text-anchor="middle" font-size="9" fill="#6b675e">结果尚未产生</text>
<line class="fl" x1="190" y1="86" x2="416" y2="56" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA2)"/>
<text class="ts" x="250" y="62" font-size="9.5" fill="#6b675e">set_result(value)</text>
<line class="fl" x1="190" y1="104" x2="416" y2="86" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA2)"/>
<text class="ts" x="250" y="104" font-size="9.5" fill="#6b675e">set_exception(exc)</text>
<rect class="bx-q" x="420" y="36" width="190" height="64" rx="6" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="t" x="515" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">FINISHED</text>
<text class="ts" x="515" y="82" text-anchor="middle" font-size="9" fill="#6b675e">保存结果或异常</text>
<line class="fl" x1="190" y1="120" x2="416" y2="148" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA2)"/>
<text class="ts" x="250" y="146" font-size="9.5" fill="#6b675e">cancel()</text>
<rect class="bx-sick" x="420" y="126" width="190" height="48" rx="6" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="t" x="515" y="147" text-anchor="middle" font-size="11.5" fill="#b03a2e">CANCELLED</text>
<text class="ts" x="515" y="165" text-anchor="middle" font-size="9" fill="#6b675e">取消也是终态</text>
<text class="ts" x="40" y="186" font-size="10" fill="#6b675e">三条边都单向：done() 为真之后不再回退</text>
</svg>
</figure>

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="三种对象的关系：coroutine 是可暂停的计算过程，保存内嵌 frame；Task 是驱动者，一次次推进 coroutine，其 return 或异常决定结果；Task 同时满足 Future 接口；Future 是可等待的结果占位与完成通知机制" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="245" y="20" width="170" height="66" rx="6" fill="#ece9e2" stroke="#6b675e" stroke-width="1.5"/>
<text class="t" x="330" y="44" text-anchor="middle" font-size="12" fill="#2b2a26">Task</text>
<text class="ts" x="330" y="62" text-anchor="middle" font-size="9" fill="#6b675e">调度并推进这段计算</text>
<text class="ts" x="330" y="77" text-anchor="middle" font-size="9" fill="#6b675e">也代表它的最终结果</text>
<rect class="bx-q" x="40" y="126" width="200" height="66" rx="6" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="t" x="140" y="150" text-anchor="middle" font-size="12" fill="#2b2a26">coroutine</text>
<text class="ts" x="140" y="168" text-anchor="middle" font-size="9" fill="#6b675e">可暂停的计算过程</text>
<text class="ts" x="140" y="183" text-anchor="middle" font-size="9" fill="#6b675e">保存内嵌 frame</text>
<rect class="bx-q" x="420" y="126" width="200" height="66" rx="6" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="t" x="520" y="150" text-anchor="middle" font-size="12" fill="#2b2a26">Future</text>
<text class="ts" x="520" y="168" text-anchor="middle" font-size="9" fill="#6b675e">可等待的结果占位</text>
<text class="ts" x="520" y="183" text-anchor="middle" font-size="9" fill="#6b675e">+ 完成通知机制</text>
<line class="fl" x1="270" y1="86" x2="172" y2="122" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA3)"/>
<text class="ts" x="164" y="106" font-size="9.5" fill="#6b675e">驱动：send / throw</text>
<line class="fl" x1="216" y1="126" x2="306" y2="90" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA3)"/>
<text class="ts" x="252" y="128" font-size="9.5" fill="#6b675e">return / 异常 → 结果</text>
<line class="fl" x1="400" y1="86" x2="492" y2="122" stroke="#6b675e" stroke-width="1.2" stroke-dasharray="5 3" marker-end="url(#aioA3)"/>
<text class="ts" x="452" y="98" text-anchor="middle" font-size="9.5" fill="#6b675e">Task 同时满足 Future 接口</text>
</svg>
</figure>

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 232" role="img" aria-label="Task step 的五个出口：coroutine 返回值则 Task FINISHED 保存 value；抛 CancelledError 则 Task CANCELLED；抛其他异常则 FINISHED 保存 exception；yield 出 pending Future 则注册唤醒回调暂停等待；bare yield 则把下一次 step 重新排入 ready queue" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一次 step 推进，五个出口</text>
<rect class="bx-q" x="20" y="34" width="250" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="54" font-size="10" fill="#2b2a26">coroutine return value</text>
<line class="fl" x1="270" y1="49" x2="306" y2="49" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA5)"/>
<rect class="bx-q" x="310" y="34" width="330" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="324" y="54" font-size="10" fill="#2b2a26">Task FINISHED · 保存 value</text>
<rect class="bx-q" x="20" y="72" width="250" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="92" font-size="10" fill="#2b2a26">coroutine raise CancelledError</text>
<line class="fl" x1="270" y1="87" x2="306" y2="87" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA5)"/>
<rect class="bx-sick" x="310" y="72" width="330" height="30" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="324" y="92" font-size="10" fill="#b03a2e">Task CANCELLED</text>
<rect class="bx-q" x="20" y="110" width="250" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="130" font-size="10" fill="#2b2a26">coroutine raise 其他异常</text>
<line class="fl" x1="270" y1="125" x2="306" y2="125" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA5)"/>
<rect class="bx-q" x="310" y="110" width="330" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="324" y="130" font-size="10" fill="#2b2a26">Task FINISHED · 保存 exception</text>
<rect class="bx" x="20" y="148" width="250" height="30" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="34" y="168" font-size="10" fill="#2b2a26">coroutine yield pending Future</text>
<line class="fl" x1="270" y1="163" x2="306" y2="163" stroke="#6b675e" stroke-width="1.4" marker-end="url(#aioA5)"/>
<rect class="bx" x="310" y="148" width="330" height="30" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="324" y="168" font-size="10" fill="#2b2a26">注册唤醒回调 · Task 暂停等待（本文主线）</text>
<rect class="bx-q" x="20" y="186" width="250" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="34" y="206" font-size="10" fill="#2b2a26">coroutine bare yield</text>
<line class="fl" x1="270" y1="201" x2="306" y2="201" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA5)"/>
<rect class="bx-q" x="310" y="186" width="330" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="324" y="206" font-size="10" fill="#2b2a26">把下一次 step 重新排入 ready queue</text>
</svg>
</figure>

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 166" role="img" aria-label="set_result 只做通知：状态改为 FINISHED，把 task wakeup 经 loop.call_soon 包装成 Handle 追加进 _ready，然后 set_result 立即返回；此时协程还没有被推进，wakeup 要等事件循环下一批执行" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA7" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="20" y="30" width="190" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="115" y="57" text-anchor="middle" font-size="10.5" fill="#2b2a26">future.set_result(21)</text>
<line class="fl" x1="210" y1="52" x2="238" y2="52" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA7)"/>
<rect class="bx-q" x="242" y="30" width="180" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="332" y="57" text-anchor="middle" font-size="10.5" fill="#2b2a26">Future = FINISHED</text>
<line class="fl" x1="422" y1="52" x2="450" y2="52" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA7)"/>
<rect class="bx-q" x="454" y="30" width="190" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="549" y="49" text-anchor="middle" font-size="9.5" fill="#2b2a26">loop.call_soon(</text>
<text class="ts" x="549" y="64" text-anchor="middle" font-size="9.5" fill="#2b2a26">task wakeup, future)</text>
<line class="fl" x1="549" y1="74" x2="549" y2="102" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA7)"/>
<rect class="bx-q" x="454" y="106" width="190" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="549" y="133" text-anchor="middle" font-size="10.5" fill="#2b2a26">_ready.append(handle)</text>
<line class="fl" x1="454" y1="128" x2="426" y2="128" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA7)"/>
<rect class="bx" x="242" y="106" width="180" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="332" y="133" text-anchor="middle" font-size="10.5" fill="#2b2a26">set_result() 返回</text>
<text class="tc" x="20" y="133" font-size="10.5" fill="#b03a2e">此刻协程还没动</text>
</svg>
</figure>

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 330" role="img" aria-label="完整链路两栏：左栏暂停前，Task 首次 step 用 coro.send(None) 推进，worker 执行到 await future，pending Future 把自己 yield 出来，Task 记录 _fut_waiter 并注册 wakeup 后暂停；右栏恢复，某处 set_result(21) 后 wakeup Handle 进入 ready queue，事件循环执行 wakeup，Task 再次 step，Future.__await__ 返回 21，原 coroutine frame 从 await 后继续" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA8" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="t" x="170" y="26" text-anchor="middle" font-size="11.5" fill="#2b2a26">暂停以前</text>
<text class="t" x="495" y="26" text-anchor="middle" font-size="11.5" fill="#2b2a26">恢复</text>
<line class="grid" x1="332" y1="36" x2="332" y2="312" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 4"/>
<rect class="bx-q" x="40" y="38" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="170" y="58" text-anchor="middle" font-size="9.5" fill="#2b2a26">Task 首次 step · coro.send(None)</text>
<line class="fl" x1="170" y1="70" x2="170" y2="82" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="40" y="86" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="170" y="106" text-anchor="middle" font-size="9.5" fill="#2b2a26">worker 执行到 await future</text>
<line class="fl" x1="170" y1="118" x2="170" y2="130" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="40" y="134" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="170" y="154" text-anchor="middle" font-size="9.5" fill="#2b2a26">pending Future 把自己 yield 出来</text>
<line class="fl" x1="170" y1="166" x2="170" y2="178" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="40" y="182" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="170" y="202" text-anchor="middle" font-size="9.5" fill="#2b2a26">Task 记 _fut_waiter · 注册 wakeup</text>
<line class="fl" x1="170" y1="214" x2="170" y2="226" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-gone" x="40" y="230" width="260" height="32" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="170" y="250" text-anchor="middle" font-size="9.5" fill="#6b675e">Task 暂停 · frame 留在 coroutine 里</text>
<rect class="bx-sick" x="365" y="38" width="260" height="32" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="495" y="58" text-anchor="middle" font-size="9.5" fill="#b03a2e">某处 future.set_result(21)</text>
<line class="fl" x1="495" y1="70" x2="495" y2="82" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="365" y="86" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="495" y="106" text-anchor="middle" font-size="9.5" fill="#2b2a26">wakeup Handle 进入 ready queue</text>
<line class="fl" x1="495" y1="118" x2="495" y2="130" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="365" y="134" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="495" y="154" text-anchor="middle" font-size="9.5" fill="#2b2a26">事件循环执行 wakeup</text>
<line class="fl" x1="495" y1="166" x2="495" y2="178" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="365" y="182" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="495" y="202" text-anchor="middle" font-size="9.5" fill="#2b2a26">Task 再次 step</text>
<line class="fl" x1="495" y1="214" x2="495" y2="226" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx-q" x="365" y="230" width="260" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="495" y="250" text-anchor="middle" font-size="9.5" fill="#2b2a26">Future.__await__ 返回 21</text>
<line class="fl" x1="495" y1="262" x2="495" y2="274" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA8)"/>
<rect class="bx" x="365" y="278" width="260" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="495" y="298" text-anchor="middle" font-size="9.5" fill="#2b2a26">原 coroutine frame 从 await 后继续</text>
<text class="tc" x="170" y="298" text-anchor="middle" font-size="10" fill="#b03a2e">中间隔着真实世界的一段时间</text>
</svg>
</figure>

## `_run_once()` 把就绪、定时器与 I/O 汇到一轮

Task 与 Future 只建立“完成以后请再推进我”的关系。真正决定何时执行 Handle 的，是事件循环。

`run_forever()` 的核心是一条循环：

```text
while not stopping:
    _run_once()
```

在本文 Linux selector loop 中，一次 `_run_once()` 可以概括为：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="_run_once 六步一轮：清理已取消的 timer handles；根据 _ready 与最近定时器计算 selector timeout；selector.select 可能阻塞；把发生的 I/O 事件转成 ready callbacks；把到点的 timer handles 移入 _ready；执行本轮开始时已有的 ready handles；然后进入下一轮" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA9" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="34" y="36" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="129" y="56" text-anchor="middle" font-size="9.5" fill="#2b2a26">清理已取消的</text>
<text class="ts" x="129" y="72" text-anchor="middle" font-size="9.5" fill="#2b2a26">timer handles</text>
<line class="fl" x1="224" y1="60" x2="238" y2="60" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA9)"/>
<rect class="bx-q" x="242" y="36" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="337" y="56" text-anchor="middle" font-size="9.5" fill="#2b2a26">用 _ready 与最近定时器</text>
<text class="ts" x="337" y="72" text-anchor="middle" font-size="9.5" fill="#2b2a26">计算 selector timeout</text>
<line class="fl" x1="432" y1="60" x2="446" y2="60" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA9)"/>
<rect class="bx-q" x="450" y="36" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="545" y="56" text-anchor="middle" font-size="9.5" fill="#2b2a26">selector.select(timeout)</text>
<text class="ts" x="545" y="72" text-anchor="middle" font-size="9" fill="#6b675e">线程可能阻塞在这里</text>
<line class="fl" x1="545" y1="84" x2="545" y2="132" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA9)"/>
<rect class="bx-q" x="450" y="136" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="545" y="156" text-anchor="middle" font-size="9.5" fill="#2b2a26">I/O 事件转成</text>
<text class="ts" x="545" y="172" text-anchor="middle" font-size="9.5" fill="#2b2a26">ready callbacks</text>
<line class="fl" x1="450" y1="160" x2="436" y2="160" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA9)"/>
<rect class="bx-q" x="242" y="136" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="337" y="156" text-anchor="middle" font-size="9.5" fill="#2b2a26">到点的 timer handles</text>
<text class="ts" x="337" y="172" text-anchor="middle" font-size="9.5" fill="#2b2a26">移入 _ready</text>
<line class="fl" x1="242" y1="160" x2="228" y2="160" stroke="#6b675e" stroke-width="1.3" marker-end="url(#aioA9)"/>
<rect class="bx" x="34" y="136" width="190" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="129" y="156" text-anchor="middle" font-size="9.5" fill="#2b2a26">执行本轮开始时</text>
<text class="ts" x="129" y="172" text-anchor="middle" font-size="9.5" fill="#2b2a26">已有的 ready handles</text>
<path class="fl" d="M 34 160 L 16 160 L 16 60 L 30 60" fill="none" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA9)"/>
<text class="ts" x="330" y="222" text-anchor="middle" font-size="10" fill="#6b675e">run_forever：while not stopping，一轮接一轮</text>
</svg>
</figure>

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="跨线程唤醒双泳道：其他线程 call_soon_threadsafe 把 Handle 线程安全地放入 _ready，再向 self-pipe 写入一个字节；阻塞在 selector.select 的 loop 线程因 self-pipe 可读而返回，事件循环随后处理新加入的 Handle" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="aioA11" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="aioA11c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="t" x="165" y="26" text-anchor="middle" font-size="11.5" fill="#2b2a26">其他线程</text>
<text class="t" x="495" y="26" text-anchor="middle" font-size="11.5" fill="#2b2a26">loop 线程</text>
<line class="grid" x1="330" y1="36" x2="330" y2="278" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 4"/>
<rect class="bx-q" x="40" y="42" width="250" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="165" y="66" text-anchor="middle" font-size="9.5" fill="#2b2a26">call_soon_threadsafe(callback)</text>
<line class="fl" x1="165" y1="82" x2="165" y2="100" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA11)"/>
<rect class="bx-q" x="40" y="104" width="250" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="165" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">线程安全地把 Handle 放入 _ready</text>
<line class="fl" x1="165" y1="144" x2="165" y2="162" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA11)"/>
<rect class="bx" x="40" y="166" width="250" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="165" y="190" text-anchor="middle" font-size="9.5" fill="#2b2a26">向 self-pipe 写入一个字节</text>
<rect class="bx-gone" x="370" y="42" width="250" height="40" rx="4" fill="#ece9e2" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="5 3"/>
<text class="ts" x="495" y="59" text-anchor="middle" font-size="9.5" fill="#6b675e">正阻塞在 selector.select(timeout)</text>
<text class="ts" x="495" y="74" text-anchor="middle" font-size="9" fill="#6b675e">不知道 _ready 已经变了</text>
<line class="flc" x1="290" y1="186" x2="366" y2="186" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#aioA11c)"/>
<text class="tc" x="328" y="178" text-anchor="middle" font-size="9.5" fill="#b03a2e">一个字节</text>
<rect class="bx-q" x="370" y="166" width="250" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="495" y="183" text-anchor="middle" font-size="9.5" fill="#2b2a26">self-pipe 可读</text>
<text class="ts" x="495" y="198" text-anchor="middle" font-size="9.5" fill="#2b2a26">select 立刻返回</text>
<line class="fl" x1="495" y1="206" x2="495" y2="224" stroke="#6b675e" stroke-width="1.2" marker-end="url(#aioA11)"/>
<rect class="bx-q" x="370" y="228" width="250" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="495" y="252" text-anchor="middle" font-size="9.5" fill="#2b2a26">事件循环处理新加入的 Handle</text>
<text class="ts" x="40" y="252" font-size="9.5" fill="#6b675e">只入队不叫醒：Handle 会在</text>
<text class="ts" x="40" y="268" font-size="9.5" fill="#6b675e">select 超时后才被注意到</text>
</svg>
</figure>

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
