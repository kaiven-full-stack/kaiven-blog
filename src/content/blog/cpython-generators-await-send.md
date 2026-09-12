---
title: 一次 await 究竟暂停了什么：CPython 的生成器帧与 SEND 字节码
description: await 不是把函数重新调用一遍，也不是只记住一行源码。本文从内嵌在生成器与协程对象中的 _PyInterpreterFrame 出发，沿 RETURN_GENERATOR、send、YIELD_VALUE、yield from、GET_AWAITABLE 与 SEND 追踪暂停和恢复，讲清 yield value、send value、StopIteration.value 与 cr_await 在控制权传递中的位置。文中实验基于 CPython 3.14.7，另与 3.12.13 和 3.16.0a0 开发源码对照。
pubDate: 2026-09-09T10:00:00+08:00
category: cpython
tags: [CPython, 编程语言, 解释器, 异步]
---

协程对象创建之后，函数正文一行也没运行，局部变量尚未建立，执行帧却已经有了归宿。先从生成器看同一件事：

```python
events = []


def echo():
    events.append("start")
    incoming = yield "first"
    events.append(("received", incoming))
    return "done:" + incoming


generator = echo()
print(events)
```

```text
[]
```

调用 `echo()` 没有执行 `events.append("start")`。得到的不是函数返回值，而是一只 generator object。直到第一次 `next(generator)` 或 `generator.send(None)`，正文才真正走向第一个 `yield`。

可“正文没有运行”不等于什么执行现场都没有。上一篇已经看过普通调用如何把 `_PyInterpreterFrame` 压入线程数据栈；生成器与协程的特殊之处，是它们把 frame 带离普通 push/pop 生命周期，嵌进自己的对象里，等待下一次恢复。

`await` 暂停的不是一行源码，也不是一只 Future 的名字。它暂停的是一份完整的执行现场：当前指令位置、fast locals、cell/free variables、操作数栈、异常状态，以及正在等待谁的委托链。

本文实验主要跑在 CPython 3.14.7 上（x86_64 Linux、64 位、默认 GIL、非 debug 构建），并与 CPython 3.12.13 对照。稳定版结构以本机 3.14 内部头文件和实际反汇编为准；开发演进核对本地一份 CPython 3.16.0a0 源码快照，该目录没有 Git 元数据，绑定不到具体提交。具体 opcode、offset、frame state 和 C 函数均属于对应版本的 CPython 实现，不是 Python 语言或 Stable ABI 的固定布局。

## 生成器调用并非完全没有 frame

“调用生成器函数不会执行函数体”很容易被继续简化成：

> 调用时完全没有 frame，第一次 `next()` 才创建。

现代 CPython 的实现并不是这样。生成器函数的字节码从 `RETURN_GENERATOR` 开始。调用发生时，解释器已经建立一份初始 `_PyInterpreterFrame`；`RETURN_GENERATOR` 随即创建 `PyGenObject`，把当前 frame 复制到生成器对象内嵌的 `gi_iframe`，将 owner 改成 generator，再把 generator object 返回调用者。

```text
调用 generator function
        ↓
建立初始调用 frame
        ↓
执行 RETURN_GENERATOR
        ↓
创建 PyGenObject
        ↓
复制 frame 到 gen->gi_iframe
        ↓
owner = FRAME_OWNED_BY_GENERATOR
        ↓
弹出初始线程 frame，返回 generator object
```

所以正文中的第一条业务语句尚未运行，但足以恢复正文的现场已经装进对象。CPython 3.14.7 对一只新生成器的公开观察是：

```text
events          []
state           GEN_CREATED
gi_suspended    False
gi_yieldfrom    None
gi_frame        存在
gi_frame.f_lasti 4
```

`f_lasti` 的具体 4 是版本字节码布局事实；3.12.13 对同一结构观察到 2。真正稳定的结论是：frame 已经存在，状态仍是 created，正文副作用尚未发生。

原生协程也使用同一家族的对象布局。`PyGenObject`、`PyCoroObject` 和 `PyAsyncGenObject` 都通过共同头部嵌入 `_PyInterpreterFrame`；区别来自 code flags、对象类型、状态协议和允许的驱动方式，而不是协程另有一套与 frame 无关的暂停模型。

## created、executing、suspended、closed 是不同站点

用 `inspect.getgeneratorstate()` 可以观察语言层状态：

```text
GEN_CREATED
GEN_RUNNING
GEN_SUSPENDED
GEN_CLOSED
```

CPython 内部还保存更细的 frame state，用于区分 created、executing、普通 suspended、处在 yield-from 链上的 suspended，以及 cleared/finished 等情况。当前 3.16 free-threaded 实现甚至增加了读取 `gi_yieldfrom` 时的锁定状态，避免并发读写 frame 产生竞争。

这些状态直接决定哪些操作合法：

- created generator 只能先发送 `None`；
- executing generator 不能重入；
- suspended generator 可以继续 `send()`、`throw()` 或 `close()`；
- finished coroutine 不能再次 await；
- cleared frame 已经不再保存可恢复的局部现场。

本机实验：

```python
fresh = echo()
fresh.send("not-none")
```

```text
TypeError: can't send non-None value to a just-started generator
```

第一次启动时，生成器还没有停在任何 `yield` 表达式上，无法给“上一次 yield 的结果”赋一个非 `None` 值。`next(generator)` 在协议效果上相当于 `generator.send(None)`，负责让执行从 created 走到第一个暂停点。

## `send()` 不是重新调用函数

继续驱动前面的生成器：

```python
print(next(generator))
print(events)
```

```text
first
['start']
```

此时状态是 `GEN_SUSPENDED`，`gi_suspended` 为 `True`，`gi_frame` 仍存在。frame 的局部映射里已经有参数、临时变量与运行到暂停点时建立的绑定。

随后：

```python
generator.send("wake")
```

`"wake"` 不是新一次函数调用的参数。它成为上一次暂停处 `yield "first"` 表达式的结果：

```text
第一次向外：yield "first"  → 调用者得到 "first"
恢复时向内：send("wake")  → incoming 得到 "wake"
```

生成器继续执行：

```python
events.append(("received", incoming))
return "done:" + incoming
```

最终输出通过 `StopIteration.value` 交给驱动者：

```text
return value     done:wake
events           ['start', ('received', 'wake')]
state            GEN_CLOSED
gi_suspended     False
gi_frame         None
```

因此 `yield` 是双向表达式，不是只能把值“return 一下”的特殊语句。它向外送出 yield value，也在恢复时从栈顶接回 send value。

## `gen_send_ex2()` 把恢复值压回内嵌 frame

C 层主路径可以压缩成：

```text
next(gen) / gen.send(value)
        ↓
gen_send_ex()
        ↓
检查 frame state，设为 EXECUTING
        ↓
gen_send_ex2()
        ↓
将 value 压入 gen->gi_iframe 的 value stack
        ↓
接回 generator exception state
        ↓
_PyEval_EvalFrame(tstate, &gen->gi_iframe, exc)
```

第一次 `next()` 送入的是 `None`。生成器从初始 `RESUME` 之后开始运行；后来 `send("wake")` 则把 `"wake"` 放在暂停 frame 的操作数栈顶，恢复后的 `yield` 表达式从那里取得结果。

这不是再次执行函数开头，也不是从局部变量字典重新构造状态。恢复使用的是同一只 generator object 内嵌的 `_PyInterpreterFrame`：它还保存原来的 `localsplus`、stackpointer 和 instr_ptr。

异常状态也要跟着 frame 切换。`gen_send_ex2()` 暂时把线程的 `exc_info` 接到 generator 自己的异常状态，求值结束后再恢复调用者的状态。否则一个暂停在 `try/except/finally` 中的生成器无法在多次恢复之间保持正确上下文。

## `YIELD_VALUE` 怎样撤下 frame 又保留现场

执行到 `YIELD_VALUE` 时，生成器要同时完成两件看似相反的事：

1. 像返回一样，把一个值交给调用者；
2. 不像真正返回那样销毁执行现场。

当前实现的核心步骤是：

```text
取出要 yield 的值
    ↓
推进 instr_ptr，使恢复位置越过当前 YIELD_VALUE
    ↓
保存 stackpointer
    ↓
保存并切回调用者 exception state
    ↓
将 generator frame 从 tstate->current_frame 链撤下
    ↓
frame->previous = NULL
    ↓
设置 frame state 为 SUSPENDED
    ↓
调用者取得 yield value
```

frame 没有清理，也没有从 generator object 释放。局部变量与剩余操作数继续留在内嵌 frame 中，下一次 `send()` 再把它接回当前调用链。

这正是 `YIELD_VALUE` 与普通 `RETURN_VALUE` 的核心差异：前者暂时交出控制权，后者完成本次 frame 的生命期并清理现场。

状态顺序也解释了重入错误。生成器正在 `FRAME_EXECUTING` 时，另一条路径再调用它的 `send()`，CPython 会拒绝：

```text
ValueError: generator already executing
```

它不是一把可以同时从两个入口推进的共享迭代器；同一 frame 在任一时刻只能有一个执行者。

## `yield from` 把 send、throw 和 return 都向下转交

父生成器可以把一段协议委托给子生成器：

```python
def child():
    yield "child-yield"
    return 42


def parent():
    result = yield from child()
    return result + 1
```

第一次驱动：

```python
generator = parent()
print(next(generator))
print(generator.gi_yieldfrom)
```

本机输出表明：

```text
yielded value       child-yield
parent state        GEN_SUSPENDED
child state         GEN_SUSPENDED
gi_yieldfrom        指向 child generator
```

父生成器没有自己执行 `yield "child-yield"`；`yield from` 建立了委托链，子生成器向外产生的值一路送到最外层调用者。外层后续的 `send()` 与 `throw()` 也可以沿协议传给子迭代器。

第二次恢复让 child 执行 `return 42`。从 Python 迭代协议看，生成器 return 的最终值表现为 `StopIteration.value`，于是父生成器中 `yield from child()` 表达式得到 42：

```text
child return 42
      ↓ StopIteration.value
parent result = 42
      ↓
parent return 43
      ↓ StopIteration.value
外层驱动者得到 43
```

完成后，父生成器的 `gi_yieldfrom` 和 `gi_frame` 都变为 `None`，状态是 `GEN_CLOSED`。

这里的 `StopIteration` 不是“业务代码抛错了”的普通失败。在 Python iterator/generator 协议中，它承担正常结束信号，并携带 subgenerator 的 return value；外层直接调用生成器 `send()` 时，CPython 会按这份协议设置异常。内部已经识别为 exact generator/coroutine 的 `SEND_GEN` 快路则可以直接区分 yield 与 return，并把 return result 交给 `END_SEND`，不必机械地创建再捕获一只 `StopIteration`。

## `yield from` 与 `await` 共享一条 `SEND` 回路

在 CPython 3.14.7 中，`yield from` 的关键逻辑指令包括：

```text
GET_YIELD_FROM_ITER
LOAD_CONST                None
SEND
YIELD_VALUE
RESUME
JUMP_BACKWARD_NO_INTERRUPT
END_SEND
...
CLEANUP_THROW
```

而原生协程中的 `await` 包含：

```text
GET_AWAITABLE
LOAD_CONST                None
SEND
YIELD_VALUE
RESUME
JUMP_BACKWARD_NO_INTERRUPT
END_SEND
...
CLEANUP_THROW
```

两者共享的核心回路是：

```text
send current value to receiver
        ↓
receiver 又产生一个值？
        ├── 是：YIELD_VALUE 向外暂停，恢复后继续 SEND
        └── 否：得到最终 return value，跳向 END_SEND
```

区别首先出现在进入回路之前：

- `yield from` 对表达式取得 iterator；
- `await` 使用 `GET_AWAITABLE` 验证 coroutine/awaitable 协议并取得 `__await__()` iterator。

因此 `await obj` 不是对任意 iterable 执行 `yield from obj`。对象必须是 coroutine，或者提供合法 `__await__()` 方法，且该方法返回 iterator。协议不满足时，错误发生在进入 SEND 循环以前。

## 手动驱动一次 `await`

不引入 asyncio，也可以观察语言机制：

```python
class Pause:
    def __await__(self):
        resumed = yield "paused"
        return "resumed:" + resumed


async def worker():
    kept = "still-here"
    value = await Pause()
    return kept, value
```

创建：

```python
coroutine = worker()
```

```text
state         CORO_CREATED
cr_suspended  False
cr_await      None
cr_frame      存在
```

与生成器一样，正文尚未执行，但 coroutine object 已经拥有可恢复 frame。

第一次驱动：

```python
print(coroutine.send(None))
```

```text
paused
```

此时：

```text
state             CORO_SUSPENDED
cr_suspended      True
cr_await          一只 __await__ generator
cr_frame.f_locals {'kept': 'still-here', ...}
```

`value` 尚未赋值，因为 `await Pause()` 还没有完成；`kept` 已经存进协程 frame。`cr_await` 暴露当前协程正在等待的下一层对象，这里正是 `Pause.__await__()` 返回的 generator。

再次驱动：

```python
coroutine.send("wake")
```

`"wake"` 沿等待链送给 `Pause.__await__()` 中暂停的 `yield`，成为 `resumed`；该 generator 随后 return `"resumed:wake"`，`SEND`/`END_SEND` 把这个结果交回 worker 的 await 表达式，worker 再 return：

```text
('still-here', 'resumed:wake')
```

最外层通过 `StopIteration.value` 取到它。完成后：

```text
state         CORO_CLOSED
cr_suspended  False
cr_await      None
cr_frame      None
```

这项手动 `send()` 实验展示的是 coroutine protocol，不是 asyncio 调度。真实事件循环通常由 Task 反复驱动 coroutine，并在所等待的 Future 或 I/O 条件就绪后决定何时再次 send；那些属于下一层机制。

## `SEND` 怎样区分 yield 与 return

通用 `SEND` 会把值发给 receiver，并取得一个包含“结果对象 + 结果种类”的返回：

```text
PYGEN_NEXT    receiver 再次 yield
PYGEN_RETURN  receiver 正常 return
PYGEN_ERROR   receiver 发生异常
```

若 receiver 又 yield：

- 结果留作本轮 yield value；
- 外层 `YIELD_VALUE` 把它交给自己的驱动者；
- 恢复后循环回到 `SEND`。

若 receiver 正常 return：

- `SEND` 跳过 yield 回路；
- `END_SEND` 清理 receiver 与协议占位；
- 最终 return value 留作整个 `yield from` 或 `await` 表达式的结果。

若异常从 send/yield 回路的 throw/close 路径进入，`CLEANUP_THROW` 会识别协议性的 `StopIteration` 并抽出其中的 `value`；其他异常继续抛出。普通 `SEND` 自身也能通过内部返回种类直接识别被委托对象的 yield 与 return，不能把所有正常完成路径都画成“先抛出再捕获异常”。

当 receiver 恰好是 exact generator 或 coroutine 时，`SEND` 还可以特化为 `SEND_GEN`，直接把被委托对象的内嵌 frame 接到当前 frame 链，并进入同一求值循环。这是 frame 文章里 Python-to-Python 内联调用在暂停对象上的对应形式。通用对象或自定义 iterator 仍可走一般 send 协议。

## `throw()` 与 `close()` 从暂停点注入控制流

暂停的 frame 不只接收普通值。`throw()` 可以让下一次恢复从暂停表达式处抛出异常：

```python
def catcher():
    try:
        yield "ready"
    except ValueError as error:
        events.append(("caught", str(error)))
        yield "recovered"
    finally:
        events.append("finally")
```

```text
next(generator)                  ready
generator.throw(ValueError(...)) recovered
events                           [('caught', 'boom')]
generator.close()                finally 运行
```

`throw()` 先把异常放入线程异常状态，再以异常恢复模式进入 generator frame。对处于 `yield from` 或 `await` 的生成器/协程，异常还可能沿委托链继续向下传递。

`close()` 则通常从暂停点注入 `GeneratorExit`。生成器可以在 `finally` 中清理：

```python
def cleanup():
    try:
        yield "ready"
    finally:
        events.append("cleanup")
```

第一次 yield 后调用 `close()`，本机确认 `cleanup` 被记录。

但关闭不是一次新的正常迭代。若生成器捕获 `GeneratorExit` 后继续 yield：

```python
def ignores_exit():
    try:
        yield "ready"
    except GeneratorExit:
        yield "bad"
```

`close()` 会抛出：

```text
RuntimeError: generator ignored GeneratorExit
```

这保证关闭协议不能被生成器伪装成又一次正常暂停。

## 暂停的 frame 会继续留住局部对象

构造一只只在生成器局部变量中存在的对象：

```python
import weakref


def holder():
    marker = Marker()
    watched = weakref.ref(marker)
    yield watched
```

生成器暂停后，即使外层没有 `marker` 名字，弱引用仍能取到对象：

```text
generator
    ↓ embedded _PyInterpreterFrame
localsplus
    ↓ marker
Marker object
```

本机两版实验都得到：

```text
暂停期间                   对象仍存活
close() 并清理 frame 后     对象释放
```

这正是暂停语义本身：若局部变量在恢复后还可能使用，frame 就必须保留它。

协程也是如此。前面的 worker 暂停时，`cr_frame.f_locals` 仍可见 `kept = "still-here"`；如果实际局部变量是一只大型对象，它也会一直活到协程恢复、结束、关闭或整个协程对象被清理。

因此长期遗留的 coroutine、generator、Task 和 traceback 都可能成为对象保有链。排查异步内存问题时，只看当前函数有没有返回远远不够，还要检查是否存在 suspended frame。

## `gi_frame` 与内嵌 frame 不是同一层对象

Python 层提供：

```text
generator.gi_frame
coroutine.cr_frame
```

它们返回 `PyFrameObject` 视图。生成器和协程对象真正内嵌的是 `_PyInterpreterFrame`：

```text
PyGenObject / PyCoroObject
    ├── name / qualname / exception state / frame state
    └── gi_iframe / cr_iframe : _PyInterpreterFrame
```

访问 `gi_frame` 或 `cr_frame` 会取得或按需创建 Python 可见 frame object，并让它指向内嵌现场。不能用 `id(gi_frame)` 去推导内嵌结构地址，也不能把两者字段画成同一只 C struct。

若 generator object 销毁，而外部还持有其 frame object，CPython 会把内嵌 `_PyInterpreterFrame` 复制到 `PyFrameObject` 自己的存储中，转移所有权，避免 `f_frame` 变成悬空指针。这与上一篇普通线程 frame 在退出后转入 frame object 的机制相呼应。

完成后的生成器/协程通常把 `gi_frame` / `cr_frame` 暴露为 `None`，表示没有可继续恢复的 Python frame；code object 等只读身份信息仍可通过其他属性观察。

## 未 await 的警告不等于替你执行

```python
async def never_started():
    events.append("ran")

coroutine = never_started()
del coroutine
```

在启用警告捕获并触发回收后，本机得到：

```text
events    []
warning   RuntimeWarning
```

CPython 会为从未 awaited、仍处于 created 状态的 coroutine 发出 `RuntimeWarning`。它提醒调用协议没有完成，却不会自动找一个事件循环把协程跑完，函数正文也不会因此执行。

若 coroutine 已经开始、暂停或持有外部资源，清理问题会更复杂。资源协议仍应显式安排；不能把垃圾回收期间的警告或 finalizer 当作异步任务调度器。

## 3.14 与 3.16 的暂停现场仍在演进

两版共享的主结构是：generator/coroutine 对象嵌入 `_PyInterpreterFrame`，frame 保存 localsplus、stackpointer、instr_ptr 和 owner；`send()` 恢复 frame，`YIELD_VALUE` 暂停它，`SEND` 组织委托。

当前 3.16 开发快照继续改变实现细节：

- free-threaded 构建为 frame state 读写加入原子比较交换；
- 读取 `gi_yieldfrom` 时存在额外锁定状态；
- generator return 与 yield 的区分从旧版依赖 frame state，迁到 thread-state 的 `generator_return_kind`；
- `SEND` family 增加或调整 `SEND_GEN`、virtual iterator、async generator 等特化；
- frame、异常状态和 profiler 链接在无 GIL 场景中需要更严格同步。

这些变化不能倒灌成 CPython 3.14.7 的源码事实。反过来，3.14/3.12 的具体 opcode offset、`RETURN_CONST` 与 `LOAD_SMALL_INT` 差异也不是 Python 协议。

相对稳定的只有语义层：调用 generator/coroutine function 得到暂停对象；驱动方法恢复现场；yield 暂停并返回值；send 把值送回；return 结束并携带最终值；awaitable protocol 限定哪些对象能被 await。

## 暂停与恢复的规则

调用生成器函数不会执行正文，但也不等于没有 frame：初始调用 frame 执行 `RETURN_GENERATOR`，再把现场复制到 generator/coroutine object 的内嵌 frame。生成器和协程保存的是完整执行现场，局部变量、operand stack、instr_ptr 与异常状态都跨暂停保留。

`send()` 是恢复，不是重新调用：它把值压入原来的 frame，成为暂停 `yield` 表达式的结果，然后从保存位置继续。`YIELD_VALUE` 交出控制权却不销毁 frame，它推进恢复位置、保存栈、撤下调用链并标记 suspended。`yield from` 与 `await` 共享 `SEND` 委托循环：receiver 再 yield 就继续暂停，receiver return 就由 `END_SEND` 取得最终值，经 `StopIteration.value` 成为委托表达式的结果。`await` 额外受 awaitable protocol 约束，`GET_AWAITABLE` 必须取得合法的 `__await__()` iterator，不能 await 任意 iterable。

`throw()` 与 `close()` 从暂停点注入异常；`close()` 允许 `finally` 清理，却不允许生成器继续 yield。暂停的 frame 会继续留住局部对象，generator/coroutine 没有完成，就仍可能保有大对象、异常和上下文。`gi_frame` / `cr_frame` 是 Python frame object 视图，真正嵌入暂停对象的是 `_PyInterpreterFrame`，必要时可向 frame object 转移所有权。未 await 的警告只指出 created coroutine 未按协议驱动，不会替程序调度协程。版本差异要写进状态机：3.16 的原子 frame state、return-kind 和 SEND family 演进，不应冒充 3.14 的固定实现。

一次 `await` 暂停的是整份 coroutine frame：局部变量、栈、异常状态和等待对象一起停住；恢复时把值送回那一刻尚未完成的表达式，从头执行的只有第一次驱动。

下一篇离开语言协议，进入调度层：Task 怎样把 coroutine 一段一段推进，Future 如何通知它再次就绪，`asyncio` 的 `_run_once()` 又怎样在 ready queue、timer heap 与 selector 之间安排下一轮。
