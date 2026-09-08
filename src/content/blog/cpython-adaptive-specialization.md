---
title: 同一条字节码，为什么越跑越短：CPython 的自适应解释器与操作特化
description: 同一个 + 起初走通用 BINARY_OP，反复遇见 exact int 后却显示为 BINARY_OP_ADD_INT；类型一变，它又会退回或改学另一条路径。本文沿同一处操作点追踪 adaptive counter、inline cache、guard、专用指令与反特化，辨清逻辑字节码、当前执行形态和语言语义各自保证到哪里。实验在 CPython 3.14.7 上复核，并对照 CPython 3.12.13 与 3.16.0a0 开发源码。
pubDate: 2026-09-08T21:00:00+08:00
category: cpython
tags: [CPython, 编程语言, 解释器]
---

```text
刚创建函数          BINARY_OP
反复传入整数        BINARY_OP_ADD_INT
改为长期传入浮点数  BINARY_OP_ADD_FLOAT
```

三行观察都来自同一个函数：

```python
def add(left, right):
    return left + right
```

源代码没有改变，函数对象没有换掉，公开的 `co_code` 字节串在热身前后也完全相同。变化发生在解释器维护的自适应执行形态中。

所以标题里的“越跑越短”不是说字节码文件越来越小，也不是说一条指令从六个字节缩成两个字节。**变短的是 guard 命中时的执行路径：解释器为某个操作点写下一份可撤销的类型假设，暂时绕过一部分通用分派。**

上一篇追的是语义：一枚 `+` 进入 `PyNumber_Add()` 后，类型槽怎样安排 `__add__`、`__radd__`、严格子类优先、`NotImplemented` 与序列后备。这条路必须容纳 Python 的动态能力，因而足够通用。

可如果同一处 `left + right` 连续一万次都只看见 exact `int`，解释器还需要每次完整翻完同一本登记册吗？

这一篇就盯着这一处 `BINARY_OP`，看它怎样观察、改写、守卫、失手，再重新学习。

本文实验以 **CPython 3.14.7、x86_64 Linux、64 位、默认 GIL、非 debug 构建**为主，并与 CPython 3.12.13 做对照。稳定版内部机制参考 CPython 3.14 维护分支，开发方向则核对本地一份标记为 **CPython 3.16.0a0** 的源码快照；本地目录没有 Git 元数据，无法绑定到具体提交。专用 opcode、counter 数值、cache 布局与重试阈值都是版本实现事实，不是 Python 语言承诺。

## 上一篇回答找谁，这一篇回答还要不要再找

先把通用语义压缩成一张图：

```text
BINARY_OP(NB_ADD)
    ↓
_PyEval_BinaryOps[NB_ADD]
    ↓
PyNumber_Add(left, right)
    ↓
类型槽、正反向实现、NotImplemented、序列后备
```

上一篇已经逐层走过这条路径。它的重要性不因特化而消失：只要专用假设不成立，解释器仍要回到这里，保证用户类、子类、动态修改后的特殊方法和异常语义全部正确。

自适应解释器增加的不是另一套语言规则，而是一条有条件的短路：

```text
协议决定结果必须是什么
特化决定假设成立时可以少做哪些工作
```

这也是全文的底线。CPython 没有把动态 Python 改成静态类型语言；它只在一个具体操作点上，根据近期看到的对象形态，暂时相信一件可以撤销的事。

## `co_code` 与当前执行形态不是同一张照片

下面两种反汇编经常被当成互相矛盾的答案：

```python
import dis

dis.dis(add, adaptive=False)
dis.dis(add, adaptive=True)
```

在整数热身以后，第一种仍显示：

```text
BINARY_OP          0 (+)
```

第二种则显示：

```text
BINARY_OP_ADD_INT  0 (+)
```

两者观察的层次不同。

### `adaptive=False` 看逻辑视图

当前 `dis` 会读取 `co_code`。在现代 CPython 中，这是一份去专门化后的逻辑字节码表示：运行时数组中的专用形态会被还原成基础 opcode，cache 也以逻辑视图呈现。

它适合回答：

> 这段代码从编译意义上包含哪些 Python 字节码操作？

它不表示“临时关闭自适应解释器，再把函数执行一遍”。`adaptive=False` 改的是展示，不是运行模式。

### `adaptive=True` 看当前运行时形态

它改为读取私有的 adaptive bytecode 视图，能够看见当前已经改写的专用 opcode。

它适合回答：

> 此刻，这个解释器为这个 code object 的这个操作点选择了什么执行形态？

这仍只是一张当前快照，不是全部执行历史。一次异型输入可能 guard miss，却还没让 opcode 立刻换回通用形态；反过来，最终看见某个专用 opcode，也不能证明此前每次调用都命中了它。

### `show_caches=True` 只是展开 cache

它不会自动打开 `adaptive=True`，也不会创造 cache。它只让 `dis` 把指令旁边的内部 cache 数据格式化出来。四种组合都各有意义：

| 设置 | 主要观察 |
| --- | --- |
| `adaptive=False, show_caches=False` | 逻辑 opcode |
| `adaptive=False, show_caches=True` | 逻辑 opcode 与逻辑 cache 视图 |
| `adaptive=True, show_caches=False` | 当前专用 opcode，隐藏 cache 细节 |
| `adaptive=True, show_caches=True` | 当前专用 opcode 与运行时 cache |

本机实验还直接保存了：

```python
before = add.__code__.co_code

for _ in range(20_000):
    add(1, 2)

after = add.__code__.co_code
print(before == after)
```

```text
True
```

公开 `co_code` 没有变短。真正被解释器执行、能够原地改写的是 code object 内部的 adaptive/quickened code array；`co_code` 是面向 Python 层生成并缓存的逻辑表示。不能把二者说成解释器同时执行的两套字节码。

## 编译器不会提前写下 `ADD_INT`

源代码经过编译时，编译器只知道这是一项二元加法：

```text
AST Add
    ↓
NB_ADD
    ↓
BINARY_OP(NB_ADD)
```

它没有运行时参数，无法断定未来传进来的是整数、浮点数、字符串，还是明天才定义的用户类。因此不会直接生成 `BINARY_OP_ADD_INT`。

编译后的字节码布局已经为相应 family 留出 inline cache code units。code object 初始化时，CPython 执行 quickening：遍历这些既有位置，初始化 warmup counter，并完成必要的初始 opcode 修整。quickening 不是“已经按类型优化完成”；它更像在登记册旁放好一张空白便笺，等运行时现场来填写。

真正的类型 specialization 发生在执行期间。当 counter 到达尝试点，`_Py_Specialize_BinaryOp()` 查看这一刻的左右操作数和 `oparg`，再决定：

- 是否能改成整数加法；
- 是否能改成浮点加法；
- 是否能改成 Unicode 拼接；
- 是否能使用其他扩展专用形态；
- 或者当前没有合适快路，继续保留通用形态并延后重试。

因此专用 opcode 不是编译器对源码做出的永久类型声明，而是运行时对一个具体操作点写下的临时判断。

## inline cache 就贴在操作点旁边

“inline”不是营销词。cache 以额外 code units 的形式紧邻所属指令，位于运行时字节码数组内部：

```text
[BINARY_OP +]
[CACHE: counter]
[CACHE: family-specific storage]
[CACHE]
[CACHE]
[CACHE]
[next opcode]
```

在 CPython 3.14.7 的这项 `BINARY_OP` 实验中，`dis(..., show_caches=True)` 显示五个 cache 槽：

```text
冷态：
BINARY_OP          0 (+)
CACHE              0 (counter: 17)
CACHE              0 (descr: 0)
CACHE
CACHE
CACHE

热态：
BINARY_OP_ADD_INT  0 (+)
CACHE              0 (counter: 832)
CACHE              0 (descr: 0)
CACHE
CACHE
CACHE
```

这些 `CACHE` 行是反汇编器对内部数据的格式化展示，不是解释器把它们当普通业务 opcode 一条条执行。不同 family 会给 cache 字段不同含义；也不能因为 `BINARY_OP` 的第一项叫 counter，就断言所有 inline cache 都只保存类型或次数。

cache 贴在具体字节码位置旁边，意味着反馈也是 **per instruction site**。同一个函数里的两枚 `+` 可以学成两种形态：

```python
def pair(a, b, c, d):
    return a + b, c + d
```

冷态：

```text
['BINARY_OP', 'BINARY_OP']
```

反复执行：

```python
for _ in range(20_000):
    pair(1, 2, "雨", "声")
```

热态：

```text
['BINARY_OP_ADD_INT', 'BINARY_OP_ADD_UNICODE']
```

同一函数没有被整体“编译成整数版”或“字符串版”。第一处操作点记住整数，第二处记住 Unicode；两个相同语法符号各自维护自己的现场。

## counter 不是“已经执行了多少次”

上面的冷态 17 与热态 832 很容易被误读成：

```text
这条指令已经执行 17 次
这条指令已经执行 832 次
```

实际不是。counter 是一份带倒计时、冷却与 backoff 语义的内部状态编码。

它至少承担几类不同工作：

```text
冷态 warmup        何时首次尝试特化
特化后 cooldown    多少次 miss 后重新考虑形态
失败后 backoff     下次特化失败要隔多久再试
```

命中专用 guard 时，并不等于把它当普通执行计数器持续加一；guard miss、重新尝试和特化失败会推动不同状态变化。数值本身还经过编码，不能直接按十进制字面解释。

本机 CPython 3.14.7 与 3.12.13 都观察到冷态 17、热态 832；本地 3.16.0a0 开发快照的对应默认值已经不同。即使本机两版第二次执行就能触发首次尝试，连续 53 次 miss 后会重新考虑形态，也只能写成这两个构建和该 opcode family 的当前参数，不能写成 Python 的永久规则。

特化失败后，解释器也不会每次都急着重试。backoff 会拉长下一次尝试间隔，避免一个持续不稳定或根本没有专用形态的操作点反复支付相同失败成本。当前开发源码采用逐级增长并最终饱和的退避序列；具体编码和间隔仍是内部实现。

## 三种稳定输入，三条专用路径

给三个独立源码操作点分别喂稳定输入：

```python
def add_int(a, b):
    return a + b

def add_float(a, b):
    return a + b

def add_text(a, b):
    return a + b
```

每轮实验都在一个新进程中定义这三个拥有独立 code object 的函数，再分别观察冷态并执行 20,000 次相同类型输入。CPython 3.14.7 与 3.12.13 各五轮结果一致：

| 输入 | 冷态 | 热态 | 结果 |
| --- | --- | --- | --- |
| `1 + 2` | `BINARY_OP` | `BINARY_OP_ADD_INT` | `3` |
| `1.5 + 2.5` | `BINARY_OP` | `BINARY_OP_ADD_FLOAT` | `4.0` |
| `"雨" + "声"` | `BINARY_OP` | `BINARY_OP_ADD_UNICODE` | `"雨声"` |

这里特意使用三个独立函数定义。若用一个 `make()` 返回多个闭包，它们可能共享同一只 `__code__`，后创建的“冷函数”会继承前一个操作点已经积累的自适应状态，实验便把共享 code object 错当成独立现场。

这张表证明的是：当前两版 CPython 能为三个稳定、精确的内建类型组合选择不同专用形态。它不保证所有数值组合都有快路，不推广到子类，也不承诺未来版本继续使用同样的 opcode 名称。

## 从通用路径到整数短路

上一篇的通用加法路径是：

```text
BINARY_OP
    ↓
函数表选择 PyNumber_Add
    ↓
读取左右类型槽
    ↓
处理严格子类、反向实现与 NotImplemented
    ↓
落到整数实现
```

在 CPython 3.14 的 `BINARY_OP_ADD_INT` 中，specializer 先确认左右都是 exact `int`；guard 命中后，专用 action 可以直接进入整数加法实现，不再为这一次执行完整走过通用类型槽协商。

```text
BINARY_OP_ADD_INT
    ↓ exact-int guard
整数专用实现
```

“exact”非常重要。它不是 `isinstance(value, int)`：`bool` 与覆盖了 `__add__` 的 int 子类都不能被当作普通整数吞进快路，否则上一篇建立的动态分派语义就会被破坏。

专用路径也不等于“一条机器整数加法，不管溢出”。CPython 3.14 的整数专用 action 仍调用 Python 大整数实现，保持任意精度语义。用 `10**100` 作为左右输入，本机仍能形成 `BINARY_OP_ADD_INT`，每次结果都等于精确的 `2 * 10**100`。

这里要特别标出版本差异：当前 3.16.0a0 开发快照已经把这条 guard 收紧为 exact **且 compact** int，并改用更窄的 compact-integer 实现。大整数作为输入时会 guard miss，回到通用路径。不能拿 3.16 的条件解释 3.14.7，也不能把 3.14 接受大 exact int 写成 3.16 的承诺。

## guard miss 不等于算错，也不等于立刻改名

先把操作点热成整数形态：

```text
BINARY_OP_ADD_INT
```

接着只调用一次：

```python
add(1.0, 2.0)
```

本机结果是：

```text
返回值              3.0
adaptive 显示       BINARY_OP_ADD_INT
```

专用 opcode 仍然可见，结果却完全正确。这不是浮点数错误地走了整数实现。

专用路径先检查 guard。发现操作数不满足当前整数假设后，本次执行跳回通用 `BINARY_OP`，由完整语义路径处理浮点加法。此时操作点可以暂时保留整数专用形态，等待更多证据再决定是否改写。

因此至少要区分：

```text
guard miss          当前输入不满足假设
本次 fallback       当前执行改走通用语义
persistent rewrite  操作点自身改写成另一形态或通用形态
```

三者不是同一个时刻。一次 guard miss 不等于永久 deoptimization；`dis` 仍显示专用 opcode，也不等于刚才那只异型对象真的命中了快路。

## 同一位置可以改学另一条路

把前一个实验继续做下去。先执行 20,000 次整数，再向同一操作点连续传入浮点数：

```text
阶段             当前显示                 返回值
冷态             BINARY_OP                —
20,000 次 int    BINARY_OP_ADD_INT        3
第 1 次 float    BINARY_OP_ADD_INT        3.0
第 52 次 float   BINARY_OP_ADD_INT        3.0
第 53 次 float   BINARY_OP_ADD_FLOAT      3.0
```

CPython 3.14.7 与 3.12.13 在本机各五轮都得到相同转折点。

前 52 次不是“浮点也走整数快路”，而是每次 guard miss 后走通用后备，同时消费当前专用形态的 miss/cooldown 状态。第 53 次到达重新考虑的时机，specializer 看见当前操作数是 exact float，于是操作点直接改学 `BINARY_OP_ADD_FLOAT`。

这是一项**重特化**，不必先长时间停在可见的通用形态。若新输入本身有支持的专用路径，重新尝试时可以直接换过去。

接着改传普通用户类：

```python
class Box:
    def __init__(self, value):
        self.value = value

    def __add__(self, other):
        return ["old", self.value, other.value]
```

```text
第 1 次 Box    BINARY_OP_ADD_FLOAT   ['old', 3, 4]
第 53 次 Box   BINARY_OP             ['old', 3, 4]
第 100 次 Box  BINARY_OP             ['old', 3, 4]
```

用户类从第一次起就执行正确的 `__add__`。当前没有适合这类普通 heap type 的加法专用形态；积累足够 miss 后，操作点回到通用 `BINARY_OP`，特化失败又进入 backoff，稍后再尝试，而不是从此永远关掉观察。

现在动态修改类：

```python
Box.__add__ = lambda self, other: [
    "new",
    self.value,
    other.value,
]
```

已有实例立即返回：

```text
['new', 3, 4]
```

自适应优化没有冻结类型槽。用户类从未通过 exact float/int guard，guard miss 后始终由通用协议处理，所以类方法的动态更新仍然生效。

## 多态不是错误，只是单态假设反复失效

让同一操作点严格交替接收整数与浮点：

```python
for n in range(1, 20_001):
    args = (1, 2) if n % 2 else (1.0, 2.0)
    add(*args)
```

本机两版观察到的前几次形态切换是：

```text
第   2 次  BINARY_OP           -> BINARY_OP_ADD_FLOAT
第 107 次  BINARY_OP_ADD_FLOAT -> BINARY_OP_ADD_INT
第 212 次  BINARY_OP_ADD_INT   -> BINARY_OP_ADD_FLOAT
第 317 次  BINARY_OP_ADD_FLOAT -> BINARY_OP_ADD_INT
...
```

语言结果始终正确。这里可见的 Tier 1 cache 没有同时保存“整数分支 + 浮点分支”两条公开快路，而是维持一种当前单态专用形态；另一种类型出现时 guard miss，足够多 miss 后再替换当前形态。

这不表示动态类型“出错”或被惩罚。它只说明：对这个 `BINARY_OP` family 而言，稳定输入更容易持续命中一条短路；多态输入让可撤销假设频繁过期。

最终那一刻显示什么，取决于循环停在哪种输入和 counter 的当前状态。只截取最后一张 `dis` 输出，不能还原之前经历过多少次 int、float、miss 与重特化；要理解历史，必须在阶段边界记录状态，或使用 pystats 等更系统的统计工具。

## 优化不能吞掉用户定义的语义

专用整数形态仍然可见时，把 int 子类送进同一操作点：

```python
class IntChild(int):
    def __add__(self, other):
        return "subclass-add"
```

```text
操作点显示       BINARY_OP_ADD_INT
实际结果         subclass-add
```

int 子类不是 exact int，guard 不成立，本次回到通用类型槽协议，正确调用子类覆盖的方法。持续传入以后，当前整数专用形态会失去优势并回到通用状态。

另一个实验更直接。先让操作点保持 `BINARY_OP_ADD_INT`，再传入用户类，并在两次调用之间替换 `__add__`：

```text
specialized       BINARY_OP_ADD_INT
class-before      old
class-after       new
still-visible     BINARY_OP_ADD_INT
int-result        3
```

opcode 仍显示整数专用形态，因为它对整数输入仍然有价值；两次用户类调用都 guard miss，分别走到修改前后的动态槽实现。

这说明专用 opcode 不是“这个位置从今以后只准整数进入”。它只是说：

> 如果下一次输入满足 exact-int guard，就可以走整数短路；否则仍按通用语义执行。

## cache 不都保存同一种东西

“inline cache”常被一句话概括成“缓存操作数类型”，这仍然太粗。

对本文的基本 `ADD_INT`、`ADD_FLOAT`、`ADD_UNICODE`，很多条件可以直接从栈顶对象进行 exact-type guard；cache 的首要可见状态是 counter。其他 opcode family 则可能缓存完全不同的信息：

- 类型版本；
- 字典版本；
- 属性索引；
- descriptor；
- 调用目标；
- family 特有的静态 action 描述。

当前 3.16.0a0 的 `BINARY_OP` family 有五个 cache entries：第一项是 backoff counter，后四项可为 `BINARY_OP_EXTEND` 保存 descriptor 指针；普通加法专用形态只实质使用首项。3.14.7 的反汇编也预留五个槽，但不能据此把 3.16 descriptor 结构原样倒灌成 3.14 的稳定布局。

`BINARY_OP_EXTEND` 同样属于 Tier 1。它在 3.14 已经存在，3.16 扩大了对混合数值、列表、元组、bytes、重复操作和字典合并等组合的覆盖。它不是“调用任意扩展模块回调”的入口，也不是 Tier 2/JIT opcode；这里的 EXTEND 指 CPython 内部静态 descriptor 表扩展了专用操作集合。

## pystats 能补哪份证词

`dis` 擅长给某个操作点拍照，却不擅长统计长期事件总数。pystats 构建可以补充：

- specialization success；
- failure；
- hit；
- deferred；
- miss；
- deopt；
- failure kind；
- execution count。

构建时需要：

```sh
./configure --enable-pystats
make
```

运行时启用并汇总可以写成：

```sh
./python -X pystats experiment.py
./python Tools/scripts/summarize_stats.py <stats-output>
```

具体输出目录与汇总参数可能随版本变化，使用时应以对应源码树的配置文档和脚本帮助为准。

本机 `/usr/sbin/python3.14` 与对照的 3.12.13 都报告 `Py_STATS == 0`，也没有对应 stats API。因此本文没有 pystats 实验数据，只把它列为进一步验证工具，不能把源码里支持的统计项写成已经观察到的结果。

即使使用 pystats，也要区分 `miss` 与 `deopt`。一次 guard failure 会产生 miss 并回到通用路径；只有 counter 到达重新考虑时机，才涉及持久重特化或去专门化统计。二者不是同义词。

## Tier 1 不是 Tier 2，也不是 JIT

下文沿用源码和社区中仍常见的 Tier 1 / Tier 2 叫法；当前 3.16 内部文档同时说明它们属于历史称呼，正式讨论时更应看清各层实际职责。

本文讨论的是 **Tier 1 adaptive bytecode interpreter**：

```text
一条 bytecode instruction
    ↓
在同一 family 内选择专用 opcode
    ↓
用局部 guard 决定走短路还是通用后备
```

Tier 2 的粒度更大。它把一段热路径翻译成 micro-ops，形成可跨多条字节码分析和优化的 trace/executor。Tier 2 可以由 uop interpreter 执行，也可以交给实验性 JIT backend 生成 native code。

所以：

```text
Tier 1 specialization  ≠ Tier 2 trace
Tier 2 executor        ≠ 必然是 native JIT
JIT                    ≠ 本文的 BINARY_OP_ADD_INT
```

`BINARY_OP_EXTEND` 也仍在 Tier 1 family 内，只是它的 descriptor 元数据还能帮助更高层优化。

本文刻意不展开 Tier 2。读者若还不知道当前指令位置、operand stack 和局部变量放在哪里，trace 从哪里进入、guard 失败后回到何处便没有落点。下一篇应先进入执行帧与求值循环，再继续追跨指令优化。

## 三层承诺不能混写

### Python 语言语义

它保证 `left + right` 的可观察结果、特殊方法与异常协议。合法优化不得改变这些行为。

它不保证：

- 存在 `BINARY_OP`；
- 第二次执行就尝试特化；
- 连续 53 次 miss 后换形态；
- 专用 opcode 叫什么；
- cache 有几个槽；
- 使用 Tier 1、Tier 2 或 JIT。

### `dis` 诊断接口

它可以在当前版本中展示：

- 逻辑字节码；
- 当前 adaptive 形态；
- 格式化后的 cache 信息。

但 opcode 名称、cache 字段和输出格式都可能变化。`adaptive=True` 与 `show_caches=True` 是两个独立选择；私有 `_co_code_adaptive` 更不应成为业务逻辑依赖。

### CPython 内部实现

下面这些属于源码快照中的内部符号：

```text
co_code_adaptive
_PyCode_Quicken
_Py_Specialize_BinaryOp
BINARY_OP_ADD_INT
adaptive_counter_backoff
BINARY_OP_EXTEND
```

3.14 与当前 3.16 已经展示出 guard、action、cache descriptor 和 Tier 2 对接方式的变化。源码能解释该版本为什么出现这份输出，不能替未来版本签署布局协议。

free-threaded 3.16 还有额外边界：thread-local bytecode 允许不同线程拥有自己的专门化副本。于是“一个 code object 永远只有一份 adaptive 数组”也不能跨构建成立；禁用 TLBC 还会连带禁用 specialization。

## 变短的是路，不是规则

**编译器只生成通用 `BINARY_OP`。** 专用 opcode 是运行时根据当前操作点观察到的对象形态原地改写出来的。

**公开 `co_code` 与 adaptive 执行数组不是同一观察层。** 热身前后 `co_code` 可以完全相同，`adaptive=True` 却显示不同专用形态。

**inline cache 属于具体 instruction site。** 同一函数里的两枚加号可以分别学会整数加法和 Unicode 拼接，不存在“整个函数统一变成整数版”。

**counter 不是普通执行次数。** 它编码 warmup、cooldown 与 backoff；17、832、第二次尝试和 53 次 miss 都只是当前版本参数。

**专用 opcode 是带 guard 的可撤销假设。** guard 命中走短路，miss 则让本次执行回到通用语义；一次 miss 不等于立刻永久去特化。

**Tier 1 `BINARY_OP` 是单态并可重特化的。** 它不在同一 cache 中公开保存多个类型分支；多态输入会让当前假设竞争和更替。

**优化不能吞掉动态语义。** exact built-in guard 会排除子类与用户对象，动态修改后的 `__add__` 仍由通用类型槽协议执行。

**版本差异必须写进结论。** 3.14/3.12 的整数专用路径接受大 exact int；当前 3.16 开发快照只接受 exact compact int。

**`dis` 是诊断窗口，不是执行历史录像。** 最终 opcode 只说明当前状态，不能单独还原此前所有 hit、miss 与退化。

**Tier 1 不是 Tier 2，也不是 JIT。** 单指令特化、跨指令 trace 与 native code 是三层不同机制。

---

```text
第一次，解释器翻开通用登记册。
第二次，它在操作点旁写下一张整数便笺。
类型改变，便笺没有强迫现实服从它；守卫让执行回到原路。
新的形状持续出现，旧便笺被改写，或暂时收起。
```

同一条逻辑字节码没有变成静态类型承诺。CPython 只把近期稳定的事实写成一份可撤销假设：命中时少走几道门，失效时仍回到完整语义。

可一条指令从来不独自执行。谁保存下一条 instruction pointer，谁托住 operand stack，函数调用怎样换入新现场，异常和返回又怎样交回控制权？下一篇进入 `_PyInterpreterFrame` 与 `_PyEval_EvalFrameDefault()`，沿一次函数调用看执行帧怎样承载局部变量、数据栈与当前位置。等 Tier 1 的字节码循环站稳以后，再继续追 Tier 2 的 trace 与 micro-op executor。
