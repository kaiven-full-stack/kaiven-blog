---
title: 下一条指令藏在哪里：CPython 的执行帧与求值循环
description: 同一个递归函数只共享一份 code object，为什么每一层调用仍有独立的参数、局部变量与返回位置？本文从 _PyInterpreterFrame 的 localsplus、操作数栈和指令指针出发，沿 Python 函数调用、帧切换、RETURN_VALUE、PyFrameObject 按需创建与 PEP 667 的 f_locals 代理一路追下去，辨清代码、调用现场和调试视图各自承担什么。实验在 CPython 3.14.7 上复核，并对照 CPython 3.12.13 与 3.16.0a0 开发源码。
pubDate: 2026-09-09
category: cpython
tags: [CPython, 编程语言, 解释器]
---

```text
递归调用层数        4
Python frame 数量   4
code object 数量    1
```

三行记录都是真的。

```python
import sys

records = []


def descend(level):
    local_value = f"level-{level}"
    frame = sys._getframe()
    records.append(
        (
            level,
            id(frame),
            id(frame.f_code),
            local_value,
        )
    )
    if level:
        descend(level - 1)


descend(3)
```

CPython 3.14.7 的四层记录中，`frame` 地址各不相同，`frame.f_code` 地址却始终相同。递归函数只有一份编译结果，每次调用仍要保存自己的参数、局部变量、操作数与返回位置。

这正是执行帧存在的理由。

上一篇一直盯着同一处 `BINARY_OP`，看它从通用指令变成 `BINARY_OP_ADD_INT`，又在 guard 失效时回到通用语义。可一条指令不会悬在半空中执行：谁告诉解释器下一条指令在哪里？`left` 与 `right` 从哪里取出来？中间结果放在何处？调用另一个 Python 函数时，当前现场又如何留下返回地址？

这一篇不再问“指令怎样变快”，而是走进承载指令的现场。

本文实验以 **CPython 3.14.7、x86_64 Linux、64 位、默认 GIL、非 debug 构建**为主，并与 CPython 3.12.13 做对照。稳定版结构以本机 3.14 内部头文件为准，开发演进同时核对本地一份标记为 **CPython 3.16.0a0** 的源码快照；该目录没有 Git 元数据，无法绑定到具体提交。`_PyInterpreterFrame`、`localsplus` 和求值循环中的函数名都是 CPython 内部实现，不是 Python 语言或 Stable ABI 的布局承诺。

## Code object 是剧本，frame 是这一场演出

函数对象持有 code object。code object 描述一段编译后的可执行内容，包括：

- 字节码；
- 常量；
- 名字；
- 参数与局部变量元数据；
- 异常表；
- 源码位置表；
- 操作数栈最大深度；
- 自适应执行所需的内部区域。

它回答的是：

> 这段代码可以怎样执行？

frame 回答的则是：

> 这一次调用现在执行到哪里，参数和局部变量是什么，操作数栈里暂存着什么，结束后回到谁那里？

同一个函数调用一万次，不需要复制一万份 code object；但同时存在的每次调用都需要独立现场。递归实验正好把这条边界显露出来：

```text
                     ┌── frame(level=3)
同一 code object ────├── frame(level=2)
                     ├── frame(level=1)
                     └── frame(level=0)
```

四个 frame 的 `f_code` 指向同一 code object，局部变量 `level` 与 `local_value` 却各自不同，`f_back` 还把每层调用连向自己的调用者。

需要说明实验本身的观察效应：`sys._getframe()` 主动索取了 Python 可见的 frame object。它能证明四次调用有四份独立执行现场、共同引用一份代码，却不能证明每次调用一开始就已经为自己分配了完整的 `PyFrameObject`。现代 CPython 默认执行的是更轻量的内部 frame，Python 对象是在需要时才建立的观察窗口。

## 轻量现场叫 `_PyInterpreterFrame`

自 CPython 3.11 起，普通执行不再把每次调用都直接建成旧式、完整的堆上 `PyFrameObject`。核心现场是内部结构 `_PyInterpreterFrame`。

在 CPython 3.14 与当前 3.16 开发源码中，它的字段可以按职责分成五组：

### 这段代码是谁

```text
f_executable    当前 code object
f_funcobj       当前函数对象
```

code object 提供字节码与静态元数据；函数对象还带来 globals、builtins、默认参数、闭包等运行上下文。

### 名字去哪里查

```text
f_globals       全局命名空间
f_builtins      内建命名空间
f_locals        非优化作用域使用的 locals 映射，可能为 NULL
```

普通优化函数的 fast locals 并不靠 `f_locals` 字典保存，而是在 frame 尾部的 `localsplus` 中。

### 调用链怎样连接

```text
previous        前一个内部 frame
return_offset   被调函数返回后，调用者应从哪里继续
```

`previous` 连接内部调用现场，Python 可见的 `f_back` 则是 frame object 层的调用者链接；二者相关，却不是同一字段。

### 现在执行到哪里

```text
instr_ptr       当前执行或将要恢复的位置
stackpointer    当前操作数栈顶
```

求值循环为了速度还会把它们缓存成局部“寄存器”变量 `next_instr` 和 `stack_pointer`，在需要切 frame、调用可能观察现场的代码或进行 GC 安全点时，再与 frame 同步。

### 这块现场由谁持有

```text
owner           thread / generator / frame object / interpreter 等
frame_obj       已关联的 PyFrameObject，没有则为 NULL
```

所有权决定 frame 存在于线程数据栈、生成器对象还是 `PyFrameObject` 自有存储中，也决定现场结束时应清理、弹出还是转移。

字段会继续变化。当前 3.16 开发快照已经加入 base-frame sentinel 与远程 profiling cache，并继续调整 interpreter-owned 入口 frame 的安排；本文主线只依赖 3.14 已经存在的 `instr_ptr`、`stackpointer`、`return_offset` 与 `localsplus[]`。

## 普通 frame 大多住在线程的数据栈

“frame stack”容易和 C 语言调用栈混为一谈。现代 CPython 把多数普通 `_PyInterpreterFrame` 连续分配在每线程的数据栈中：

```text
PyThreadState
    └── datastack chunk
          ├── caller _PyInterpreterFrame
          ├── callee _PyInterpreterFrame
          ├── deeper _PyInterpreterFrame
          └── ...
```

若当前 chunk 空间足够，`_PyFrame_PushUnchecked()` 直接从 `datastack_top` 取出下一段，并按 code object 的 `co_framesize` 推进栈顶；空间不足时，`_PyThreadState_PushFrame()` 再申请或复用新的 chunk。

这样做有两个目的：

1. 避免每次 Python 函数调用都独立进行一笔通用堆分配；
2. 让相邻调用现场在内存中更紧凑，提高局部性。

它仍不是 C 调用栈。Python 语义允许 frame 被 traceback、调试器或生成器长期保留，因而不能简单把全部动态状态塞进一层 C 函数的局部变量后随返回消失。

生成器和协程又是另一种所有权：它们把 `_PyInterpreterFrame` 嵌在生成器或协程对象中，以便暂停后继续保存局部变量、操作数和指令位置。本文只先划出这条边界，完整的暂停与恢复留到后续 `SEND` 与生成器文章。

## `localsplus` 前半放局部变量，后半接操作数栈

`_PyInterpreterFrame` 尾部是一段变长区域：

```c
_PyStackRef localsplus[1];
```

这个 `[1]` 是 C 结构体中变长尾部的占位写法，实际 frame 会按 code object 计算好的大小取得更多槽位。逻辑布局是：

```text
localsplus
┌───────────────────────────────┐
│ arguments / fast locals       │
│ cell variables                │
│ free variables                │
├───────────────────────────────┤ ← localsplus + co_nlocalsplus
│ operand stack slot 0          │
│ operand stack slot 1          │
│ ...                           │
│ maximum co_stacksize slots    │
└───────────────────────────────┘
```

`co_nlocalsplus` 给出参数、普通 fast locals、cell 和 free variables 共需多少槽；编译器计算的 `co_stacksize` 则给出表达式执行时操作数栈的最大深度。frame 初始化时：

```text
stackpointer = localsplus + co_nlocalsplus
```

也就是让空操作数栈从局部变量区之后开始增长。

参数会在 `_PyEvalFramePushAndInit()` 的参数绑定阶段写入前面的 local slots，未初始化的 local/cell/free 槽设为空；`LOAD_FAST` 从这些槽读取，`STORE_FAST` 再把值写回相应位置。

在 3.14/3.16 内部，这些槽的 C 类型已经是 `_PyStackRef`，不应再笼统写成裸 `PyObject *` 数组。它可以表达强引用、借用或其他内部状态，具体编码同样属于版本细节。

## 一行表达式怎样推动操作数栈

看一个小函数：

```python
def calculate(a, b):
    result = a + b * 2
    return result
```

CPython 3.14.7 报告：

```text
co_varnames   ('a', 'b', 'result')
co_nlocals    3
co_stacksize  3
```

相关逻辑指令为：

```text
LOAD_FAST_BORROW_LOAD_FAST_BORROW  a, b
LOAD_SMALL_INT                      2
BINARY_OP                           *
BINARY_OP                           +
STORE_FAST                          result
LOAD_FAST_BORROW                    result
RETURN_VALUE
```

3.14 将两个相邻 fast-local load 融成一条指令，并使用 `LOAD_SMALL_INT`；3.12.13 的同一源码仍显示两条 `LOAD_FAST` 与 `LOAD_CONST 2`。下面把 3.14 的融合指令概念上拆开，便于观察栈：

```text
初始 fast locals
localsplus[0] = a = 3
localsplus[1] = b = 4
localsplus[2] = result = 未设置
operand stack = []

load a               stack = [3]
load b               stack = [3, 4]
load 2               stack = [3, 4, 2]
binary *             stack = [3, 8]
binary +             stack = [11]
store result         stack = []
                      localsplus[2] = 11
load result          stack = [11]
return value         将 11 交给调用者
```

最高同时出现三个操作数，所以 `co_stacksize` 是 3。`BINARY_OP` 的静态 stack effect 是 -1：它消费两个值，压回一个结果。

3.14 中 `dis.stack_effect(RETURN_VALUE)` 为 0，看起来与“弹出返回值”矛盾。原因是其元数据描述跨 frame 的整体效果：返回值从被调 frame 的栈离开，却作为结果进入调用者 frame，而不是在同一逻辑栈上单纯减少一个值。3.12 的元数据仍报告 -1，这也是不能跨版本死记 stack-effect 数字的例子。

这张栈图是依据字节码、公开 stack-effect 元数据与 frame 源码推导出的模型，不是 Python 层直接抓取了内部 `_PyStackRef` 数组。普通代码没有一项无侵入的公开 API 可以把运行中的 operand stack 原样交出来。

## `instr_ptr` 与求值循环共同决定下一条指令

上一篇看到 adaptive bytecode 会在运行时变成专用形态。frame 的 `instr_ptr` 指向当前 frame 实际执行的字节码数组；默认 GIL 构建通常是 code object 的 adaptive array，free-threaded 新版本还可能是当前线程的 TLBC 副本。

求值循环为了性能，把 frame 中的状态缓存成局部变量：

```c
_Py_CODEUNIT *next_instr;
_PyStackRef *stack_pointer;
```

概念化的主循环是：

```text
从 next_instr 取一个 16-bit code unit
        ↓
拆出 opcode 与 oparg
        ↓
推进 next_instr
        ↓
执行对应指令实现
        ↓
读取或改写 stack_pointer
        ↓
dispatch 下一条指令
```

每个 code unit 包含 8-bit opcode 与 8-bit oparg。inline cache 也在字节码数组里占 code units，但它们是数据，不按普通 opcode/oparg 解释；相应指令负责让指令指针跳过自己的 cache 区。

“当前指令”仍有状态边界。3.14/3.16 的 `instr_ptr` 在执行中、暂停时、函数调用现场与调试器改写行号后具有细化语义；Python 层的 `frame.f_lasti` 又以字节码偏移暴露“最后尝试的精确指令”。不能把它永久简化成“总是上一条”或“总是下一条”。

## opcode tracing 能看见 `f_lasti`，也改变了现场

在 CPython 3.14.7 中，可以用 trace function 请求每条 opcode 事件：

```python
import dis
import sys

lookup = {
    instruction.offset: instruction.opname
    for instruction in dis.get_instructions(calculate, adaptive=False)
}

events = []


def tracer(frame, event, arg):
    if frame.f_code is calculate.__code__:
        frame.f_trace_opcodes = True
        if event == "opcode":
            events.append(
                (frame.f_lasti, lookup[frame.f_lasti])
            )
    return tracer
```

本机记录：

```text
 2  LOAD_FAST_BORROW_LOAD_FAST_BORROW
 4  LOAD_SMALL_INT
 6  BINARY_OP
18  BINARY_OP
30  STORE_FAST
32  LOAD_FAST_BORROW
34  RETURN_VALUE
```

`f_lasti` 与 `dis` 的指令 offset 对应，因此调试器可以把当前执行位置映射回 opcode 和源码行。

但这不是透明观察。`sys.settrace()` 会让 frame 对 Python 可见，启用 line/opcode tracing 和解释器 instrumentation；专用字节码也可能受到监控状态影响。该实验可以证明本次被追踪执行中 `f_lasti` 怎样对应指令，不能证明无追踪器时也支付相同成本。

对照的 CPython 3.12.13 构建没有在这份探针中产生 opcode 事件，因此正文只把上述序列绑定到 3.14.7，不把它写成跨版本工具协议。

## Python 函数调用是在求值循环里换 frame

在 CPython 3.10 及更早版本中，Python 函数调用通常经过通用调用协议，再递归进入新的 C 层求值调用。自 3.11 起，常见的精确 Python 函数调用可以在当前解释器循环中“inline”调用。

这里的 inline 不是把被调函数机器码或字节码复制进调用者，也不是编译器常量传播。它表示：

> 不为每次 Python-to-Python 调用递归进入一层新的 C `_PyEval_EvalFrameDefault()`，而是在同一求值循环中压入并切换到被调 frame。

通用 `CALL` 发现 callable 是精确 Python function、没有 PEP 523 自定义 frame evaluator 等阻碍时，会：

```text
CALL
  ↓
_PyEvalFramePushAndInit(...)
  ↓
在线程数据栈上取得新 _PyInterpreterFrame
  ↓
绑定参数到 new_frame->localsplus
  ↓
new_frame->previous = caller frame
  ↓
caller->return_offset = CALL 后应继续的位置
  ↓
切换 tstate->current_frame 与 frame
  ↓
从新 frame 的开头继续 dispatch
```

热调用点还可能走 `CALL_PY_EXACT_ARGS` 等专用宏，使用 `_PyFrame_PushUnchecked()` 直接取 frame，把位置参数写入 `localsplus`，再由 `_PUSH_FRAME` 完成切换。无论通用还是专用路径，核心都是保存调用者、初始化被调现场并把求值循环的“当前 frame”换过去。

非 Python callable、被 PEP 523 hook 接管的 frame、参数形态不满足快路或栈空间不足等情况会走其他路径。不能把“Python-to-Python 可以内联 frame”写成所有 `CALL` 都只有一条实现。

## `RETURN_VALUE` 怎样把结果交回来

被调函数执行 `RETURN_VALUE` 时，返回值位于自己的操作数栈顶。3.16 当前实现把这条跨 frame 的动作写得很直白，3.14 的核心结构也一致：

```text
取出 callee 栈顶返回值
    ↓
保存 callee 的 stack pointer
    ↓
dying = current frame
    ↓
current frame = dying->previous
    ↓
清理并弹出 dying frame
    ↓
恢复 caller 的 stack pointer
    ↓
按 caller->return_offset 恢复 instruction pointer
    ↓
把返回值作为 CALL 的结果放进 caller 栈
```

这解释了 `return_offset` 为什么属于调用者现场：CALL 发生时，调用者知道被调函数结束后应跨过多少 code units；callee 返回时切回 previous frame，再按这份偏移继续。

也解释了为什么 `RETURN_VALUE` 的 DSL 栈效果看起来“有点误导”：值从 callee 栈弹出，却被推到另一只 frame 的栈中。这里不是一只普通局部栈上的 `POP_TOP`。

若异常没有在当前 code object 的 exception table 中找到 handler，求值循环同样会逐层 unwind frame，并在每层建立 traceback entry，直到找到处理器或离开最外层。这篇不展开异常表编码，只保留一条结论：调用链不仅决定正常返回，也决定异常向谁传播。

## 内部 frame 不等于 `PyFrameObject`

现代 CPython 的默认执行现场是 `_PyInterpreterFrame`。Python 代码却看见：

```python
frame = sys._getframe()
print(type(frame))
```

```text
<class 'frame'>
```

这是 `PyFrameObject`，一只真正的 Python 对象。内部 frame 里有一只 `frame_obj` 指针，初始通常是 `NULL`；当 `sys._getframe()`、traceback、tracing、调试器或 C API 需要 Python 可见 frame 时，`_PyFrame_GetFrameObject()` 才调用 `_PyFrame_MakeAndSetFrameObject()` 创建对象，并让它的 `f_frame` 指向当前内部现场。

```text
开始执行
_PyInterpreterFrame.frame_obj = NULL

需要 Python 可见 frame
        ↓
创建 PyFrameObject
        ↓
PyFrameObject.f_frame ──> 当前 _PyInterpreterFrame
_PyInterpreterFrame.frame_obj ──> PyFrameObject
```

所以“每次函数调用都有 frame”与“每次函数调用都立即堆分配一个 `PyFrameObject`”不是同一句话。

递归实验中的四只 Python frame object 是 `sys._getframe()` 主动让它们可见后的结果。内部源码与 frame 文档才是“正常调用可先只使用轻量 frame”的证据。

## 调用结束以后，frame object 仍能留下

Python 语义允许 frame object 活得比那次函数调用更久：

```python
import sys


def make_frame():
    value = "still-visible"
    return sys._getframe()


frame = make_frame()
print(frame.f_code.co_name)
print(frame.f_locals["value"])
```

```text
make_frame
still-visible
```

`make_frame()` 已经返回，它的 frame object 和局部变量仍可访问。

内部的线程数据栈不能永远为所有已结束调用保留槽位。frame 弹出时，若关联的 `PyFrameObject` 仍有外部引用，CPython 会把 `_PyInterpreterFrame` 复制到 frame object 自己的 `_f_frame_data` 区，令 `f_frame` 改指新位置，并按需建立 Python 层 `f_back` 链。此后线程数据栈原位置便可以复用。

这不是创建一张与后续状态断开的普通字典快照，而是一次所有权转移：Python frame object 接管这份已结束的执行现场。

对仍在执行的 frame，`PyFrameObject` 则继续指向线程数据栈中的内部 frame；调试器看到的是同一现场的对象化视图，不是另一场平行执行。

## `f_locals` 在 3.13 以后不再靠猜何时同步

fast locals 实际存放在 `localsplus`，Python 层却需要一份映射接口。旧版本长期存在一个模糊问题：`frame.f_locals` 字典与 fast locals 在何时互相同步？调试器修改字典能否影响函数里的局部变量？

PEP 667 在 3.13 明确了语义。对优化函数 frame，`frame.f_locals` 返回 write-through proxy：

```python
import sys


def demo():
    x = 1
    frame = sys._getframe()
    mapping = frame.f_locals
    mapping["x"] = 9
    return type(mapping).__name__, x, frame.f_locals["x"]


print(demo())
```

CPython 3.14.7：

```text
('FrameLocalsProxy', 9, 9)
```

代理直接访问底层 fast locals 槽，写入会反映到函数继续执行时读取的 `x`。源码中的 proxy setter 会找到对应 `localsplus` index，再更新普通 fast local 或 cell。

CPython 3.12.13 的同一实验则是：

```text
('dict', 1, 1)
```

旧式 `f_locals` 字典写入没有在这里改变 fast local，并可能在下一次同步时被真实局部值覆盖。不能把 3.12 行为描述成稳定、可依赖的写穿协议。

### `locals()` 不是 `frame.f_locals`

在 3.14 的优化函数作用域中，每次 `locals()` 返回一份新的字典快照：

```python
def snapshots():
    x = 1
    first = locals()
    x = 2
    second = locals()
    first["x"] = 99
    return first is second, first["x"], second["x"], x
```

```text
(False, 99, 2, 2)
```

修改 `first` 不会写回 fast local，也不会改变后来的 `second`。

3.12.13 的本次输出则是：

```text
(True, 99, 99, 2)
```

两次调用复用了同一旧式映射；第二次同步把其中的 `x` 更新为 2，随后修改 `first` 也就同时修改 `second`，但真正的 fast local `x` 仍是 2。

所以现代边界是：

```text
frame.f_locals   优化 frame 的实时写穿代理
locals()         当前绑定的一份独立快照
```

它们都以局部变量名为键，却不是同一种对象，也不承担同一份写回语义。

## traceback 为什么能留住整个现场

引用计数篇曾经演示：保存 traceback 会让函数局部对象继续存活。执行帧把这条引用链补完整：

```text
exception / saved traceback
        ↓
traceback.tb_frame
        ↓
PyFrameObject
        ↓
_PyInterpreterFrame / frame-owned copy
        ↓
localsplus
        ↓
函数局部对象
```

本次实验在函数局部创建一只可弱引用对象，随后抛出异常并只保存 traceback。两版 CPython 都观察到：

```text
保存 traceback 后 gc.collect()      对象仍存活
清掉最后一条 traceback 后再 collect  对象释放
```

垃圾回收器没有失效。保存下来的 traceback 提供了一条真实可达路径，局部对象理应继续存活。

若不再需要现场，可以清除保存的 traceback 引用；对已经结束且不再执行的 frame，还可以谨慎使用 `frame.clear()` 清理局部引用。当前正在执行或处于暂停状态的 frame 不能随意 clear，关键资源释放也不应依赖调试对象清理。

## 生成器把 frame 带离普通调用栈

普通函数返回后，frame 通常被清理并从线程数据栈弹出。生成器与协程却必须暂停：局部变量、操作数栈和恢复位置都不能丢。

因此生成器对象直接嵌入一只 `_PyInterpreterFrame`。创建生成器时，当前 frame 的状态转移到生成器对象；恢复迭代或 `await` 时，这只内嵌 frame 再与线程当前调用链连接，从保存的指令位置继续。

```text
普通函数 frame
    调用 → 执行 → 返回 → 弹出

生成器 frame
    创建 → 转入生成器对象 → 暂停
                         ↘ 恢复 → 再暂停 / 返回
```

这正是 frame 不应被等同于“C 栈上一层函数调用”的另一个证据。它是一份可由不同所有者承载的 Python 执行状态。

本文不展开 `YIELD_VALUE`、`SEND`、`throw()` 与协程取消；这些机制都建立在已经看清的三件事上：保存 `instr_ptr`、保留 `localsplus`、重新接入 previous frame 链。

## 调试器为什么不是免费的旁观者

调试器、profiler 和 traceback 工具需要看见普通执行不必持续暴露的信息：

- 创建或取得 `PyFrameObject`；
- 沿 `f_back` 遍历调用链；
- 读取当前位置与源码行；
- 暴露或修改 `f_locals`；
- 接收 call、line、return，甚至每条 opcode 事件；
- 让异常现场和局部对象活得更久。

启用 `sys.settrace()` 还会让解释器使用 instrumentation 版本的执行路径。它适合验证事件与位置，却改变了所观察的现场，因此本文没有用一次微基准把“调试器成本”压缩成固定纳秒数。

现代低开销监控 API、传统 tracing、采样 profiler 和跨进程 remote profiler 的成本模型也不同。共同点是：观察越精细，解释器必须保留、同步或发出越多状态；“读了一眼 frame”不是所有工具都等价的一件事。

## 3.14 与 3.16 的 frame 不能画成永久结构图

本文主线中的这些字段在本机 3.14 与当前 3.16 快照中都存在：

```text
previous
f_funcobj / f_executable
f_globals / f_builtins / f_locals
frame_obj
instr_ptr
stackpointer
return_offset
owner
localsplus[]
```

但内部 frame 仍在快速演进。当前 3.16 开发快照还加入或强化了：

- 每线程调用栈底部的 base frame sentinel；
- interpreter-owned 入口 frame 机制的继续调整；
- remote profiler 的 frame cache 与序列号；
- free-threaded 构建中的 thread-local bytecode index；
- 更细的 frame owner 与 GC/调试状态。

这些安排不应倒灌成 CPython 3.14.7 的字段事实。它们说明的稳定方向是：解释器越来越明确地区分执行 frame、观察 frame、线程栈边界与跨线程采样安全，而不是 `_PyInterpreterFrame` 已经成为固定 ABI。

同样，PEP 523 允许替换 frame evaluator。本文描述的是默认 `_PyEval_EvalFrameDefault()` 与常见 Python function 快路，不保证嵌入器、自定义 evaluator 或未来执行层必须逐行照搬。

## 下一条指令以前

**Code object 描述可执行剧本，frame 保存一次调用现场。** 递归调用可以共享一份 code object，却必须为每层保存独立参数、局部变量、栈与返回位置。

**现代 CPython 默认执行轻量 `_PyInterpreterFrame`。** 多数普通 frame 连续分配在每线程数据栈中，不要求每次调用都立即堆分配 `PyFrameObject`。

**`localsplus` 把 fast locals 与 operand stack 放在同一片变长区域。** 前 `co_nlocalsplus` 个槽保存参数、局部与闭包状态，后面最多使用 `co_stacksize` 个栈槽。

**求值循环把指令指针与栈指针缓存成局部状态。** opcode 消费和产生 `_PyStackRef`，必要时再与 frame 同步；inline cache 只是字节码数组中的数据区。

**常见 Python-to-Python 调用是在同一求值循环里切换 frame。** “inlined call”避免递归进入新的 C 求值调用，不表示函数体被复制进调用者。

**`RETURN_VALUE` 是一次跨 frame 交接。** 返回值从 callee 栈离开，callee 被清理弹出，caller 按 `return_offset` 恢复并接过结果。

**内部 frame 与 Python `frame` 对象不是同一结构。** `sys._getframe()`、traceback 与调试器需要时才创建对象化视图；若对象活得更久，内部现场可以转移到它自己的存储中。

**PEP 667 划清了 fast locals 的公开语义。** 3.14 的 `frame.f_locals` 是写穿代理，函数中的 `locals()` 则返回独立快照；3.12 的旧行为不能继续当作现代规则。

**traceback 保留的是整条可达路径。** 只要 traceback 仍指向 frame，frame 的 `localsplus` 就可能继续留住局部对象。

**frame 是可迁移的执行状态，不只是 C 栈帧。** 普通调用、生成器、frame object 与线程数据栈可以在不同阶段拥有它。

**内部布局必须带版本。** 3.16 的 base/shim frame、profiling cache 和 TLBC 是开发演进，不能被写成所有 CPython 版本的契约。

---

```text
code object 放着剧本。
frame 记着这一场演到哪里。
localsplus 收好演员的名字，也托住尚未落地的中间结果。
调用时换一处现场，返回时沿留下的偏移回到原位。
```

上一文看见字节码在一个操作点上学会走短路；这一文找到了托住那条指令的 frame。下一步，执行现场可以不再一次走到底：生成器在 `yield` 处停下，协程在 `await` 处交出控制权，保存的 `instr_ptr` 与栈又让它们从原处醒来。

下一篇便沿内嵌的生成器 frame 继续，看看一次 `await` 究竟暂停了什么，`SEND` 怎样把值送进暂停的现场，又怎样接回一次 yield 或 return。
