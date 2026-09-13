---
title: 不出事不花钱：3.11 把 try 的成本挪出了字节码
description: 3.11 之前，每个 try 都要在字节码里先交 SETUP_FINALLY 的入场费；3.11 之后，字节码里一个 try 的痕迹都不剩，异常真发生时才去查 code object 旁边那张 varint 编码的表。本文从 dis 的输出出发，手工解码 co_exceptiontable 的每一个字节，用基准测试把「零成本」变成数字，再跟进 ceval 的展开循环、assemble 的编码器和 InternalDocs 官方文档。实验跑在 CPython 3.14.7 上，格式另对照 3.16.0a0 开发源码。
pubDate: 2026-09-09
category: cpython
tags: [CPython, Python, 解释器]
---

帧与求值循环篇讲过帧怎么被字节码驱动，特化与 Tier 2 篇讲过热代码怎么变快，但当时有一块故意绕开了：异常发生的时候，解释器怎么知道该跳去哪。JIT 那篇讲 trace 构建时留了一句「异常边不进 trace」，就此搁下。这一篇把这块补上。

讲法还是先看现象，再拆字节，最后进源码。从一个反直觉的事实开始。

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

三条指令，除法，返回。没有任何一条「进入 try」的指令。没有 SETUP，没有 PUSH，没有注册 handler，try body 的指令和没写 try 的版本一模一样。

那 `except` 靠什么生效？答案在反汇编的尾部，一块容易被忽视的输出：

```text
ExceptionTable:
  L1 to L2 -> L3 [0]
  L3 to L4 -> L6 [1] lasti
  L5 to L6 -> L6 [1] lasti
```

一张表。异常没发生时，它不存在于执行路径上；异常发生时，解释器拿出错位置当索引去查它。这是 3.11 引入的 zero-cost exception handling，官方 What's New 的原话：「"Zero-cost" exceptions are implemented, eliminating the cost of `try` statements when no exception is raised」（Mark Shannon，bpo-40222）。本文实验跑在 CPython 3.14.7 上，源码同时对照 3.16.0a0 开发快照。

## 旧世界：先买票，后上车

要理解这张表解决了什么，得先看旧方案的成本。

3.10 及以前，编译器为每个 try 在字节码里安一条 `SETUP_FINALLY`：执行到它，就把 handler 的位置压进解释器的「块栈」（block stack），一个运行时维护的登记结构。try body 结束时 `POP_BLOCK` 注销，异常抛出时沿着块栈找最近登记的 handler。没写 try 的代码不用付这个成本，写了 try 的代码每进一次就登记一次，哪怕异常从来不发生。

这套机制的问题不在慢，两条指令而已；问题在它把少见事件的开销摊到了常见路径上。Python 社区多年有个习惯性劝告：循环里别放 try，有性能成本。这话在 3.10 是真的。

C++ 当年也面对过同一道题，给出的答案是零成本异常（zero-cost exceptions / table-based unwinding）：正常路径不执行任何登记指令，异常发生时用出错 PC 查一张 `.eh_frame` 表找到 handler，代价从「每次都付」变成「出事时多付一点」。3.11 的 CPython 走的是同一条路：`SETUP_FINALLY` 和 `POP_BLOCK` 从字节码清单里整个消失（What's New 的 removed opcodes 列表里就有它们），运行时登记结构换成 code object 里的静态数据。InternalDocs/exception_handling.md 的表述很直白：SETUP_FINALLY 降级为伪指令，只存在于编译中间态，落到字节码前被抽走，转换成旁边的表。

新世界里 try 的唯一残留是 body 前那条 `NOP`：对齐用的占位，别的什么都不是。

旧世界与新世界的指令流：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 234" role="img" aria-label="3.10 与 3.11 的 try 成本对照：旧世界每个 try 在字节码里有 SETUP_FINALLY 入场指令，执行到它就往运行时块栈登记 handler，body 结束 POP_BLOCK 注销；新世界 body 指令流与裸代码完全一致，handler 信息住在 code object 旁的静态表里，不被执行不花钱" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">先买票后上车 vs 出事才查表</text>
<text class="t" x="170" y="48" text-anchor="middle" font-size="12" fill="#2b2a26">3.10 及以前</text>
<rect class="bx-sick" x="70" y="60" width="200" height="26" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="170" y="77" text-anchor="middle" font-size="10" fill="#6b675e">SETUP_FINALLY → 压块栈登记</text>
<rect class="bx" x="70" y="92" width="200" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="170" y="109" text-anchor="middle" font-size="10" fill="#6b675e">try body 指令</text>
<rect class="bx" x="70" y="124" width="200" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="170" y="141" text-anchor="middle" font-size="10" fill="#6b675e">POP_BLOCK 注销</text>
<text class="ts" x="170" y="170" text-anchor="middle" font-size="10" fill="#6b675e">每进一次 try 登记一次，</text>
<text class="ts" x="170" y="186" text-anchor="middle" font-size="10" fill="#6b675e">哪怕异常从不发生</text>
<text class="t" x="490" y="48" text-anchor="middle" font-size="12" fill="#2b2a26">3.11 起</text>
<rect class="bx" x="390" y="60" width="200" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="490" y="77" text-anchor="middle" font-size="10" fill="#6b675e">NOP（对齐占位，仅此而已）</text>
<rect class="bx-q" x="390" y="92" width="200" height="26" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="490" y="109" text-anchor="middle" font-size="10" fill="#6b675e">try body：与裸代码同指令流</text>
<rect class="bx-gone" x="390" y="124" width="200" height="26" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="490" y="141" text-anchor="middle" font-size="10" fill="#6b675e">co_exceptiontable：躺在旁边</text>
<text class="ts" x="490" y="170" text-anchor="middle" font-size="10" fill="#6b675e">不执行的代码不花钱：</text>
<text class="ts" x="490" y="186" text-anchor="middle" font-size="10" fill="#6b675e">出事时才拿偏移来查</text>
<text class="ts" x="20" y="218" font-size="12" fill="#6b675e">与 C++ 的 .eh_frame 同题同解：成本从「每次都付」改成「出事时多付一点」</text>
</svg>
</figure>

## 十二个字节，四个数字一组

表住在哪、长什么样？`co_exceptiontable`，code object 的一个字节串字段。还是那个 `f`，把它整个拿出来：

```python
table = f.__code__.co_exceptiontable
print(' '.join('%02x' % b for b in table))
```

```text
82 08 0b 00 8b 0d 1b 03 9a 01 1b 03
```

十二个字节，装着 dis 显示的三条记录。这串字节的格式在 InternalDocs 里写得明明白白：每条 entry 是一个五元组，起始偏移（含）、结束偏移（不含）、目标偏移、栈深度、是否压入出错位置，压缩成四个 varint 编码的数字：`start, size, target, depth_and_lasti`。

varint 的规则：每个字节贡献 6 个数据位（低 6 位），最高位标记「entry 从这里开始」，次高位（0x40）标记「后面还有续字节」。手工解一遍第一组：

```text
82 08 0b 00
```

- `0x82`：`1000 0010`，MSB 置位说明这是 entry 开头，续位没置，数据位 `000010` = 2，所以 `start = 2`；
- `0x08`：`size = 8`，覆盖 `[2, 10)`；
- `0x0b`：`target = 11`；
- `0x00`：`depth_and_lasti = 0`，即 `depth = 0 >> 1 = 0`、`lasti = 0 & 1 = false`。

对照 dis：L1 在偏移 2（NOP 之后），L2 在偏移 10 之前，handler L3 在偏移 11，即 `[2, 10) -> 11, depth=0`，和第一行 `L1 to L2 -> L3 [0]` 完全对应。三组全解出来核对：

```text
start=2  end=10 target=11 depth=0 lasti=False   → L1 to L2 -> L3 [0]
start=11 end=24 target=27 depth=1 lasti=True    → L3 to L4 -> L6 [1] lasti
start=26 end=27 target=27 depth=1 lasti=True    → L5 to L6 -> L6 [1] lasti
```

第一组字节的位级解剖：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 276" role="img" aria-label="varint 编码解剖：首字节 0x82 的最高位 1 标记 entry 开始，次高位是续字节标志，低 6 位是数据；四个字节解出 start=2、size=8、target=11、depth 与 lasti 打包为 0，对应区间 [2,10) 跳到偏移 11" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="excAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">0x82 = 1000 0010：一个字节三种身份</text>
<rect class="bx-sick" x="60" y="44" width="44" height="34" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="82" y="66" text-anchor="middle" font-size="11" fill="#b03a2e">1</text>
<rect class="bx" x="104" y="44" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="126" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<rect class="bx-q" x="148" y="44" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="170" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<rect class="bx-q" x="192" y="44" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="214" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<rect class="bx-q" x="236" y="44" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="258" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<rect class="bx-q" x="280" y="44" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="302" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<rect class="bx-q" x="324" y="44" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="346" y="66" text-anchor="middle" font-size="11" fill="#6b675e">1</text>
<rect class="bx-q" x="368" y="44" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="390" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<text class="ts" x="82" y="96" text-anchor="middle" font-size="10" fill="#6b675e">MSB：entry 开头</text>
<text class="ts" x="126" y="112" text-anchor="middle" font-size="10" fill="#6b675e">续位 0x40</text>
<path class="fl" d="M148 84 L148 90 L412 90 L412 84" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="280" y="106" text-anchor="middle" font-size="10" fill="#6b675e">6 个数据位 = 000010 → start = 2</text>
<rect class="bx" x="20" y="126" width="140" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="90" y="147" text-anchor="middle" font-size="10" fill="#6b675e">0x82 → start=2</text>
<rect class="bx" x="170" y="126" width="140" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="240" y="147" text-anchor="middle" font-size="10" fill="#6b675e">0x08 → size=8</text>
<rect class="bx" x="320" y="126" width="140" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="390" y="147" text-anchor="middle" font-size="10" fill="#6b675e">0x0b → target=11</text>
<rect class="bx" x="470" y="126" width="170" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="555" y="147" text-anchor="middle" font-size="10" fill="#6b675e">0x00 → depth=0 · lasti=F</text>
<line class="fl" x1="330" y1="160" x2="330" y2="176" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs2)"/>
<rect class="bx-q" x="130" y="180" width="400" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="330" y="201" text-anchor="middle" font-size="11" fill="#b03a2e">entry：[2, 10) → 11，即 dis 的「L1 to L2 -> L3 [0]」</text>
<text class="ts" x="20" y="240" font-size="12" fill="#6b675e">MSB 必置位是查找的钥匙：任意位置往回扫到第一个 MSB 字节就找到 entry 边界，二分照常做</text>
<text class="ts" x="20" y="260" font-size="12" fill="#6b675e">≤40 字节的小表直接线性扫；depth 管清栈清到几层，lasti 管 RERAISE 能不能归位</text>
</svg>
</figure>

注意后两条覆盖的是 handler 自己的字节：except body 里再出异常（比如 `CHECK_EXC_MATCH` 不匹配时 `RERAISE`），交给外层 handler。L6 是编译器生成的兜底块（`COPY 3 / POP_EXCEPT / RERAISE 1`，负责把栈上的 except 状态收拾干净再抛）。

还有一个值得单独看的字段：depth。handler 入口需要栈处于什么形状，编译时就知道了，写进表里。异常展开到 handler 之前，解释器按这个数把栈弹到指定深度；try body 里不管压了多少中间值（一个没算完的表达式、一次调用的一半参数），统统清掉。表格第五列那个 `lasti` 则服务 `finally` 和 re-raise：为真时，出错指令的偏移会先压栈，`RERAISE` 靠它把异常归位到原始位置。

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

差异在噪声以内，有时有 try 的反而更快。零成本不是修辞，是实测：try body 里的指令流和裸代码完全一致，表只在旁边躺着，不被执行的代码不花钱。

代价去了哪里？出事的时刻。异常真的抛出时，解释器要多走一趟查表、按 depth 清栈。官方文档说这笔成本不大：3.11 同期还把异常在栈上的表示从三个元素（type/value/traceback）简化成一个，捕获路径反而快了约 10%。常态零成本，异常路径还变快了。

## 出事那一刻：展开循环

真出事时执行的是哪段代码？`Python/bytecodes.c` 里有个专门的标签 `exception_unwind`，即帧与求值循环篇讲过的中央循环里异常冒泡的必经出口：

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

拿当前指令偏移问 `get_exception_handler`（实现在 `Python/ceval.h`）。查到，就按 depth 弹栈、按需压 lasti、压异常值、跳到 handler 继续；查不到，本帧栈清空、`goto exit_unwind`。求值循环返回 NULL，异常交给调用者的帧，调用者拿 `CALL` 指令的偏移去查它自己的表。一层层向上，直到有人接住，或者最顶层把 traceback 打印出来。

`get_exception_handler` 的查找本身也值得看一眼：变长 entry 怎么二分？诀窍在编码里，每个 entry 的第一个字节 MSB 必然置位（`assemble.c` 里 `assemble_emit_exception_table_item(a, start, (1<<7))` 那个参数就是干这个的）。于是任意位置往回扫到第一个 MSB 字节，就找到了 entry 边界；entry 本身按 start 升序排列，二分照常进行。小表（40 字节以内，`MAX_LINEAR_SEARCH`）直接线性扫，大表二分到小区间再收尾。紧凑与可查，一个 bit 就兼顾了。

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

三个事件把文档里的流程逐字演了出来：inner 查表落空、帧栈清空、向上冒泡；outer 在 CALL 的偏移上查表命中，跳进 L3 的 `PUSH_EXC_INFO`。顺带一提，实验里有个小坑：回调不能对 PY_UNWIND 返回 DISABLE，这个事件按 PEP 669 的设计不允许工具关闭，调试器依赖它保证语义完整。

展开循环的全路：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 284" role="img" aria-label="异常展开循环：exception_unwind 拿当前指令偏移查表；查到 handler 就按 depth 弹栈、按需压 lasti、压异常值、跳 handler 继续；查不到就清空本帧栈走 exit_unwind，冒泡到调用者帧，调用者拿 CALL 指令的偏移查自己的表，一层层向上" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="excAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">exception_unwind：查表、清栈、冒泡</text>
<rect class="bx-sick" x="20" y="36" width="220" height="32" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="130" y="56" text-anchor="middle" font-size="11" fill="#b03a2e">异常发生 · exception_unwind</text>
<line class="fl" x1="130" y1="68" x2="130" y2="80" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs3)"/>
<rect class="bx" x="20" y="84" width="220" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="130" y="104" text-anchor="middle" font-size="11" fill="#6b675e">get_exception_handler：拿 offset 查表</text>
<line class="fl" x1="240" y1="100" x2="286" y2="100" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs3)"/>
<text class="ts" x="263" y="90" text-anchor="middle" font-size="10" fill="#6b675e">查到</text>
<rect class="bx-q" x="290" y="84" width="200" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="390" y="104" text-anchor="middle" font-size="11" fill="#6b675e">按 depth 弹栈到指定深度</text>
<line class="fl" x1="390" y1="116" x2="390" y2="128" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs3)"/>
<rect class="bx-q" x="290" y="132" width="200" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="390" y="152" text-anchor="middle" font-size="11" fill="#6b675e">按需压 lasti，再压异常值</text>
<line class="fl" x1="390" y1="164" x2="390" y2="176" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs3)"/>
<rect class="bx-q" x="290" y="180" width="200" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="390" y="200" text-anchor="middle" font-size="11" fill="#b03a2e">跳到 handler 继续执行</text>
<line class="fl" x1="130" y1="116" x2="130" y2="140" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs3)"/>
<text class="ts" x="138" y="134" font-size="10" fill="#6b675e">查不到</text>
<rect class="bx" x="20" y="144" width="220" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="130" y="164" text-anchor="middle" font-size="11" fill="#6b675e">清空本帧栈 · exit_unwind</text>
<line class="fl" x1="130" y1="176" x2="130" y2="188" stroke="#6b675e" stroke-width="1.4" marker-end="url(#excAs3)"/>
<rect class="bx" x="20" y="192" width="220" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="130" y="212" text-anchor="middle" font-size="11" fill="#6b675e">冒泡：求值循环返回 NULL</text>
<path class="fl" d="M20 208 L8 208 L8 100 L16 100" fill="none" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#excAs3)"/>
<text class="ts" x="20" y="240" font-size="10" fill="#6b675e">调用者拿 CALL 指令的偏移查自己的表，一层层向上，直到有人接住或顶层打 traceback</text>
<rect class="bx-gone" x="290" y="228" width="350" height="48" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="300" y="246" font-size="10" fill="#6b675e">sys.monitoring 实测：('inner',16) RAISE → PY_UNWIND 查表落空</text>
<text class="ts" x="300" y="262" font-size="10" fill="#6b675e">('outer',12) PY_UNWIND：CALL 命中 → 跳 L3 → 「接住了」</text>
</svg>
</figure>

## 表是怎么生成的：编译器的三步走

回头看编译这一侧。InternalDocs 讲得清楚，中间码里 `SETUP_FINALLY` 伪指令还在（`Python/codegen.c` 里 try 的编译就生成它），到 `Python/assemble.c` 落字节码的阶段才被抽走换算成表：`assemble_exception_table()` 扫一遍指令序列，把连续的、指向同一 handler 的指令合并成一段区间，写成 varint entry。这正是 dis 输出里三条而非六条的原因：相邻同 handler 的区间被合并了。

合并的动作：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="assemble 阶段的区间合并：八条指令按 handler 归属分成三段，连续指向同一 handler 的指令合并成一个 varint entry，所以 dis 输出三条记录而非六条；SETUP_FINALLY 伪指令在这个阶段被抽走换算成表" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">连续、同 handler 的指令合并成一个 entry</text>
<rect class="bx" x="30" y="44" width="68" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="105" y="44" width="68" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="180" y="44" width="68" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="255" y="44" width="68" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="330" y="44" width="68" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="405" y="44" width="68" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-q" x="480" y="44" width="68" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="555" y="44" width="68" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="330" y="38" text-anchor="middle" font-size="10" fill="#6b675e">指令序列（颜色 = handler 归属）</text>
<path class="fl" d="M30 80 L30 88 L248 88 L248 80" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<path class="fl" d="M255 80 L255 88 L473 88 L473 80" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<path class="fl" d="M480 80 L480 88 L623 88 L623 80" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="30" y="96" width="218" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="139" y="114" text-anchor="middle" font-size="10" fill="#6b675e">entry 1：try body → handler</text>
<rect class="bx" x="255" y="96" width="218" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="364" y="114" text-anchor="middle" font-size="10" fill="#6b675e">entry 2：handler 自身 → 外层兜底</text>
<rect class="bx" x="480" y="96" width="143" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="551" y="114" text-anchor="middle" font-size="10" fill="#6b675e">entry 3：兜底块</text>
<text class="ts" x="20" y="152" font-size="12" fill="#6b675e">三条 entry 而非六条：相邻同 handler 的区间被合并；交替 try 的代码合并不了，表会变大</text>
<text class="ts" x="20" y="174" font-size="12" fill="#6b675e">SETUP_FINALLY 只活到编译中间态：落字节码前被抽走，换算成这张表</text>
</svg>
</figure>

合并的痕迹在嵌套 try 里最直观：

```text
ExceptionTable:
  L1 to L2 -> L3 [0]      # 外层 try body → 内层 handler？不——
  L3 to L4 -> L7 [1] lasti
  ...
```

每层 try 的边界、handler 自身的覆盖、finally 的兜底块，各自成段；谁覆盖谁，编译期的控制流分析一次定死，运行期只管查表。这也回应了 JIT 篇搁下的问题，Tier 2 的 trace 为什么难穿异常边：trace 是直线代码，异常边是「任意指令都可能跳去别处」。好在查表的入口只有一个（`exception_unwind`），side exit 之外的异常只需要终止 trace 回 Tier 1，由展开循环接管。

## 前后对一眼

| | 3.10 及以前 | 3.11 起 |
| --- | --- | --- |
| try 的入场费 | 每次进入执行 `SETUP_FINALLY` | 无，body 与裸代码同指令流 |
| handler 登记 | 运行时块栈（block stack） | code object 静态表 `co_exceptiontable` |
| 未覆盖的代码 | 也要付块栈维护成本 | 不进表，零字节 |
| 异常发生时 | 沿块栈找 handler | 查表（线性/二分）+ 按 depth 清栈 |
| 异常的栈表示 | type/value/traceback 三元组 | 单个异常对象 |

在 3.16.0a0 开发版上把同一份 `f` 跑了一遍：表格式没变（varint、MSB 边界、四元组全同），entry 数量多了一条：开发版的行号边界更细，属于实现细节的演化而非格式变更。3.14.7 的 `assemble.c` 与 `ceval.h` 和 3.16 源码逐行对照，编码与查找逻辑一致。

---

## 零成本的另一半

零成本说的是常态，不是异常路径。查表、清栈、跨帧冒泡，出事时每一步都是真实的开销，只是从人人预付改成了由抛异常的代码支付。高频抛异常当控制流用的代码（`StopIteration` 驱动的循环、拿异常做早退）在 3.11 前后的对比里不会体现「零成本」的好处，它们付的是另一头的成本。

表合并有边界：相邻同 handler 才合并，交替 try 的代码异常边界犬牙交错，表会变大，极端情况下每几条指令一段。不过表不执行、只查一次，大表的代价是内存和查找，不是常态开销，方向上仍然划算。

格式是 CPython 的私事：`co_exceptiontable` 的 varint 编码、MSB 约定、depth 位打包，都是内部格式，没有跨实现标准（不像 .pyc 起码有 marshal 的兼容承诺）。本文手工解码是为了看懂；要观测异常流，`sys.monitoring` 才是公共接口。

「finally 也要清栈」的语义没变。表只是把「去哪」从运行时挪到了编译期，到了 handler 之后，栈的收拾（`PUSH_EXC_INFO`、`POP_EXCEPT`、`RERAISE`）还是字节码明着做的。零成本化没有取消任何语义，只是把成本从常态路径挪到了异常路径。

写到这里，「解释器怎么跑」的部分齐了：帧篇是骨架，特化与 JIT 篇是快路径，这篇补上了异常的岔路。这张表其实早就在为别的机制服务：生成器篇的 `StopIteration.value`、asyncio 篇 Future 的 `set_exception`，这些「异常当值传递」的设计落到字节码层，走的都是同一条展开路径。

设计的要点是把 try 的成本从人人预付改成异常路径支付。绝大多数代码一生不抛一次异常，分文不付；真出事的那次，查一张紧凑到十二字节的表，多花的纳秒发生在该发生的地方。
