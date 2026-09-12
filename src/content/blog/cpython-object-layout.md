---
title: 一只 Python 对象到底有多重：CPython 的对象头与内存布局
description: 200 字节内容为什么会成为 233 字节对象，又落进 240 字节 block？本文从 PyObject 与 PyVarObject 的公共头部出发，拆开引用计数、类型指针、可变长度、GC 前置元数据、内联数据与间接缓冲区，分清 sys.getsizeof、对象浅尺寸和分配器实际承载各自量的是哪一层。实验基于 CPython 3.14.7，并对照 3.12.13 与 3.16.0a0 开发源码。
pubDate: 2026-09-08
category: cpython
tags: [CPython, 编程语言, 内存管理]
---

```text
业务内容                     200 bytes
sys.getsizeof(value)         233 bytes
pymalloc 实际交出的 block    240 bytes
```

三个数字都是真的。

```python
import sys

value = b"x" * 200
print(len(value))
print(sys.getsizeof(value))
```

本机 CPython 3.14.7 的输出：

```text
200
233
```

上一篇追的是第三个数字：233 字节的小请求进入默认 pymalloc 后，被归入 240 字节 size class，落进一只固定规格的 block。这一篇倒回申请发生以前，看看前两个数字为什么不同，以及那 233 字节里面究竟放了什么。

先留下整篇最重要的边界：

```text
业务内容长度
    ≠
对象报告的浅层尺寸
    ≠
对象图保住的全部内存
    ≠
分配器实际承载的 block
    ≠
进程 RSS 增量
```

`len()`、`sys.getsizeof()`、堆分析器、pymalloc 统计与 RSS 不是五把精度不同的同一把尺。它们站在不同层，测量不同边界。

本文实验以 CPython 3.14.7、x86_64 Linux、64 位、默认 GIL、非 debug、默认 pymalloc 构建为主，并与 CPython 3.12.13 做对照。源码结构同时核对本地一份标记为 CPython 3.16.0a0 的开发快照；该目录没有 Git 元数据，无法绑定到具体提交。文中的对象字段、典型字节数和分配路径属于当前 CPython 版本与构建事实，不是 Python 语言对其他实现许下的内存布局承诺。

## 六种口径的重量

“一只对象占多少内存”听上去只有一个答案，实际至少有六种常见口径：

| 口径 | 回答的问题 |
| --- | --- |
| payload length | 业务内容本身有多少字节或元素 |
| shallow size | 对象本体及其直接拥有的存储报告多大 |
| retained graph | 从这只对象沿引用关系能保住多少对象 |
| allocation request | 类型最终向对象分配域申请多少字节 |
| allocator block | 分配器按规格实际交出多大的块 |
| RSS | 整个进程当前有多少页面驻留内存 |

对 `b"x" * 200` 来说，前两项已经分别是 200 和 233；默认 pymalloc 又把第三层申请承载在 240 字节 block 中。至于 RSS，单独创建一只对象时，页面是否早已驻留、block 是否来自现有 pool、观测代码又分配了什么，都会盖过这几十字节的变化。

所以 `sys.getsizeof()` 的答案不是“错了 33 字节”。它只是在回答另一道题：当前类型愿意为这只对象报告多少浅层尺寸。

要看清这份尺寸，得先从所有 CPython 对象共同遵守的前缀开始。

## 公共前缀：PyObject 的 16 字节

在当前源码中，具体类型常用 `PyObject_HEAD` 把一个 `PyObject ob_base` 嵌到结构体开头。可变长类型则用 `PyObject_VAR_HEAD` 嵌入 `PyVarObject ob_base`。

对于本文的默认 GIL 构建，可以先把 `PyObject` 画成：

```text
典型 64 位默认 GIL 构建

┌────────────────────┬────────────────────┐
│ 引用计数相关状态     │ ob_type            │
│ 8 bytes             │ 8 bytes            │
└────────────────────┴────────────────────┘
                 PyObject：16 bytes
```

`ob_refcnt` 所在区域维护引用计数。上一篇已经追过 `Py_INCREF()`、`Py_DECREF()`、immortal object 与引用归零；这一篇只关心它占据公共前缀的一部分。

`ob_type` 指向对象的类型。解释器拿到一个通用的 `PyObject *` 时，可以沿它找到 `PyTypeObject`，知道这块内存应如何解释、怎样析构、支持哪些操作，以及对象本体至少需要多大。

在本机直接看几个类型公开的尺寸元数据：

```python
for kind in (object, int, bytes, tuple, list, dict):
    print(kind.__name__, kind.__basicsize__, kind.__itemsize__)
```

CPython 3.14.7 下的输出：

```text
object 16 0
int    24 4
bytes  33 1
tuple  32 8
list   40 0
dict   48 0
```

`__basicsize__` 对应类型的 `tp_basicsize`，描述固定主体；`__itemsize__` 对应 `tp_itemsize`，描述每个尾随变长项增加多少字节。但它们也不是对象的全部占用：GC 前置区、managed preheader、inline values、独立缓冲区和 allocator 取整都可能在公式之外。

因此「所有 Python 对象头都是 16 字节」这个说法要收紧：

> 在本文典型 64 位默认 GIL 构建中，普通 `PyObject` 公共前缀是 16 字节；具体对象还要叠加类型自己的字段、可变内容与可能位于对象地址之外的元数据。

等到自由线程构建，这个公共前缀本身也会变样，本文后面再划出边界。

## `ob_type` 还规定尺寸

一块原始内存不会自己知道“我是列表”还是“我是整数”。`ob_type` 把对象接到类型对象上，类型再提供两类与布局直接相关的数据：

```text
tp_basicsize    固定主体至少需要多少字节
tp_itemsize     每个变长项额外增加多少字节
```

对固定大小的 `object` 来说，`tp_itemsize` 是 0。对 tuple 来说，每多一个元素，尾部就多一个 `PyObject *` 槽；本机指针宽度为 8 字节，所以 `tuple.__itemsize__` 是 8。

源码中的基础公式可以粗略写成：

```text
固定对象：tp_basicsize

可变对象：
tp_basicsize + nitems × tp_itemsize
再向 sizeof(void *) 对齐
```

这仍只是结构逻辑尺寸。它没有自动加上 GC 元数据，也不知道某个类型是否另行申请 backing array。

而且类型不只规定布局。`ob_type` 还通向数值运算、属性查找、调用、迭代与析构等类型槽。同一个 `+` 为什么会落到整数加法、字符串拼接或用户自定义方法，入口就藏在这枚指针之后。这个话题属于下一篇的执行机制，此处先停在尺寸上。

## 可变长对象多一个 ob_size

`PyVarObject` 在完整 `PyObject` 后增加一个 `Py_ssize_t ob_size`：

```text
典型 64 位默认 GIL 构建

┌──────────────── PyObject：16 bytes ────────────────┐
│ 引用计数相关状态              │ ob_type             │
└───────────────────────────────┴─────────────────────┘
┌─────────────────────────────────────────────────────┐
│ ob_size：8 bytes                                    │
└─────────────────────────────────────────────────────┘
                 PyVarObject：24 bytes
```

`ob_size` 是元素数量，不是对象占用的字节数。对 list，它表示当前逻辑长度；对 tuple，它表示元素数；对 bytes，它表示内容字节数。类型再结合 `tp_itemsize` 或专用公式算出申请量。

但不要把所有“会变大”的对象都画成这张图。现代 CPython 的 `int` 已经不是普通 `PyVarObject` 布局：它在 `PyObject_HEAD` 后使用 `lv_tag` 编码 digit 数量、正负号和部分标志，再跟着 `digit ob_digit[]`。源码甚至显式禁止对整数使用通用 `Py_SIZE()`。

本机每个 digit 保存 30 个有效二进制位，占 4 字节，因此整数尺寸呈阶梯增长：

```python
import sys

for value in (0, 2**30 - 1, 2**30, 2**60, 10**100):
    print(value.bit_length(), sys.getsizeof(value))
```

```text
0    28
30   28
31   32
61   36
333  72
```

`0` 仍至少为一个 digit 预留逻辑尺寸。越过 30 bit 边界以后，新的 digit 才占进尺寸。这里的 28、32、36 是 `int.__sizeof__()` 按当前内部表示报告的浅层尺寸，与 allocator block 规格无关。

这也说明：`PyVarObject` 是重要的通用协议，却不是所有可变大小内建对象的唯一实现模板。

## 数据可以内联，也可以另行分配

“对象本体”并不意味着所有数据都采用同一种空间关系。几个常见类型恰好代表不同方案：

| 类型 | 主要布局 |
| --- | --- |
| `bytes` | 字节内容紧跟固定字段，内联在同一次对象分配中 |
| `tuple` | 元素引用槽位于对象尾部，长度创建后固定 |
| `list` | 对象主体保存 `ob_item` 指针，元素引用数组另行分配 |
| `dict` | 对象主体与键值表结构分离，还可能共享 keys |
| `str` | 根据 ASCII、字符宽度、compact 状态采用多种布局 |
| 普通实例 | 固定主体之外，还可能有 managed preheader、inline values 或实例字典 |

这两组概念不能混为一谈：

```text
内联 / 间接      描述数据放在哪里
拥有 / 引用      描述这份浅尺寸由谁承担
```

list 的元素数组位于别处，但由 list 直接拥有，所以 list 的 `__sizeof__()` 会把数组容量算进自己的浅尺寸。数组里的每个槽却只是一个 `PyObject *`，所指向的元素对象不会递归计入 list。

tuple 的元素指针直接排在对象尾部，同样只记指针槽，不把元素本体复制进 tuple。bytes 则不同，业务字节本身就在对象分配尾部，因此内容长度会直接推动对象浅尺寸增长。

## 二百字节怎样变成二百三十三

现在可以算清开场那只 `bytes` 的 233 字节了。

当前 `PyBytesObject` 的核心布局可以简化为：

```text
PyVarObject ob_base
Py_hash_t   ob_shash
char        ob_sval[1]
```

在本文 64 位默认 GIL 构建中：

```text
PyObject 公共前缀                  16 bytes
ob_size                             8 bytes
缓存哈希 ob_shash                    8 bytes
结尾 NUL                            1 byte
──────────────────────────────────────────
bytes 固定基线                     33 bytes
业务内容                          200 bytes
──────────────────────────────────────────
sys.getsizeof(value)              233 bytes
```

这个公式里的 1 字节终止 NUL 已经包含在 33 字节基线里，不要在 `33 + len(value)` 之外再加一次。源码用 `offsetof(PyBytesObject, ob_sval) + 1` 定义基础尺寸，长度为 `n` 时再申请基础尺寸加 `n`。

```python
for length in (0, 1, 10, 200):
    value = b"x" * length
    print(length, sys.getsizeof(value))
```

```text
0    33
1    34
10   43
200  233
```

这组线性关系属于当前 CPython `bytes` 布局。它没有说明字符串也按一字节一个字符存放，更不能外推到其他实现。

## 二百三十三怎样落进二百四十

到这里，类型布局算出 233 字节的对象请求。前一篇已经追过后半程：在本文默认 64 位 pymalloc 构建中，小请求按 16 字节 size class 管理，于是 233 向上落进 240 字节 block。

```text
200 bytes   业务内容
    ↓ 加对象公共前缀、长度、哈希与终止 NUL
233 bytes   对象报告的浅尺寸 / 本例逻辑请求
    ↓ pymalloc 按 size class 承载
240 bytes   分配器实际交出的 block 规格
```

最后 7 字节不是新的 Python 字段，也不是 bytes 可以拿来保存更多内容的容量。它是固定规格 block 的余量，属于分配器层的内部碎片。

这 233 字节里还没算 GC 头，因为 bytes 不是循环 GC 管理的类型；也没有独立 backing array，因为数据已经内联。正因为例子足够干净，它适合作为对象布局的第一个样本。

## 字符数相同，字符串也未必一样重

Python 的 `str` 不能照搬 bytes 的公式。CPython 使用灵活字符串表示，根据内容选择 compact ASCII 或不同字符宽度的 compact non-ASCII 布局，某些子类和状态还可能使用非紧凑形式或独立缓存。

本机结果如下：

| 内容 | 字符数 | `sys.getsizeof()` |
| --- | ---: | ---: |
| `"a"` | 1 | 42 |
| `"a" * 10` | 10 | 51 |
| `"中"` | 1 | 60 |
| `"中" * 10` | 10 | 78 |
| `"😀"` | 1 | 64 |
| `"😀" * 10` | 10 | 100 |

ASCII 十个字符只比一个字符多 9 字节；十个中文字符比一个多 18 字节；emoji 这组则多 36 字节。差异反映当前对象所选的 canonical character kind 与固定头部，不等于这些文本编码成 UTF-8 后的长度。

因此“Python 字符串一个字符占几字节”缺少至少两项条件：哪一种内部表示，以及在称字符数据还是整个对象。字符串驻留、子类化、UTF-8 cache 和版本变化还会继续改变这些数字。

## list 的长度不是它的容量

list 展示了另一种布局：对象主体固定保存长度、`ob_item` 指针和 `allocated` 容量，真正的元素引用数组位于独立分配中。

```text
PyListObject
┌──────────────────────────────────┐
│ PyVarObject：ob_size = 当前长度   │
│ ob_item ───────────────────────┐ │
│ allocated = 当前容量            │ │
└─────────────────────────────────┼─┘
                                  ▼
                     ┌────┬────┬────┬────┐
                     │ *  │ *  │ *  │空槽│
                     └────┴────┴────┴────┘
                       指向元素对象的引用
```

`list.__sizeof__()` 使用的是容量，不是 `len(list)`：

```text
tp_basicsize + allocated × sizeof(PyObject *)
```

`sys.getsizeof()` 再为当前类型加上相应的前置元数据。连续 append 时，本机看到：

| 当前长度 | `sys.getsizeof()` | 由 8 字节指针推断的容量 |
| ---: | ---: | ---: |
| 0 | 56 | 0 |
| 1 | 88 | 4 |
| 5 | 120 | 8 |
| 9 | 184 | 16 |
| 17 | 248 | 24 |
| 25 | 312 | 32 |
| 33 | 376 | 40 |
| 41 | 472 | 52 |
| 53 | 568 | 64 |

第一次 append 后，长度是 1，容量却是 4；长度 41 时，容量已经是 52。这份余量避免每次 append 都重新申请和复制数组。

构造历史也会留在尺寸里：

```python
import sys

items = [None] * 3
print(len(items), sys.getsizeof(items))

items.append(None)
print(len(items), sys.getsizeof(items))

items.pop()
print(len(items), sys.getsizeof(items))

items.clear()
print(len(items), sys.getsizeof(items))
```

```text
3 80
4 120
3 120
0 56
```

同样是长度 3，刚由重复构造得到时为 80 字节，从长度 4 `pop()` 回来却仍是 120 字节。逻辑内容已经相同，预留容量不同。

这些台阶是 CPython 3.14.7 与 3.12.13 本次构建的实测行为，不是 list 的稳定 ABI。以后扩容公式改变，同一长度的数字也可能改变。

## 一千个槽位，不是一千份整数

容器浅尺寸最大的误解，是把引用槽和被引用对象看成同一份东西。

```python
import sys

value = 10**100
items = [value] * 1000

print("list shallow:", sys.getsizeof(items))
print("one element:", sys.getsizeof(value))
print(
    "naive repeated sum:",
    sys.getsizeof(items) + sum(sys.getsizeof(item) for item in items),
)
```

```text
list shallow: 8056
one element: 72
naive repeated sum: 80056
```

本机这只 list 可以拆成：

```text
56 bytes list 空壳与 GC 前置开销
1000 × 8 bytes 引用槽
────────────────────────
8056 bytes list 浅尺寸
```

一千个槽都指向同一个 `value`：

```text
items[0] ───┐
items[1] ───┤
items[2] ───┼──> 同一只 72 字节大整数
...         │
items[999] ─┘
```

朴素求和把同一只整数算了 1000 次。若这张小图只包含 list 和共享整数两个对象，按身份去重后是：

```text
8056 + 72 = 8128 bytes
```

但连“8128 就是实际独占内存”也要加边界。大整数可能同时被别处引用；list 的 block 还会被 allocator 向上取整；类型对象、分配器元数据和进程页面又不在这张小图里。

所谓“整个对象占多少”，不是对象自身携带的天然数字，而是一项必须先定义归属边界的测量。深度统计至少要处理对象身份去重、引用环、共享单例、interned 对象和扩展类型没有通过普通引用图暴露的原生缓冲区。

## tuple 的八字节，隔着一个版本就变了

tuple 与 list 都保存元素引用，却采用不同空间策略。tuple 长度创建后固定，元素指针直接跟在对象尾部；list 则拥有一只可更换、可扩容的独立数组。

相同代码在两个版本上的结果是：

```python
import sys

print([(n, sys.getsizeof((None,) * n)) for n in range(5)])
```

```text
CPython 3.12.13
[(0, 40), (1, 48), (2, 56), (3, 64), (4, 72)]

CPython 3.14.7
[(0, 48), (1, 56), (2, 64), (3, 72), (4, 80)]
```

两版每增加一个元素都多 8 字节引用槽，但 3.14 整体多出 8 字节。源码给出了原因：3.14 开发周期为 tuple 增加了 `Py_hash_t ob_hash`，缓存计算后的哈希值。当前 3.16.0a0 快照中该字段仍然存在。

于是“空 tuple 在 64 位 CPython 上就是 40 字节”只对特定版本成立。指针宽度没变，GIL 模式没变，类型布局的一次演进便足以让答案整体平移。

这也是为什么扩展模块不应把 CPython 私有结构偏移当作跨版本承诺。Public C API、Limited API 与 Stable ABI 各有边界；直接读取当前内部字段，换版本后就要重新核对。

## `__slots__` 省掉的不是对象头

普通 Python 类的实例又多一层复杂性。当前实现通常会为实例安排 managed dict、managed weakref 与 inline values；同类实例可以共享属性键布局，每个实例保存自己的值。访问 `instance.__dict__` 时，真实字典还可能按需物化。

对比两个类：

```python
class Plain:
    pass

class Slotted:
    __slots__ = ("a", "b")
```

`__slots__` 不会删掉 `PyObject` 公共前缀，也不是让属性“不占内存”。每个普通 slot 通常在实例主体中增加一个 `PyObject *` 字段，只是它不再需要一套通用实例字典来保存这两个名字。

本机创建并赋值后：

```text
Plain 实例的 sys.getsizeof()           48
Plain 实例 __dict__ 的 getsizeof()      296
Slotted 实例的 sys.getsizeof()          48
带两个 slot 和 __weakref__ 的实例       64
```

这里的 48 仍不是普通实例底层整次分配的完整尺寸。当前 `object.__sizeof__()` 报告 `tp_basicsize`，`sys.getsizeof()` 再加 preheader；但 `PyType_GenericAlloc()` 为类型追加的 inline-values 区域没有进入这个返回值。也就是说，即使一段存储由对象直接拥有、并与主体在同一次分配中取得，也不保证全部反映在 `sys.getsizeof()` 里。

这里最危险的做法，是把 `48 + 296` 当作“每个 Plain 永远 344 字节”，再乘实例数。

在一组专门记录前后状态的独立进程实验中，首个实例的 `__dict__` 起初报告 296 字节；继续创建同类实例并访问各自 `__dict__` 后，新实例的报告值依次从 288、280、272……下降，从第二十六个起稳定在 88 字节，最早那只实例的字典随后也报告 88 字节。这与类共享 keys、实例独立 values 和布局逐步稳定相符；单个 `__dict__` 的报告值不是可以无条件复制到整个实例群的常量。

批量实验更能说明问题。在固定脚本中分别创建 100,000 个拥有 `a`、`b` 属性的实例，`tracemalloc current` 相对基线增加：

| 版本 | 普通实例组 | slots 实例组 | 差值 |
| --- | ---: | ---: | ---: |
| CPython 3.12.13 | 约 31.28 MiB | 约 5.34 MiB | 约 25.94 MiB |
| CPython 3.14.7 | 约 25.18 MiB | 约 5.34 MiB | 约 19.84 MiB |

两个版本各运行五次，结果一致。它支持的结论是：在这段固定构造流程里，slots 组产生的 Python 跟踪分配显著更少。

它不能证明 `__slots__` 在所有继承结构里都节省同样多，不能证明一定更快，也不能把差值简单除以十万后宣布每个实例的“真实重量”。类对象、共享 keys、分配器取整和 `tracemalloc` 自己的记账都存在共享或观测边界。

## GC 头可能藏在对象地址之前

第一篇已经解释过：循环 GC 只需管理可能参与引用环的对象。内存布局上，这并不表现为每只对象公共头里都有一个通用 `gc_tracked` 字段。

在本文默认 GIL 构建中，GC-capable 类型的底层分配前面会预留 `PyGC_Head`。当前它由两个 `uintptr_t` 组成，典型 64 位为 16 字节：

```text
底层分配起点
      │
      ▼
┌────────────────────────────────┐
│ PyGC_Head：next / prev          │  16 bytes
├────────────────────────────────┤
│ PyObject / 具体类型主体          │  ← Python 对象指针指向这里
└────────────────────────────────┘
```

所以对象指针不一定指向整次底层申请的起点。`_Py_AS_GC(op)` 会从对象地址向前找到 GC 头，`_Py_FROM_GC(gc)` 则反向换算回来。

还有另一种不能混写的前置区。当前普通 heap instance 可使用 managed dict 与 managed weakref；只要类型启用相应 preheader 标志，当前实现会在对象前再预留两个指针槽。在典型默认 GIL 构建中，布局可以概念化为：

```text
[weakref ptr][dict ptr][PyGC_Head.next][PyGC_Head.prev][PyObject ...]
```

managed preheader 与 `PyGC_Head` 是两件事，不能都简称为“GC 头”。`_PyType_PreHeaderSize()` 在当前默认构建里把二者分别计入前置尺寸。

`gc.is_tracked()` 则描述当前对象是否正在 GC 追踪集合中，不是测量头部的 API。tuple 可能因只含原子对象而被取消追踪；不同版本的 dict 追踪策略也会变化。是否当前 tracked，不意味着默认 GIL 构建可以临时把分配在对象前的存储拆掉。

## `sys.getsizeof()` 先问对象自己

当前源码中的调用链不是一条“读取 malloc 元数据”的路径：

```text
sys.getsizeof(obj)
    ↓
sys_getsizeof()
    ↓
_PySys_GetSizeOf(obj)
    ↓
查找并调用 obj.__sizeof__()
    ↓
检查结果是否为非负整数
    ↓
按当前类型加上 preheader 尺寸
```

也就是说，`sys.getsizeof()` 首先是一项类型协议。list 的 `__sizeof__()` 知道要把 `allocated` 引用槽算进去；int 有自己的 digit 公式；str 根据实际表示分支；第三方扩展类型也要自己报告内部或外部存储。

自定义类型甚至可以直接证明它不是 allocator 的测量仪：

```python
import sys

class Reported:
    def __sizeof__(self):
        return 123

obj = Reported()
print(obj.__sizeof__())
print(sys.getsizeof(obj))
```

本文环境输出：

```text
123
155
```

额外的 32 字节来自当前普通实例类型的 preheader 开销。`sys.getsizeof()` 信任类型给出的 123，并没有去 allocator 验证“真实 block 是否正好这么大”。

空 list 则是：

```python
items = []
print(items.__sizeof__())
print(sys.getsizeof(items))
```

```text
40
56
```

差出的 16 字节对应当前默认 GIL 构建中 list 的 GC preheader。这个差值不能写成跨构建定律：自由线程构建不为普通 GC 对象使用逐对象 `PyGC_Head`，managed 类型又有自己的前置区。

提供 `default` 后，只要尺寸获取最终以 `TypeError` 失败，当前实现就会返回该默认值；这既包括类型没有可用的 `__sizeof__`，也包括 `__sizeof__()` 自己抛出 `TypeError`。`ValueError` 等其他异常仍会传播，默认值不是吞掉所有失败的万能兜底。

因此 `getsizeof()` 适合比较同一环境下对象报告的浅层结构，适合验证 list 容量、整数 digit 和字符串表示；它不适合独自回答整张对象图、分配器碎片、扩展库原生缓冲区或 RSS。

## freelist 还在更上面留了一只旧壳

对象析构后，存储也不一定立刻走到 `PyObject_Free()`。一些内建类型维护 freelist，缓存已经释放、以后可供同型对象复用的对象壳。

当前 3.16.0a0 快照中的统一 freelist 状态包括 list、按尺寸分桶的 tuple、compact int、dict、float 和多种运行时对象。默认 GIL 构建按 interpreter 保存，free-threaded 构建则按 thread 保存。

概念上，释放路径可能是：

```text
对象不再存活
    ↓
类型 freelist 还有位置？
    ├── 是：保存对象壳，等待同型对象复用
    └── 否：继续交给 PyObject_Free() / 当前分配器
```

freelist 不是 Python 可见容器，缓存中的旧壳也不是仍然活着的 Python 对象。它只是在类型层比 pymalloc 更早截住一次复用机会。

这进一步说明对象的“重量”不能只看一张静态结构图。活着时，类型决定哪些区域属于它；死亡后，类型 freelist、对象 allocator 与系统 allocator 又分别决定空间走到哪一层。本文只标出这条边界，不重新展开上一篇的 RSS 回收路径。

## 自由线程改写了公共头

到目前为止，正文数字都来自默认 GIL 构建。把 `--disable-gil` 的 free-threaded CPython 也画成两个指针、16 字节公共头，会直接写错。

当前 3.16.0a0 快照在 `Py_GIL_DISABLED` 下的 `PyObject` 还包含：

- owner thread id；
- 对象标志与每对象 mutex；
- GC bits；
- local reference count；
- shared reference count；
- 类型指针。

按典型 64 位 C 对齐计算，`PyObject` 为 32 字节，`PyVarObject` 为 40 字节。引用计数不再是一只普通共享整数，而拆成 local/shared 状态，为 biased reference counting 与跨线程合并服务。

free-threaded GC 也不在每只普通 GC 对象前放置传统 `PyGC_Head`。它依靠 mimalloc heap 扫描发现对象，把追踪与终结等状态放进对象头的 GC bits，并在收集阶段复用其他字段。managed dict/weakref 的两个指针 preheader 仍然存在，只是不再需要跨过 `PyGC_Head`。

于是有一个看似反常的对比：

```text
默认 GIL：对象公共头较小，GC 对象前另有 PyGC_Head
free-threaded：对象公共头更大，普通 GC 对象不再有逐对象 PyGC_Head
```

不能只比较一处 16 与 32，就宣布某构建里的所有对象总分配必然多出固定比例。具体类型、managed preheader、inline values、mimalloc 元数据和分配器规格还会继续参与。

稳定的原则只有这一层：对象必须携带足够的运行时身份与生命周期状态；具体字段放在哪里、占多少字节，会随着并发模型、版本和构建改变。

## 尺寸数字不是 Stable ABI

本文已经遇到数次版本与构建边界：

- tuple 在 3.14 增加 hash cache，同样元素数比 3.12 多 8 字节；
- free-threaded 的 `PyObject` 物理头与默认 GIL 构建不同；
- free-threaded 不再给普通 GC 对象分配 `PyGC_Head`；
- 普通实例的 inline values、shared keys 与 materialized dict 会随版本继续演进；
- 32 位、debug、trace refs 和自定义 allocator 都可能改变数字。

所以这类文章最可靠的写法是公式优先，字节数附带环境。扩展模块若需要跨版本兼容，应依赖对应层级的公开 C API、Limited API 或 Stable ABI，而不是直接假定负偏移、私有头部和内部结构字段永远不变。

即便是本地 3.16.0a0 源码，也只能说明这个开发快照当前怎样实现。它没有 Git 提交信息，正式发布前还可能继续变化。

## 分层的答案

对象头是运行时协议，不属于业务内容。在本文默认 64 位 GIL 构建中，`PyObject` 的引用计数状态和类型指针占 16 字节，具体类型还会继续叠加自己的字段。`ob_type` 决定一块内存应怎样解释：`tp_basicsize`、`tp_itemsize` 与类型专用分配逻辑共同算出结构尺寸，同一枚类型指针还通向操作和析构槽。可变长对象也不统一使用 `ob_size`：tuple、list、bytes 走 `PyVarObject` 协议，现代 int 把 digit 数和符号编码在 `lv_tag` 里，使用专门公式。

数据可以内联，也可以间接拥有。bytes 把内容放在对象尾部，tuple 尾随元素指针，list 拥有独立的引用数组；空间位置与归属是两件事。一千个引用槽可以全部指向同一只对象，深度统计必须先定义边界，再按身份去重，处理环与共享状态。`__slots__` 省掉的是通用属性存储，不是对象头：普通 slot 仍占一个指针字段，继承、weakref 与类布局都会改变结果。

测量工具各管一层。`sys.getsizeof()` 是不完整的浅层协议：先调用类型的 `__sizeof__()`，再加入当前类型 preheader；不会自动递归引用图，不保证覆盖 inline values，更不会读取 allocator block 或 RSS。GC preheader 与 managed preheader 不是同一块：默认 GIL 构建中的 `PyGC_Head` 管理 GC 链表，managed dict/weakref 另有两个前置指针槽。类型 freelist、pymalloc 与 RSS 也位于不同层：旧对象壳可能先被类型缓存，block 可能再被分配器复用，进程页面则是更下一层的事。

具体字节数必须带上版本和构建。tuple 的 8 字节变化和 free-threaded 的大对象头已经说明，内部布局不是永恒 ABI。

回到开头的三个数字：200、233、240 都准确，只是没有在称同一件东西，内容长度、对象浅尺寸、分配器 block 规格各是一层。上一篇站在分配器一层，看 233 字节怎样落进 240 字节 block；这一篇回到对象内部，拆开公共头、可变长度、尾随数据与另行分配的引用数组。下一篇沿着 `ob_type` 继续：一块已经排好字节的内存，怎样通过类型槽获得自己的行为，同一个加号该走整数运算还是字符串拼接，属性读取又该按什么顺序查找。
