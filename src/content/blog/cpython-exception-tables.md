---
title: 不出事不花钱：3.11 把 try 的账本挪出了字节码
description: 3.11 之前，每个 try 都要在字节码里先交 SETUP_FINALLY 的入场费；3.11 之后，字节码里一个 try 的痕迹都不剩，异常真发生时才去查 code object 旁边那张 varint 编码的表。本文从 dis 的输出出发，手工解码 co_exceptiontable 的每一个字节，用基准测试把「零成本」变成数字，再跟进 ceval 的展开循环、assemble 的编码器和 InternalDocs 的官方文档。实验在 CPython 3.14.7 上复核，并对照 3.16.0a0 开发源码。
pubDate: 2026-09-09
category: cpython
tags: [CPython, Python, 解释器]
---

CPython 系列写到第十五篇。帧与求值循环篇讲过帧怎么被字节码驱动，特化与 Tier 2 篇讲过热代码怎么变快——但当时有一块故意绕开了：**异常发生的时候，解释器怎么知道该跳去哪**。JIT 那篇讲 trace 构建时留了一句「异常边不进 trace」，就此搁下。这一篇把这个坑填上。

填法照这个系列的惯例来：先看现象，再拆字节，最后进源码。先摆一个反直觉的事实——

```python
def f(x):
    try:
        return 1 / x
    except ZeroDivisionError:
        return -1
```

`dis.dis(f)`，看 try 的 body：

```text
 5   L1:     LOAD_SMALL_INT           1
             LOAD_FAST_BORROW         0 (x)
             BINARY_OP               11 (/)
     L2:     RETURN_VALUE
```

三条指令，除法，返回。**没有任何一条「进入 try」的指令**。没有 SETUP，没有 PUSH，没有注册 handler——try body 的机器指令和没写 try 的版本一模一样。

那 `except` 靠什么生效？答案在反汇编的尾部，一块容易被忽视的输出：

```text
ExceptionTable:
  L1 to L2 -> L3 [0]
  L3 to L4 -> L6 [1] lasti
  L5 to L6 -> L6 [1] lasti
```

一张表。异常没发生时，它不存在于执行路径上；异常发生时，解释器拿出错位置当索引去查它。这是 3.11 引入的 **zero-cost exception handling**——官方 What's New 的原话：「"Zero-cost" exceptions are implemented, eliminating the cost of `try` statements when no exception is raised」（Mark Shannon，bpo-40222）。实验在 CPython 3.14.7 上复核，并对照 3.16.0a0 开发源码。

## 旧世界：先买票，后上车

要理解这张表解决了什么，得先看旧世界怎么收钱。

3.10 及以前，编译器为每个 try 在字节码里安一条 `SETUP_FINALLY`：执行到它，就把 handler 的位置压进解释器的「块栈」（block stack）——一个运行时维护的登记簿。try body 结束时 `POP_BLOCK` 注销，异常抛出时沿着块栈找最近登记的 handler。相应的，没写 try 的代码不用交这笔钱，写了 try 的代码**每进一次 try 就执行一次登记**——哪怕异常从来不发生。

这套机制的问题不是慢——两条指令而已——而是**它把少见事件的开销摊到了常见路径上**。Python 社区多年有个习惯性劝告：循环里别放 try，有性能成本。这话在 3.10 是真的。

C++ 当年也面对过同一道题，给出的答案是零成本异常（zero-cost exceptions / table-based unwinding）：正常路径不执行任何登记指令，异常发生时用出错 PC 查一张 `.eh_frame` 表找到 handler——代价从「每次都付」变成「出事时多付一点」。3.11 的 CPython 走的是同一条路，`SETUP_FINALLY` 和 `POP_BLOCK` 从字节码清单里整个消失（What's New 的 removed opcodes 列表里就有它们），登记簿换成 code object 里的静态数据。InternalDocs/exception_handling.md 的表述很直白：SETUP_FINALLY 降级为**伪指令**——只存在于编译中间态，落到字节码前被抽走，转换成旁边的表。

新世界里 try 的唯一残留是 body 前那条 `NOP`——对齐用的占位，别的什么都不是。

## 十二个字节，四个数字一组

表住在哪、长什么样？`co_exceptiontable`，code object 的一个字节串字段。还是那个 `f`，把它整个拿出来：

```python
table = f.__code__.co_exceptiontable
print(' '.join('%02x' % b for b in table))
```

```text
82 08 0b 00 8b 0d 1b 03 9a 01 1b 03
```

十二个字节，装着 dis 显示的三条记录。这串字节的格式在 InternalDocs 里写得明明白白：每条 entry 是一个五元组——`起始偏移`（含）、`结束偏移`（不含）、`目标偏移`、`栈深度`、`是否压入出错位置`——压缩成四个 varint 编码的数字：`start, size, target, depth_and_lasti`。

varint 的规则：每个字节贡献 6 个数据位（低 6 位），最高位标记「entry 从这里开始」，次高位（0x40）标记「后面还有续字节」。手工解一遍第一组：

```text
82 08 0b 00
```

- `0x82`：`1000 0010`——MSB 置位说明这是 entry 开头，续位没置，数据位 `000010` = 2，所以 `start = 2`；
- `0x08`：`size = 8`，覆盖 `[2, 10)`；
- `0x0b`：`target = 11`；
- `0x00`：`depth_and_lasti = 0`，即 `depth = 0 >> 1 = 0`、`lasti = 0 & 1 = false`。

对照 dis：L1 在偏移 2（NOP 之后），L2 在偏移 10 之前，handler L3 在偏移 11——**`[2, 10) -> 11, depth=0`**，和第一行 `L1 to L2 -> L3 [0]` 严丝合缝。三组全解出来对账：

```text
start=2  end=10 target=11 depth=0 lasti=False   → L1 to L2 -> L3 [0]
start=11 end=24 target=27 depth=1 lasti=True    → L3 to L4 -> L6 [1] lasti
start=26 end=27 target=27 depth=1 lasti=True    → L5 to L6 -> L6 [1] lasti
```

注意后两条覆盖的是 **handler 自己的字节**：except body 里再出异常（比如 `CHECK_EXC_MATCH` 不匹配时 `RERAISE`），交给外层 handler——L6 是编译器生成的兜底块（`COPY 3 / POP_EXCEPT / RERAISE 1`，负责把栈上的 except 状态收拾干净再抛）。

还有一个值得单独看的字段：**depth**。handler 入口需要栈处于什么形状，编译时就知道了，写进表里。异常展开到 handler 之前，解释器按这个数把栈弹到指定深度——try body 里不管压了多少中间值（一个没算完的表达式、一次调用的一半参数），统统清掉。表格第五列那个 `lasti` 则服务 `finally` 和 re-raise：为真时，出错指令的偏移会先压栈，`RERAISE` 靠它把异常归位到原始位置。

## 什么都没发生的代价

「零成本」要拿数字验证。try 包住循环体，和不包，跑同样的计算：

```python
no_try  = compile("s = 0\nfor i in range(100):\n    s += i", '<b>', 'exec')
with_try = compile("""s = 0
for i in range(100):
    try:
        s += i
    except ZeroDivisionError:
        pass""", '<b>', 'exec')
```

各自预编译成 code object，用 `timeit` 只测执行（排除编译差异），交替跑三轮：

```text
无 try : 0.0123   有 try : 0.0124
无 try : 0.0134   有 try : 0.0166   # 这轮机器噪声大
无 try : 0.0136   有 try : 0.0125
```

差异在噪声以内——有时有 try 的反而更快。零成本不是修辞，是实测：**try body 里的指令流和裸代码完全一致，表只在旁边静静躺着，不被执行的代码不花钱**。

代价去了哪里？出事的时刻。异常真的抛出时，解释器要多走一趟查表、按 depth 清栈。官方文档说这笔「出事税」不大——3.11 同期还把异常在栈上的表示从三个元素（type/value/traceback）简化成一个，捕获路径反而快了约 10%。常态零成本，异常路径还变快了：这是把优化做在了刀刃上。

## 出事那一刻：展开循环

真出事时执行的是哪段代码？`Python/bytecodes.c` 里有个专门的标签 `exception_unwind`——帧与求值循环篇讲过的中央循环里，异常冒泡的必经站：

```c
spilled label(exception_unwind) {
    STOP_TRACING();
    int offset = INSTR_OFFSET()-1;
    int level, handler, lasti;
    int handled = get_exception_handler(
        _PyFrame_GetCode(frame), offset, &level, &handler, &lasti);
    if (handled == 0) {
        // 本帧没有 handler：清空本帧栈，向调用者冒泡
        ...
        goto exit_unwind;
    }
    ...
}
```

拿当前指令偏移问 `get_exception_handler`（实现在 `Python/ceval.h`）。查到，就按 depth 弹栈、按需压 lasti、压异常值、跳到 handler 继续；查不到，本帧栈清空、`goto exit_unwind`——求值循环返回 NULL，异常交给调用者的帧，调用者拿 `CALL` 指令的偏移去查它自己的表。一层层向上，直到有人接住，或者最顶层把 traceback 打印出来。

`get_exception_handler` 的查找本身也值得看一眼——变长 entry 怎么二分？诀窍在编码里：**每个 entry 的第一个字节 MSB 必然置位**（`assemble.c` 里 `assemble_emit_exception_table_item(a, start, (1<<7))` 那个参数就是干这个的）。于是任意位置往回扫到第一个 MSB 字节，就找到了 entry 边界；entry 本身按 start 升序排列，二分照常进行。小表（40 字节以内，`MAX_LINEAR_SEARCH`）直接线性扫，大表二分到小区间再收尾。紧凑与可查，一个 bit 就兼顾了。

这套跨帧展开可以用 `sys.monitoring`（3.12 引入的官方观测层，PEP 669）当场看见。盯住 RAISE 和 PY_UNWIND 两个事件：

```python
def inner():
    return 1 / 0            # 抛出，inner 的表里没有 handler

def outer():
    try:
        inner()
    except ZeroDivisionError:
        return '接住了'
```

```text
('inner', 16)    # RAISE：BINARY_OP 处抛出
('inner', 16)    # PY_UNWIND：查 inner 的表——无 handler，本帧栈清空，冒泡
('outer', 12)    # PY_UNWIND：查 outer 的表——CALL 指令在 L1..L2 内，命中 -> L3
接住了
```

三个事件把文档里的流程逐字演了出来：inner 查表落空、帧栈清空、向上冒泡；outer 在 CALL 的偏移上查表命中，跳进 L3 的 `PUSH_EXC_INFO`。顺带一提，实验里有个小坑：回调不能对 PY_UNWIND 返回 DISABLE——这个事件按 PEP 669 的设计**不许工具关闭**，因为调试器依赖它保证语义完整。

## 表是怎么生成的：编译器的三步走

回头看编译这一侧。InternalDocs 讲得清楚，中间码里 `SETUP_FINALLY` 伪指令还在（`Python/codegen.c` 里 try 的编译就生成它），到 `Python/assemble.c` 落字节码的阶段才被抽走换算成表——`assemble_exception_table()` 扫一遍指令序列，把连续的、指向同一 handler 的指令合并成一段区间，写成 varint entry。这正是 dis 输出里三条而非六条的原因：**相邻同 handler 的区间被合并了**。

合并的痕迹在嵌套 try 里最直观：

```text
ExceptionTable:
  L1 to L2 -> L3 [0]      # 外层 try body → 内层 handler？不——
  L3 to L4 -> L7 [1] lasti
  ...
```

每层 try 的边界、handler 自身的覆盖、finally 的兜底块，各自成段；谁覆盖谁，编译期的控制流分析一锤定音，运行期只管查表。这也回应了 JIT 篇那个搁下的问题：**Tier 2 的 trace 为什么难穿异常边**——trace 是直线代码，异常边是「任意指令都可能跳去别处」，好在查表的入口只有一个（`exception_unwind`），side exit 之外的异常只需要终止 trace 回 Tier 1，由老老实实的展开循环接管。

## 前后对一眼

| | 3.10 及以前 | 3.11 起 |
| --- | --- | --- |
| try 的入场费 | 每次进入执行 `SETUP_FINALLY` | 无，body 与裸代码同指令流 |
| handler 登记 | 运行时块栈（block stack） | code object 静态表 `co_exceptiontable` |
| 未覆盖的代码 | 也要付块栈维护成本 | 不进表，零字节 |
| 异常发生时 | 沿块栈找 handler | 查表（线性/二分）+ 按 depth 清栈 |
| 异常的栈表示 | type/value/traceback 三元组 | 单个异常对象 |

在 3.16.0a0 开发版上把同一份 `f` 跑了一遍：表格式没变（varint、MSB 边界、四元组全同），entry 数量多了一条——开发版的行号边界更细，属于实现细节的演化而非格式变更。3.14.7 的 `assemble.c` 与 `ceval.h` 和 3.16 源码逐行对照，编码与查找逻辑一致。

## 代价，认真地

**零成本说的是常态，不是异常路径。**查表、清栈、跨帧冒泡，出事时每一步都是真实的开销——只是从「人人预付」改成了「肇事者自付」。高频抛异常当控制流用的代码（`StopIteration` 驱动的循环、拿异常做早退）在 3.11 前后的对比不会体现「零成本」的好处，它们付的是另一头的账。

**表合并有边界。**相邻同 handler 才合并；交替 try 的代码（异常边界犬牙交错）表会变大，极端情况下每几条指令一段。不过表不执行、只查一次，大表的代价是内存和查找，不是常态开销——方向上仍然划算。

**格式是 CPython 的私事。**`co_exceptiontable` 的 varint 编码、MSB 约定、depth 位打包，都是内部格式，没有跨实现标准（不像 .pyc 起码有 marshal 的兼容承诺）。本文手工解码是为了看懂，不是建议依赖它写工具——要观测异常流，`sys.monitoring` 才是公共接口。

**「finally 也要清栈」的语义没变。**表只是把「去哪」从运行时挪到了编译期；到了 handler 之后，栈的收拾（`PUSH_EXC_INFO`/`POP_EXCEPT`/`RERAISE` 的舞蹈）还是字节码明着做的。零成本化没有取消任何语义，只是重新分配了记账的位置。

---

这个系列写到这里，「解释器怎么跑」的图已经完整了：帧篇给了骨架，特化与 JIT 篇给了快路径，这篇补上了最后一类控制流——异常的岔路。回头看它其实早就出场过：dict 篇的 `__missing__`、迭代器篇的 `StopIteration`、asyncio 篇 Task 里的 `set_exception`——所有那些「异常当值传递」的机制，落到字节码层，走的都是这张表。

最妙的是设计姿态：不是把 try 做得更快，而是把 try 的成本**搬到出事的人身上**。绝大多数代码一生不抛一次异常，让它们分文不付；真出事的那次，查一张紧凑到十二字节的表，多花的纳秒由肇事指令自己认领。

雨天读源码至此，合上电脑。窗外的雷倒是很有兴趣看看这张表——毕竟它一辈子都在等一次异常，好证明自己物有所值。
