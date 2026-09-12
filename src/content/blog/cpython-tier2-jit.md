---
title: 循环热起来之后，字节码去了哪里：CPython 的 Tier 2、micro-op 与 JIT
description: 一段循环热到阈值后，JUMP_BACKWARD 会把控制权交给一只 executor，里面装着跨多条字节码的 micro-op trace；分支走岔从 side exit 回到 Tier 1，改一个 builtins 又能让整张 trace 图失效。本文从热点计数器出发，沿 trace 构建、常量内联、函数内联、side exit 链接与 copy-and-patch 机器码一路追下去，分清 Tier 1 特化、Tier 2 trace 与 JIT 三层各自的边界。实验在 CPython 3.14.7 与 3.16.0a0 开发源码的 uop/JIT 双构建上完成。
pubDate: 2026-09-09T20:00:00+08:00
category: cpython
tags: [CPython, 编程语言, 解释器, JIT]
---

```text
默认构建 3.14.7      热循环后显示 JUMP_BACKWARD_NO_JIT
JIT 构建热身之后      同一位置显示 JUMP_BACKWARD_JIT
                      并且长出一只 31 条 micro-op 的 executor
```

函数很短：

```python
def work(n):
    total = 0
    for i in range(n):
        total += i
    return total
```

上一篇讲 Tier 1 时，这条循环热身后学到的是 `BINARY_OP_ADD_INT` 和 `FOR_ITER_RANGE`，每处操作点各自优化。但循环再热下去，还有一层机制在等着：整段循环可以被搬出字节码解释器，换一种执行形态。

默认构建的 CPython 3.14.7 里，这层机制是休眠的。热身前后，向后跳转显示为：

```text
冷态    JUMP_BACKWARD
热态    JUMP_BACKWARD_NO_JIT
```

名字里的 `NO_JIT` 说明：解释器知道该去哪里，但这个构建里没有那个入口。本文用 `--enable-experimental-jit` 构建的 CPython 看 Tier 2 与 JIT 怎样工作，也看清它们在哪些地方主动退回。

本文实验使用两份源码：CPython 3.14.7（含系统默认构建与 `--enable-experimental-jit` 构建配置）与本地 CPython 3.16.0a0 开发快照。3.16 快照配置了两种执行引擎：`--enable-experimental-jit=interpreter`（micro-op 解释器，无机器码）与完整 JIT。executor、micro-op 名称、阈值与 trace 布局都是版本实现事实，不是 Python 语言承诺。

## Tier 1 的天花板在“一次一条”

先复习上一篇的地基。Tier 1 adaptive interpreter 的优化粒度是单个操作点：一枚 `+` 学会 `BINARY_OP_ADD_INT`，一枚迭代器学会 `FOR_ITER_RANGE`，各自带 guard，各自可撤销。

这个粒度下有三件事永远做不到：

```text
跨指令的常量传播    total = 0 后紧跟 total + 1，两条指令合起来才知道结果
调用消除           CALL 特化得再好，调用协议本身一次不少
循环级优化         每条指令仍要经过完整的分派、栈操作与计数检查
```

问题不在特化不够聪明，在一条指令看不见邻居。Tier 2 的全部动机，就是把一段连续执行的字节码作为一个整体来分析和执行。

## 三个名字：Tier 2、micro-op、JIT

进入源码前先立好标尺，这三个词经常被混用：

```text
Tier 2      一层执行机制的总称：热点代码离开 Tier 1，进入新的执行形态
micro-op    Tier 2 内部的指令单位（源码写作 uop），比字节码更细，
            guard、栈操作、帧管理都被拆成独立小步
executor    Tier 2 的执行体：一段 micro-op 序列加上它的出口表。
            可由 uop 解释器执行，也可由 JIT 编译成机器码执行
```

所以 JIT 不是 Tier 2 的同义词。`--enable-experimental-jit=interpreter` 构建里，Tier 2 完整存在、trace 照常构建，只是 trace 由一个专门的 micro-op 解释器执行，没有任何机器码生成。这个模式是理解和调试 Tier 2 的最好入口：机器码只是同一份 trace 的另一种可执行形式。

3.16 的 `Python/tier2_engine.md` 对此有一句准确的总结：superblock 是想执行的代码的表示，executor 才是可执行的形式；而 executor 有两种引擎，硬件运行 JIT 产出的机器码，Tier 2 解释器运行字节码形式的 executor。

## 入口在 JUMP_BACKWARD 上

Tier 2 的入口选在循环的向后跳转。上一篇见过 Tier 1 的 warmup counter，这里同款机制再加一层：

```python
import dis

def work(n):
    total = 0
    for i in range(n):
        total += i
    return total

for _ in range(10):
    work(2_000_000)

dis.dis(work, adaptive=True)
```

JIT 构建（3.16 快照，`PYTHON_JIT=1`）热身后，向后跳转显示为：

```text
54 JUMP_BACKWARD_JIT
```

而默认构建 3.14.7 显示的是 `JUMP_BACKWARD_NO_JIT`。`family(JUMP_BACKWARD)` 只有两个成员，`_SPECIALIZE_JUMP_BACKWARD` 按解释器的 `jit` 开关选择其中一个。`NO_JIT` 分支里那个 counter 还在数，但数到头也没有下一步，入口处于休眠。

`JUMP_BACKWARD_JIT` 的宏展开尾部挂着 `_JIT` 微指令：counter 倒数到触发点，就发起 Tier 2 的构建。3.14.7 里这个入口直接调用 `_PyOptimizer_Optimize()`；3.16 快照则先进入 `_PyJit_TryInitializeTracing()`，这是两代架构的分岔点，后文展开。

构建成功后，字节码数组里发生了两件事：

```text
1. code object 的 co_executors 数组里挂上一只新 executor
2. 循环顶部的指令被改写为 ENTER_EXECUTOR，oparg 指向数组下标
```

下次循环再走到这个位置，`ENTER_EXECUTOR` 取出 executor，控制权交给 Tier 2。

## 用 _opcode.get_executor 看进 executor

executor 不是纯内部对象，`_opcode.get_executor(code, offset)` 可以按字节码偏移取出它，取出后还能直接迭代它的 micro-op 序列。JIT 构建 3.16 快照上，`work` 热身后：

```python
import _opcode

ex = _opcode.get_executor(work.__code__, 54)
print(ex.is_valid())
print(len(list(ex)))          # 31 条 uop
print(len(ex.get_jit_code())) # 4096 字节机器码
```

```text
True
31
4096
```

31 条 micro-op，机器码 4096 字节。把序列完整打出来：

```text
 0 _START_EXECUTOR
 1 _MAKE_WARM
 2 _SET_IP
 3 _CHECK_PERIODIC
 4 _CHECK_VALIDITY
 5 _ITER_CHECK_RANGE
 6 _GUARD_NOT_EXHAUSTED_RANGE
 7 _ITER_NEXT_RANGE
 8 _SET_IP
 9 _SWAP_FAST_2
10 _SPILL_OR_RELOAD
11 _POP_TOP
12 _CHECK_VALIDITY
13 _LOAD_FAST_BORROW_1
14 _LOAD_FAST_BORROW_2
15 _GUARD_TOS_OVERFLOWED
16 _GUARD_NOS_INT
17 _BINARY_OP_ADD_INT
18 _POP_TOP_NOP
19 _POP_TOP_NOP
20 _SWAP_FAST_1
21 _POP_TOP_INT
22 _JUMP_TO_TOP
23 _DEOPT
24 _ERROR_POP_N     target=27
25 _DEOPT
26 _EXIT_TRACE
27 _EXIT_TRACE
28 _ERROR_POP_N     target=16
29 _DEOPT
30 _EXIT_TRACE
```

对着上一篇的知识逐段读它。

开头是入场手续。`_START_EXECUTOR` 记录当前 executor，`_MAKE_WARM` 把它标记为已用（防止刚建好就被当作冷的清理掉），`_SET_IP` 同步 frame 的指令位置，上一篇讲过，traceback 与调试器依赖它。

中段是一条压扁的循环体。`FOR_ITER_RANGE` 在 Tier 1 里是一条指令，这里被拆开：`_ITER_CHECK_RANGE` 验证迭代器仍是 range，`_GUARD_NOT_EXHAUSTED_RANGE` 检查是否耗尽（耗尽就走出口），`_ITER_NEXT_RANGE` 才产出下一个值。加法同样拆细：`_GUARD_NOS_INT` 顶住操作数类型，`_GUARD_TOS_OVERFLOWED` 保证累加值还没膨胀成多 digit 的大整数（3.16 的整数快路只吃 compact int），`_BINARY_OP_ADD_INT` 做加法本身。guard 与 action 分离成独立小步，这正是 micro-op 的含义：Tier 1 特化把 guard 藏进专用指令，Tier 2 把 guard 单独拆出来，让优化器能逐条分析、移动、删除。

尾部是出口表。`_JUMP_TO_TOP` 闭环回到序列开头，实现“循环不再经过 Tier 1 分派”。`_DEOPT`、`_EXIT_TRACE`、`_ERROR_POP_N` 是预留的逃生口：guard 失败去 Tier 1，异常抛出去错误处理。它们平时不被顺序执行，挂在表尾等跳跃。

## 两代架构：静态投影与追踪录制

trace 是怎么来的？这里 3.14 与 3.16 是两代答案，值得分别看清。

### 3.14：从字节码静态投影

3.14.7 的 `translate_bytecode_to_trace()` 不执行代码。它从热点指令出发，在字节码数组上做符号推演：逐条读入指令，查表展开成 uop，遇到分支就读 Tier 1 留在 inline cache 里的分支历史计数器，选“大概率走的那边”继续投影。

分支信心有预算：初始 `CONFIDENCE_RANGE = 1000`，每个分支按命中率折减，跌破 `CONFIDENCE_CUTOFF = 333` 就放弃整条 trace。分支越多、越接近五五开，trace 越难建，这解释了为什么高度分支化的代码从 Tier 2 获益有限。

遇到函数调用时，3.14 读 CALL 指令 cache 里记下的 `func_version`，反查出被调函数的 code object，把它的字节码也投影进来，完成一次跨函数内联。两道保险立即生效：递归调用直接放弃（否则 trace 无限膨胀），`func.__code__` 换过版本的也放弃（旧假设不可信）。

这条路线的弱点在于“大概率路径”只是猜测：计数器说通常走左边，trace 就只录左边。如果热身阶段的画像与稳态不同，建出的 trace 就要靠 side exit 反复补救。

### 3.16：边执行边录制的 trace recorder

3.16 快照把整层重写为追踪录制（trace recording interpreter）。`_JIT` 触发后并不立刻建 trace，而是进入 tracing mode：调度表被换掉，此后每条字节码执行完，都跳到 `TRACE_RECORD` 指令，把刚执行过的这条翻译成 uop 追加进缓冲区。

录制的就是真实执行：

- 分支走哪边，录哪边，不需要猜；
- 录制器顺手把经过的 adaptive 指令的 counter 重置，强迫 Tier 1 重新特化，保证录制期间的 cache 是新鲜的；
- 每条指令的“不逃逸值”（比如刚加载的常量）被 `record_func` 抓进 `prev_state.recorded_values`，留给后面优化用。

停止录制的时机由 3.16 引入的 fitness 预算决定：初始 `FITNESS_INITIAL`，每条指令按占用槽位扣费，分支按偏离度扣费，帧深度也扣费。fitness 跌到当前指令的“出口质量”（exit quality）阈值之下就停止录制。出口质量本身分了级：回到循环顶（最好）、落到别的 executor 上（次好）、一般位置（最差）。所以 trace 倾向于恰好停在能无缝衔接的地方。

两代对比一句话：3.14 读地图画路线，3.16 跟着车走一遍再画路线。共同点是都只录一条线性路径，岔路全部交给 side exit。

## trace 级优化：跨指令的分析

录出的原始 trace 还要过一遍优化器（`_Py_uop_analyze_and_optimize`）。这一步才是“跨指令”三个字兑现的地方。看一个最小例子：

```python
def helper(x):
    return x + 1

def caller(n):
    total = 0
    for i in range(n):
        total += helper(i)
    return total
```

`caller` 热身后（3.16 uop 构建），它的 executor 有 59 条 uop，其中与调用相关的段落：

```text
15 _LOAD_GLOBAL_MODULE
16 _PUSH_NULL
17 _LOAD_FAST_BORROW_2
18 _SET_IP
19 _SPILL_OR_RELOAD
20 _CHECK_FUNCTION_VERSION     ← guard：被调函数还是那个版本吗
21 _CHECK_STACK_SPACE_OPERAND  ← guard：栈够吗
22 _CHECK_RECURSION_REMAINING  ← guard：递归余量够吗
23 _INIT_CALL_PY_EXACT_ARGS_1
24 _SAVE_RETURN_OFFSET
25 _PUSH_FRAME                 ← 进入 helper 的帧
26 _TIER2_RESUME_CHECK
27 _LOAD_FAST_BORROW_0         ← helper 体内：读 x
28 _LOAD_CONST_INLINE_BORROW   ← helper 体内：读常量 1
29 _GUARD_NOS_OVERFLOWED     ← guard：x 仍是 compact int
30 _BINARY_OP_ADD_INT          ← helper 体内：x + 1
31 _POP_TOP_NOP
32 _POP_TOP_NOP
33 _SET_IP
34 _MAKE_HEAP_SAFE
35 _RETURN_VALUE               ← 返回 caller
```

三个层级的能力同时可见。

函数被内联了。`helper` 的字节码整段出现在 `caller` 的 trace 里，前后用 `_PUSH_FRAME`/`_RETURN_VALUE` 桥接。`helper` 自己从头到尾没有独立热身，`get_executor(helper.__code__, ...)` 在任何偏移都取不到 executor，它只作为调用者 trace 的一部分存在。调用协议的大部分开销（新 C 帧、参数打包、分派）在这条 trace 里消失了，只剩下三个 guard 兜底：函数版本变了、栈空间不够、递归太深，任一成立就退出。

常量被内联了。`_LOAD_CONST_INLINE_BORROW` 的操作数是一个裸指针。用 `ctypes` 检查它指向的对象：

```python
import ctypes
addr = list(ex)[28][3]     # _LOAD_CONST_INLINE_BORROW 的操作数
print(addr == id(1))       # True
```

指针直指小整数对象 `1`。字节码里的 `LOAD_CONST 1` 要走 co_consts 索引，而 trace 里常量的地址在构建时就已固定。globals 也有同等待遇：`_LOAD_GLOBAL_MODULE` 能出现在这里，是因为优化器确认过 builtins/globals 字典自上次以来没变过，名字查找的结果被当作常量固化，同时字典被挂上 watcher，一变就失效（见后文）。

微指令被合成与精简。`_CHECK_FUNCTION_VERSION` 是几个 guard 的合成形态；`_POP_TOP_NOP` 顾名思义，本来要弹栈的值已知会被丢弃，操作被消掉，只剩占位。3.14.7 的 `remove_unneeded_uops()` 还会删除顺序执行中冗余的 `_CHECK_VALIDITY` 与 `_SET_IP`：只有可能逃逸出去的点（可能触发失效、可能抛异常）才需要重新校验。

值得守住一条边界：这些优化全部带 guard。内联的调用有版本检查，固化的常量有字典 watcher，压扁的循环有类型守卫。优化器不改变语义，只改变“语义成立时的执行路径”。

## side exit：走热的出口长出新 trace

trace 是线性的，代码不是。每次“大概率分支”走错边、每次 guard 失败，执行都要离开 trace 回到 Tier 1，这个出口叫 side exit。

出口不是每次都真的回 Tier 1。每个出口带一个温度计数器（temperature backoff counter，3.14.7 初始值 4095）：冷出口每走一次扣一点，扣到触发点，Tier 2 就从这个出口的位置再建一条 trace，并把出口直接链接（link）到新 executor 上。此后这个分支不再回 Tier 1，而是在两条 executor 之间直接跳转。

双层循环能看出出口的工作方式：

```python
def nested(n):
    total = 0
    for x in range(n):
        for y in range(n):
            z = x + y
    return total

nested(2_000)
```

热身后，这个 code object 上挂着一只 executor：

```text
executors: [(84, 32 uops)]
```

offset 84 的 32-uop executor 对应外层循环的回边。检查它三个 `_EXIT_TRACE` 出口各自链接到哪里（3.16 的 `_testinternalcapi.get_exit_executor` 接收 `_EXIT_TRACE` 操作数里的出口 id）：

```text
exit ...048 -> 1 uop 的 executor: [_COLD_EXIT]
exit ...064 -> 1 uop 的 executor: [_COLD_EXIT]
exit ...080 -> 1 uop 的 executor: [_COLD_EXIT]
```

三只都是同一个对象：解释器全局单例的 cold executor，一只 immortal 对象，体内只有一条 `_COLD_EXIT`。这是 Tier 2 文档里那句"exits must be implemented as executors"的落地：出口不能直接是裸跳转，因为热了以后要被 patch 成指向新 executor 的快路。但绝大多数出口永远不热，为它们各建执行体太浪费，于是所有冷出口共享这一只占位 executor。

`_COLD_EXIT` 被走到时做三件事：查出口的温度计数器，还没倒数到触发点就回 Tier 1 继续跑；到了触发点，就从出口位置发起一次新的 trace 录制（chain depth 加一），录完把出口的绑定换成新 executor；若出口目标处恰好已有别的 executor，则直接缝合过去。

所以 side exit 的生命周期是渐进的：

```text
建 trace 时       出口 -> cold executor（共享单例）
走冷了            每次经过都回 Tier 1，温度计倒数
走热了            出口位置长出新 trace，出口重新绑定
```

一个分支密集的负载能看到整张图成形：

```python
def branched(n):
    acc = 0
    for i in range(n):
        if i % 3 == 0:
            acc += i
        elif i % 3 == 1:
            acc -= i
        else:
            acc ^= i
    return acc

branched(3_000_000)
```

```text
executors: [(82, 68 uops), (150, 49 uops)]

executor @ 82 的七个出口：五个 -> cold 存根，
                          一个 -> 18 uops（挂在别的 code object 上），
                          一个 -> cold 存根
executor @ 150 的七个出口：一个 -> executor @ 82（同函数，直接缝合），
                          六个 -> cold 存根
```

offset 150 的 executor 有一条出口不再指向冷存根，而是直接缝到 offset 82 的 executor 上，两条 trace 之间的转移完全留在 Tier 2 内部，不再穿过 Tier 1。哪条分支值得长出 executor、哪只保持共享冷存根，由运行时的实际温度决定，不由代码位置静态决定。

随着程序运行，热点路径逐渐连成一张 executor 图：边是出口，节点是各自线性的 trace（外加那只共享的 cold executor）。3.16 的 `tier2_engine.md` 把这称为 executor graph，并明确了设计意图：绝大多数控制流转移应该发生在这张图内部，跨 Tier 的往返只属于冷路径。

链条不是无限延伸的。`MAX_CHAIN_DEPTH = 4`：从 side exit 连出的 executor 到第四代必须“有进展”（能保证推进而非自我循环），否则不允许再挂。这是对病态分支模式的保险。

## 失效：动态语义的反制

Tier 2 固化得比 Tier 1 更深：常量地址、函数版本、字典内容都写进了 trace。动态语言对应的反制机制是失效（invalidation）。

每个 executor 建立时把依赖记进一个 Bloom filter：用到的 code object、内联的函数、当常量看的字典。任何全局性事件到来时，解释器扫描所有 executor 的依赖表，命中者立即失效。触发源包括：

```text
globals/builtins 字典被修改     （优化器挂的 watcher 回调）
类型对象被修改                  （type watcher 回调）
sys.settrace / 监测工具接管      （instrumentation 全量失效）
code object 自身被改写
```

失效后的 executor 不能再进：`ENTER_EXECUTOR` 处的检查退回原指令，`_CHECK_VALIDITY` 在 trace 内部随时可以把执行弹回 Tier 1。实测（3.16 快照）：

```python
import builtins

# 热身后
executor @ 54: valid=True    指令显示 JUMP_BACKWARD_JIT

builtins.range = lambda *a: range(*a)   # 动了个被当作常量的名字

executor: 不再可达             指令显示 JUMP_BACKWARD
# 重新热身
executor @ 54: valid=True    指令显示 JUMP_BACKWARD_JIT（重建）
```

一次 `builtins.range` 赋值，trace 里的常量假设全部作废。字节码回到 `JUMP_BACKWARD`，重新计数、重新录制、重新优化，循环回来时又是一只新 executor。语言语义没有让步分毫：改 builtins 前后，`sum_loop(100)` 的结果完全一致。

上一篇的结论在此升级了一层：Tier 1 的特化是“可撤销的假设”，Tier 2 的 trace 是“更大张的、成片可撤销的假设”。

## 机器码：copy-and-patch

到 uop 解释器为止，Tier 2 的执行仍是解释：一个 switch 循环逐条执行 micro-op，只是指令集换成了无分派开销、guard 显式化的那一套。完整 JIT 模式再多走一步，把 trace 变成机器码。

CPython 选择的技术叫 copy-and-patch：构建 CPython 时，构建系统（`Tools/jit/`）把每条 micro-op 的实现各编译成一个独立的机器码模板（stencil），从目标文件里抠出机器码与重定位信息存成表；运行时 `_PyJIT_Compile()` 把 trace 里每条 uop 对应的模板拼接进一块可执行内存，把操作数、跳转目标、guard 出口 patch 进去。没有传统 JIT 的运行时编译器，`clang` 只在构建 CPython 时用了一次（本机实验里构建脚本要求 LLVM 19/21，其余部分照旧用 gcc 编译）。

这就是 4096 字节的来历：31 条 uop 各自的模板连起来，加上出口表。

同一个 trace，两种可执行形式，语义严格等价。`--enable-experimental-jit=interpreter` 与完整 JIT 的差别只在执行引擎。这也给了分层调试的可能：uop 构建里 `PYTHON_LLTRACE=3` 能打出每条 micro-op 的执行轨迹，机器码里则没有这种可视性。

3.16 快照在这层又叠了新东西：stencil 拼接前，trace 先经过一轮文本汇编 IR 的优化 pass（`Tools/jit/_optimizers.py`，按 x86_64/AArch64 分别实现），做分支反转与死块消除。JIT 后端从“纯拼接”向“带优化的拼接”演化，copy-and-patch 的骨架未变。

## 提速多少：诚实的一组数字

本机三个构建跑同一组负载（数字为 5 轮取最优，单位秒）：

| 负载 | 默认 3.14.7 | 3.16 JIT | 3.16 uop |
| --- | --- | --- | --- |
| count_1M（纯整数循环） | 2.33 | 2.18 | 6.49 |
| fib27（递归调用） | 0.26 | 0.23 | 0.71 |
| sieve100k（分支+列表） | 0.16 | 0.14 | 0.33 |

三个观察，都值得写进结论。

uop 解释器比默认慢近三倍。这在预期之内：trace 录制、executor 维护、失效检查都有成本，micro-op 本身也比 Tier 1 的超指令更碎。Tier 2 的收益要靠机器码兑现，uop 模式的价值在于正确性与可调试性。「Tier 2 更高级所以更快」不成立：离开 JIT 后端，这层机制本身是负收益。

JIT 对这些负载的提速温和，约 6%–13%。三个负载在 Tier 1 时代已被特化照顾得很好：整数加法、range 迭代、递归的 Python-to-Python 调用，都是 Tier 1 的强项。Tier 2 的边际收益来自常量内联、调用消除与分派消除；收益真实存在，但这些微循环型负载不是它优势最大的场景。PEP 744 说得很清楚：这是实验性 JIT，性能随负载差异极大。

这些数字不能外推：无 PGO 的调试向构建、单机、三个手写负载。它们证明的只有机制在工作、语义未破，不构成基准测试结论。

## 三层边界，再划一次

### Python 语言语义

保证循环算对、调用对、异常对、动态修改立即生效。不保证：

- 存在 Tier 2 或 JIT；
- 循环会在第几次迭代后进入 executor；
- trace 里有 `_BINARY_OP_ADD_INT` 这个名字；
- 内联一定会发生；
- 任何加速比例。

### 诊断接口

`dis(adaptive=True)` 能看到 `JUMP_BACKWARD_JIT`；`_opcode.get_executor()` 能取出 executor 并迭代 micro-op，后者已经是半公开接口（测试套件在用），但它属于 CPython 内部协议，名称与形状随版本可变。

### 内部实现

```text
_PyOptimizer_Optimize          3.14 入口
_PyJit_TryInitializeTracing    3.16 入口（trace recorder）
ENTER_EXECUTOR / co_executors
_JUMP_TO_TOP / _EXIT_TRACE / _DEOPT
_PyJIT_Compile + jit_stencils
```

两代架构的差异必须写死在结论里：3.14.7 静态投影、按 counter 选路、confidence 预算；3.16 追踪录制、fitness 预算、exit quality 分级。3.14.7 的 `JUMP_BACKWARD` 初始计数 4095、3.16 快照改为 4000。源码注释解释了动机：这个值应当取“素数减一”，否则容易碰上病态采样（注释举的例子是 nqueens 基准：4095 总会让 tracer 录到循环耗尽的最后一次迭代而中途夭折）。拿任何一组数值当跨版本规律都是错的。

## 另一种执行形状

Tier 2 的入口在 JUMP_BACKWARD 的 counter 上。默认构建里这层休眠，热循环也只显示 `JUMP_BACKWARD_NO_JIT`；JIT 构建里同一位置换成 `JUMP_BACKWARD_JIT`，然后挂上 executor。executor 是一段 micro-op trace 加一张出口表：guard、操作、栈管理拆成独立小步，`_JUMP_TO_TOP` 让循环不再经过 Tier 1 分派，尾部预留 `_DEOPT`、`_EXIT_TRACE`、`_ERROR_POP_N` 逃生口。

trace 只录一条路径：3.14 从字节码静态投影，分支历史选路，confidence 做预算；3.16 追踪录制，真实执行即录像，fitness 做预算。走岔的分支交给 side exit，热了再各自长出新 executor，逐渐连成一张图。跨指令优化是 Tier 2 独有的能力：函数内联、常量固化、globals 视作常量，全部带 guard，全部可撤销。失效机制托住动态语义：改一个 builtins 名字，依赖它的 executor 立即作废，指令回到 `JUMP_BACKWARD` 重新升温。机器码是第三种形态，不是第三层语义：copy-and-patch 把构建期编译好的模板拼接成可执行代码，uop 解释器与机器码执行同一份 trace；uop 模式本身比默认更慢，Tier 2 的收益要靠 JIT 后端兑现。

上一篇的 `BINARY_OP_ADD_INT` 是一个操作点的记忆，这一篇的 executor 是一条路径的记忆。两者是同一套机制：观察、假设、守卫、失效。

这条主线到此都在单线程的背景下展开。多线程时代，引用计数先要活下来：下一篇进入 free-threaded CPython，看对象锁、延迟引用计数与 `Py_MOD_PER_INTERPRETER_GIL` 之外的另一种并行世界。
