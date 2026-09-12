---
title: 房客只剩四十位，三十九座楼还不能退：CPython 的 pymalloc 与 RSS
description: 对象已经销毁，进程内存为什么还不下降？本文从只剩四十个实验对象时三十九座 arena 仍未归还的现场出发，沿 block、pool、arena、size class 与分配器调用链一路追下去，分清对象回收、内存复用和 RSS 回落三层各自的边界。实验基于 CPython 3.14.7，并对照 3.16.0a0 开发源码。
pubDate: 2026-09-08
category: cpython
tags: [CPython, 编程语言, 内存管理]
---

十六万个小对象住进三十九座 arena；删到只剩四十个以后，三十九座 arena 仍然一座都没有退。先看这次实验最显眼的一段结果：

```text
                              分配完成      只留 40 个      全部删除
存活的实验对象                  160,000              40              0
当前 arena                           39              39              3
pymalloc 管理的 arena 空间       39 MiB          39 MiB          3 MiB
当前 RSS                         48.34 MiB       47.18 MiB       11.52 MiB
```

绝大多数对象确实已经销毁。`sys._debugmallocstats()` 报告的 allocated blocks 也从约 38 MiB 回到了约 1.43 MiB，几乎就是解释器原有对象加上那四十位幸存者。此时三十九座 arena 仍没有满足整体归还条件；实验随后删除幸存者列表，三十六座 arena 随即被回收，RSS 也从约 47 MiB 降到约 11.5 MiB。

`del` 生效了，垃圾回收器也没有忘记工作。真正需要拆开的，是下面三件事：

```text
对象已经死亡
      ≠
那块空间无法再次使用
      ≠
相应页面已经离开进程 RSS
```

上一篇停在对象生命的终点：名字消失、对象不可达、终结器运行和对象存储释放，并不发生在同一个时刻。这一篇继续往下一层走，进入 `Objects/obmalloc.c`，看看空间交回以后去了哪里，以及一只仍然活着的小对象为什么可能让整座 arena 暂时无法退租。

本文实验在 CPython 3.14.7、x86_64 Linux、默认 GIL 构建、默认内存分配器上完成。源码路径和新版本参数同时对照本地 CPython 3.16.0a0 开发快照。pymalloc 的尺寸、数据结构与回收策略都是 CPython 实现事实，不是 Python 语言承诺；自由线程构建还有另一条重要边界，本文最后会单独说明。

## 哪一层的内存还在

看到进程占用没有下降时，最容易得到一句模糊结论：

> Python 没有释放内存。

这句话缺少主语，也缺少接收者。至少有四层状态需要分别判断：

```text
Python 对象是否仍可达
        ↓
对象占用的 block 是否已经释放
        ↓
pool / arena 是否仍由 pymalloc 持有
        ↓
对应页面是否仍计入操作系统观察到的 RSS
```

它们对应不同的问题：

| 问题 | 更合适的观察方式 |
| --- | --- |
| 对象为什么还活着 | 引用关系、对象计数、`gc`、堆分析器 |
| Python 分配是否已经释放 | `tracemalloc`、类型统计、定制探针 |
| pymalloc 还持有多少 arena | `sys._debugmallocstats()` |
| 进程当前驻留了多少页面 | Linux `/proc/self/status` 的 `VmRSS` 等系统指标 |

任何一项单独拿出来，都不能回答全部问题。

例如 `tracemalloc` 的 current 值已经下降，只能说明它追踪的当前分配大幅减少；它不等于 RSS，也不覆盖所有原生分配。反过来，RSS 没有下降，也不能证明某个 Python 对象仍然存活。页可能仍由 pymalloc 或底层 C 分配器持有，准备服务下一次申请。

最容易误用的指标则是 `resource.getrusage(...).ru_maxrss`。在本次 Linux 环境里，它记录的是进程生命周期中的峰值，与 `/proc/self/status` 的 `VmHWM` 类似。高水位已经发生，就不会因为后来释放内存而降低。要观察当前 RSS，不能把名字里的 `max` 当作装饰。

## 同样是“分配内存”，入口并不只有一个

CPython 的 C API 把内存分成三个 allocator domain：

| Domain | 常见 API | 用途边界 |
| --- | --- | --- |
| RAW | `PyMem_RawMalloc()` / `PyMem_RawFree()` | 最底层原始分配，不要求 attached thread state |
| MEM | `PyMem_Malloc()` / `PyMem_Free()` | Python 运行时内部的一般内存 |
| OBJ | `PyObject_Malloc()` / `PyObject_Free()` | Python 对象存储 |

这些名字描述的是接口域，不是三套永远固定的后端。每个域背后都是可以配置或替换的 allocator 函数表。

在本文使用的传统 GIL、默认 pymalloc 构建中，主路径可以粗略画成：

```text
PyObject_Malloc(size)
        ↓
OBJ domain 当前注册的 malloc
        ↓
_PyObject_Malloc()
        ↓
pymalloc_alloc()
        ├── 小请求且池中有空间：block / pool / arena
        └── 不由 pymalloc 处理：PyMem_RawMalloc()
                                      ↓
                               系统分配器路径
```

`PyMem_Malloc()` 的默认后端也会进入 pymalloc，并不只有名称带 `Object` 的接口才能使用它。普通对象从 `_PyObject_New()`、`PyType_GenericAlloc()` 等入口走到 `PyObject_Malloc()`；受循环 GC 追踪的对象还会为 GC 元数据预留空间，最后同样进入对象分配域。

这里需要保留两个限定：

1. 这是默认构建和默认配置下的路径，`PYTHONMALLOC`、编译选项或嵌入程序安装的 allocator 都能改变后端；
2. “对象很小”只是进入 pymalloc 的必要条件之一，不是所有小型 Python 对象都必定照这条直线走到底，类型自身还可能维护 freelist 或专用缓存。

类型 freelist 与 pymalloc 不是同一层。前者可以直接保留一个已经构造过的对象存储，后者管理更通用的 block；只有上层 freelist 决定放手，相应空间才继续进入 `PyObject_Free()` 与 pymalloc 的释放路径。`sys._debugmallocstats()` 末尾列出的部分 `free PyTupleObjects`、`free PyListObjects` 等统计，也不能与 arena 中的 free block 混为一谈。

所以本文讨论的是一套当前实现如何为大量小分配降低成本的机制，不是一条语言规则。

## 小请求先被归入 size class

本机 CPython 3.14.7 的 `sys._debugmallocstats()` 开头写着：

```text
Small block threshold = 512, in 32 size classes.
```

在这份 64 位构建中，pymalloc 接受的底层小请求上限是 512 字节，并按 16 字节对齐划分成 32 个 size class：

```text
请求 1..16 字节       → 16 字节 block
请求 17..32 字节      → 32 字节 block
请求 33..48 字节      → 48 字节 block
...
请求 497..512 字节    → 512 字节 block
```

当前 3.16.0a0 源码中的换算依然很直接：

```c
size = (nbytes - 1) >> ALIGNMENT_SHIFT;
```

size class 的实际 block 大小则相当于：

```text
(index + 1) × ALIGNMENT
```

对齐换来的是固定规格。分配器不必为每个 233 字节、241 字节或 249 字节请求单独寻找恰好的洞，而是把它们放进对应等级的空闲 block。代价是向上取整产生的内部碎片。

本文实验使用：

```python
payload = b"x" * 200
print(sys.getsizeof(payload))
```

输出为：

```text
233
```

`bytes` 对象除了 200 字节内容，还有对象自身的头部和结尾所需空间。这个 233 字节的整体请求进入 240 字节 size class。实验中的 160,000 个对象，单看 block 就大约需要：

```text
160,000 × 240 bytes ≈ 36.6 MiB
```

这也是为什么“我只生成了约 30.5 MiB 的字符串内容”不能直接推导进程只增加 30.5 MiB。对象头、向上取整、保存对象引用的列表、分配器元数据和观测工具都要占空间。

还应注意，512 是 `pymalloc_alloc()` 收到的底层请求阈值。若启用 debug allocator，外层会在用户请求前后添加检查数据，再把更大的尺寸交给后端；因此不能把“用户申请 512 字节”机械地等同于“必定进入 pymalloc”。

## block 是房间，空下来先留给下一位住客

block 是 pymalloc 最终交给一次小请求的空间。它没有一份始终跟在旁边的独立 C header；当 block 空闲时，开头一个机器字会被复用成链表指针，把空闲 block 串起来。

概念上可以画成：

```text
正在使用：
┌──────────────────────────────┐
│          object data         │
└──────────────────────────────┘

释放以后：
┌──────────────┬───────────────┐
│ next free ───┼──> 下一个空块 │
└──────────────┴───────────────┘
```

对象释放时，`pymalloc_free()` 先判断地址是否属于 pymalloc 管理的范围。若属于，block 被放回所属 pool 的空闲链；若不属于，则交回 RAW 后端对应的释放函数。

这一步已经足以让空间再次服务同 size class 的后续申请：

```text
旧对象死亡
    ↓
block 回到 free list
    ↓
新对象可以复用同一块地址
```

所以 RSS 没有下降，不等于那块空间“泄漏后再也不能使用”。对一个长期运行、分配模式相对稳定的服务来说，保留可复用空间可以减少反复向系统申请和归还的成本。

但是，block 不能独自决定自己是否离开进程。它属于一个更大的 pool。

## pool 是只接待一种尺寸的楼层

一个 pool 在同一时刻服务一个 size class。240 字节 block 和 256 字节 block 不会混住在同一个正在使用的 pool 里。

本机 3.14.7 与当前 3.16.0a0 的默认 64 位配置中，一个 pool 是 16 KiB。这点值得特别注明：很多旧资料仍把 pool 写成固定 4 KiB、恰好等于一个系统页；那不是本文版本与构建上的实际参数。

pool 的开头有一份 `pool_header`，其中保存：

- 当前已分配 block 数；
- 空闲 block 链表头；
- 当前服务的 size class；
- 所属 arena 的索引；
- 下一块尚未切出的 block 偏移；
- 它在相应链表中的前后关系。

扣掉 header 和对齐损耗后，剩余空间按当前 block 大小切分。对 240 字节这一档，一座 16 KiB pool 可以容纳约六十多个 block；实际数量由 `POOL_OVERHEAD` 和当前版本布局共同决定。

pool 没有单独保存一个 `EMPTY`、`USED`、`FULL` 枚举。状态由计数、空闲链和它所在的链表共同表达：

```text
尚未切出
    │
    ▼
部分使用 ◄──────── 满载
    │  ▲             │
    │  │             │ 释放第一个 block
    │  └─────────────┘
    │
    │ 最后一个已分配 block 被释放
    ▼
空 pool
```

状态变化决定下一步：

- 部分使用：挂在对应 size class 的 `usedpools` 中，可以继续分配；
- 满载：没有空闲 block，从 `usedpools` 摘掉，直到第一次释放让它重新可用；
- 空：回到所属 arena 的 `freepools`，以后甚至可以改去服务另一个 size class。

这最后一点很重要。pool 不是终身属于 240 字节档；完全空闲后，它可以被重新初始化，改为切成另一种 block。size class 隔离发生在 pool 正在服务请求的期间，不是给物理内存盖上一枚永久印章。

## arena 是必须整体退还的楼

pool 再往上，才是 arena。

本机默认 64 位构建中，一个 arena 是 1 MiB，理论上容纳 64 个 16 KiB pool：

```text
1 MiB arena
┌────────────────────────────────────────────┐
│ pool 0 │ pool 1 │ pool 2 │ ... │ pool 63 │
└────────────────────────────────────────────┘
        每个 pool 当前只服务一个 size class
```

严格说，arena allocator 返回的首地址若没有满足 pool 对齐，开头可能损失一段空间，因此具体 arena 的 `ntotalpools` 不一定永远等于理论最大值。源码中的 `arena_object` 负责记录实际地址、可用 pool 数、下一个尚未切出的 pool、空 pool 链和前后 arena。

arena 不是等所有 pool 都创建完才开始工作。新的请求可以从高水位位置逐个切出 pool；用过后又完全空闲的 pool 则进入 `freepools`，等待复用。

真正决定 arena 能否归还的核心条件是：

```text
nfreepools == ntotalpools
```

也就是其中所有 pool 都可用。只要任意一个 pool 里还有一个已分配 block，整座 arena 就不能通过 arena allocator 归还。

而且“全空”仍不保证立刻释放。当前源码还要求它不是 `usable_arenas` 中最后保留的那一座全空 arena。pymalloc 会留下一个，以避免下一次小请求刚到又立刻申请新 arena 的抖动。

因此更准确的规则是：

> arena 中所有 pool 都已可用，并且还有另一座可用 arena 可以留下时，这座 arena 才会被交回 arena allocator。

底层 arena 也不一定来自普通 `malloc()`。当前默认实现可以在 Windows 使用 `VirtualAlloc`，在支持匿名映射的平台使用 `mmap`，其他环境再退到 `malloc`。从 pymalloc 的“归还”到操作系统的 RSS 变化之间，仍然可能有平台与系统分配器的差异。

## 分配器故意先把已经很满的楼住满

如果随意挑选 arena，新 pool 很容易平均散落：每座楼都住一点，最后每座楼都无法整体释放。

pymalloc 的 `usable_arenas` 因此按空闲 pool 数量排列，最满但仍可用的 arena 在前。需要新 pool 时，优先从表头取：

```text
arena A：只剩  2 个空 pool  ← 优先继续填
arena B：还剩 18 个空 pool
arena C：还剩 47 个空 pool
```

这是一种主动提高密度的策略。继续把 A 填满，能让 B 和 C 保持较空；等对象释放时，较空的 arena 更有机会整体清空并退还。

它优化的是未来释放整座 arena 的机会，却不能搬动已经存活的对象。pymalloc 不会为了压缩内存，把一个 Python 对象从 arena A 复制到 arena B，再悄悄修改程序里所有指针。C API 和对象地址稳定性让这种通用搬迁不可行。

所以一旦长寿命对象已经散开，分配器只能等它们自己死亡。

## 只剩四十位房客时，三十九座楼仍未退场

现在回到开头的实验。

核心代码如下：

```python
import gc
import sys
import time

COUNT = 160_000
STEP = 4_000
SIZE = 200


def current_rss_mib():
    with open("/proc/self/status", encoding="ascii") as stream:
        for line in stream:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    raise RuntimeError("VmRSS not found")


def report(label):
    print(
        f"=== {label}: RSS={current_rss_mib():.2f} MiB ===",
        file=sys.stderr,
    )
    sys._debugmallocstats()


gc.collect()
report("baseline")

objects = [b"x" * SIZE for _ in range(COUNT)]
report("allocated")

survivors = objects[::STEP]
del objects
gc.collect()
time.sleep(0.05)
report(f"sparse survivors={len(survivors)}")

del survivors
gc.collect()
time.sleep(0.05)
report("all deleted")
```

这里故意避免用字面量重复引用同一个 `bytes` 对象；`SIZE` 是运行时变量，每次乘法都会产生独立对象。实验也在独立进程中运行，防止前一个测试留下的分配器高水位污染结果。

`STEP = 4_000` 不是某条 allocator API 的参数。它只是按照创建顺序稀疏保留对象，让幸存者大致散落到先后申请的多座 arena 中。不同版本、初始堆状态和构建配置下，精确数字都可能变化；实验要展示的是布局效应，不是许诺“每四千个对象必定换一座 arena”。

### 分配以前

```text
# arenas allocated current         =                    2
2 arenas * 1048576 bytes/arena     =            2,097,152
RSS=9.79 MiB
```

解释器自身已经需要小对象，所以基线不是零。

### 分配 160,000 个对象以后

```text
class   size   num pools   blocks in use  avail blocks
   14    240        2355          160088            52

# arenas allocated current         =                   39
39 arenas * 1048576 bytes/arena    =           40,894,464
# bytes in allocated blocks        =           39,893,808
RSS=48.34 MiB
```

240 字节档新增了大量 pool，当前 arena 从 2 增到 39。这里的 `160088` 还包括解释器原来就在使用的同档 block，不能把它机械地当作实验对象的精确计数。

### 只留下四十个对象以后

```text
class   size   num pools   blocks in use  avail blocks
   14    240          41             128          2660

# arenas allocated current         =                   39
39 arenas * 1048576 bytes/arena    =           40,894,464
# bytes in allocated blocks        =            1,500,784
2325 unused pools * 16384 bytes    =           38,092,800
RSS=47.18 MiB
```

这一段最关键。

allocated blocks 已经从约 38.0 MiB 降到约 1.43 MiB，说明绝大部分对象占用的 block 确实释放了。系统同时报告 2,325 个完全没有使用的 pool，共约 36.3 MiB。

可当前 arena 仍是 39。四十个幸存者、保存它们的列表以及解释器原有对象共同存在于此刻的堆布局里，让这些 arena 没能全部满足整体空闲条件。大量 pool 虽然已经空了，却只能在仍被持有的 arena 内等待复用。实验没有把每个对象地址反查到具体 arena，因此这里能直接证明的是“只剩四十个实验对象时，三十九座 arena 仍未归还”，而不是“四十个对象逐一钉住了全部三十九座”。

这正是外部碎片的现场：

```text
arena 1  [活][空][空][空]...
arena 2  [空][空][活][空]...
arena 3  [空][活][空][空]...
...
arena 39 [空][空][空][活]...
```

实际布局当然不是每座恰好一个 block，也不保证幸存者平均分布；这张图只是说明一种能阻止整体归还的布局约束：只要某座 arena 仍有任意在用 pool，它就不能整体归还。原始统计确认稀疏幸存阶段仍有 39 座 arena，却不提供逐座占用图，不能把示意图当作本次运行的地址取证结果。

### 最后四十个对象也离开以后

```text
# arenas allocated total           =                   39
# arenas reclaimed                 =                   36
# arenas allocated current         =                    3
3 arenas * 1048576 bytes/arena     =            3,145,728
RSS=11.52 MiB
```

三十六座 arena 被归还。还剩三座而不是回到最初两座，也不构成泄漏证明：解释器在实验过程中产生了新的长期状态，pymalloc 还会保留可用 arena，系统指标也存在页级噪声。重要的是机制与数量级同时对上了。

## 碎片不是“空闲空间消失了”

前文已经出现了两种不同层面的浪费：请求 233 字节却占用 240 字节 block，是向 size class 取整产生的内部碎片；大量空 pool 因所在 arena 仍未整体空闲而不能归还，则属于这里关注的外部碎片或布局碎片。两者都会增加占用，却发生在不同边界，不能只用一个“碎片率”概括。

从上面的结果看，稀疏幸存阶段有约 36.3 MiB unused pools。这些空间并没有失踪：后续小对象可以再次使用它们。

问题在于，复用有层级约束：

```text
同 size class 的空 block
    可以直接服务同档请求

完全空的 pool
    可以改去服务另一个 size class

完全空且满足保留策略的 arena
    才能整体归还 arena allocator
```

所以“进程没有变瘦”与“程序以后还得重新申请同样多内存”不是一回事。一个负载呈周期性、峰值规模相近的服务，可能从已经保留的 pool 和 arena 中快速满足下一波请求，RSS 平稳反而意味着空间正在复用。

真正需要警惕的是另一种曲线：每轮业务完成后，Python 对象保有量、pymalloc 当前 arena 和 RSS 的基线都持续抬高，并且没有稳定下来。此时既可能是仍有引用，也可能是对象尺寸分布导致的碎片，还可能是 pymalloc 之外的原生分配。不能只凭一条 RSS 曲线给它命名。

## `gc.collect()` 为什么不能把楼退掉

实验中调用了 `gc.collect()`，但它不是让 arena 下降的直接原因。

循环垃圾回收器负责寻找特定的不可达对象图。本文的 `bytes` 没有参与引用环；删除列表引用后，绝大部分对象通过引用计数路径就已经释放。这里调用 `gc.collect()` 主要是建立清晰的观测边界，清理实验周围可能产生的其他不可达容器。

它不会发出下面这样的命令：

```text
把所有 pymalloc 空闲 block 清零
把所有 pool 合并
移动仍存活的对象以压紧 arena
强制 libc 执行 malloc_trim
要求操作系统立刻降低 RSS
```

因此：

```text
对象仍可达
    → gc.collect() 不该回收它

对象已释放但 arena 未全空
    → gc.collect() 无法移动幸存对象

内存已交给 libc 但 libc 暂时保留
    → gc.collect() 也不是 libc 的回收接口
```

把 `gc.collect()` 放进每个请求或每轮任务末尾，通常只是增加扫描成本，不能替代引用调查、分配器分析和进程级隔离。

## 小对象不一定比大对象更难归还

一个流传很广的简化说法是：

> 小对象走 pymalloc，所以不会还给系统；大对象走 malloc，所以会还。

本机实验恰好给出了反例。

三组实验都分配约 31.7 MiB payload，并在独立进程中重复三次。以 CPython 3.14.7 的中位数为例：

| 场景 | 删除后 `tracemalloc` current 增量 | 删除后当前 RSS 增量 |
| --- | ---: | ---: |
| 160,000 个同尺寸小对象 | 约 0.02 MiB | 约 13.23 MiB |
| 160,000 个跨两档小对象 | 约 0.02 MiB | 约 12.77 MiB |
| 8,000 个约 4 KiB 的大对象 | 约 0.02 MiB | 约 32.72 MiB |

小对象场景中，pymalloc 从峰值 41 座 arena 归还了 38 座，当前只剩 3 座。大对象不走这条小块池路径，删除后 `tracemalloc` current 同样回到基线附近，当前 RSS 却暂时几乎没有下降。

在这台机器的 glibc 环境中，显式调用 `malloc_trim(0)` 后，大对象场景的 RSS 才从约 50.3 MiB 回到约 17.3 MiB。这个结果只说明当前 libc、当前分配模式和当前平台的行为；`malloc_trim` 不是 Python 语言接口，更不是可移植的业务清理方案。

这组对比得不出“小对象更好”或“大对象更好”的普遍结论；能得出的是：

> pymalloc 与系统 malloc 都有自己的保留、复用和归还策略；对象尺寸只决定进入哪条路径，不能单独预言 RSS 何时下降。

## `tracemalloc` 和 RSS 讲的不是同一个数字

本次主实验用 `sys._debugmallocstats()` 与 `/proc` 观察布局，没有同时开启 `tracemalloc`。原因是观测工具自己也会占内存。

在另一组相同负载中，开启 `tracemalloc` 后，小对象分配阶段比关闭时多出约 15～16 MiB RSS：

| 场景 | 不启用 `tracemalloc` 的 RSS 增量 | 启用后的 RSS 增量 |
| --- | ---: | ---: |
| 同尺寸小对象 | 约 41.12 MiB | 约 56.81 MiB |
| 跨 size class 小对象 | 约 39.66 MiB | 约 55.35 MiB |
| 大对象 | 约 31.95 MiB | 约 32.60 MiB |

大量小分配需要大量追踪元数据，所以观察效应尤其明显。`tracemalloc` 仍然很有价值，但它回答的是“被追踪的 Python 分配来自哪里、当前和峰值是多少”，不是“进程真实驻留页总共有多少”。

它返回的两个数字也不能混为一谈：

```python
current, peak = tracemalloc.get_traced_memory()
```

- `current` 会随被追踪分配释放而下降；
- `peak` 记录启用追踪以来的历史高点，不会因为对象释放自动回落。

这与当前 RSS、`VmHWM` 和 `ru_maxrss` 的关系可以整理为：

| 指标 | 当前还是峰值 | 主要描述 |
| --- | --- | --- |
| `tracemalloc current` | 当前 | 被 tracemalloc 追踪的当前 Python 分配 |
| `tracemalloc peak` | 峰值 | 追踪开启后的 Python 分配高点 |
| `/proc/.../VmRSS` | 当前 | Linux 当前驻留集 |
| `/proc/.../VmHWM` | 峰值 | Linux 驻留集高水位 |
| `ru_maxrss` | 峰值 | 本平台上的最大 RSS；单位还具有平台差异 |
| `sys._debugmallocstats()` | 当前与累计混合 | pymalloc size class、pool、arena 及部分 freelist 状态 |

排查内存时，第一步是先确认这些数字记的是不是同一件事，然后才轮到比较大小。

## `sys._debugmallocstats()` 也不是稳定诊断协议

这个函数名字带下划线，输出是给 CPython 实现诊断使用的。它在本文的非 debug 构建中可用，但这不意味着所有 Python 实现、所有构建或未来版本都保证相同格式。

阅读时尤其要区分：

```text
# arenas allocated total       累计申请过多少座
# arenas reclaimed             累计归还过多少座
# arenas highwater mark        同时持有数量的历史峰值
# arenas allocated current     当前仍持有多少座
```

前三项是历史或累计指标，最后一项才描述当前 arena 数量。把 `allocated total` 当成当前占用，会得到“明明 reclaimed 了，怎么 arena 还从不减少”的假象。

同理：

```text
# bytes in allocated blocks
# bytes in available blocks
unused pools
```

描述的是 pymalloc 管理范围内的不同状态，不包含完整进程内存。解释器、扩展模块、线程栈、共享库、mmap 文件、JIT 或其他原生库都可能贡献 RSS。

因此它适合回答：

- 哪些 size class 使用了大量 pool；
- 当前 arena、高水位和累计回收是多少；
- 空闲空间主要在 block 还是整个 pool 层；

却不能独自证明：

- 某条业务引用在哪里；
- 所有原生内存是否已经释放；
- RSS 为什么精确多出某个数字；
- 线上进程是否存在业务意义上的泄漏。

## 3.16 开发源码已经不能只背旧参数

本文实验使用的 3.14.7 与当前 3.16.0a0 默认 64 位源码，在核心参数上都表现为：

```text
小请求阈值    512 bytes
对齐           16 bytes
size classes   32
pool           16 KiB
arena          1 MiB
```

这与很多依据旧版本写成的“8 字节对齐、64 档、4 KiB pool”不同。阅读源码文章时，版本是结论的一部分，不是脚注。

当前 3.16 源码还存在更多构建分支：

- 32 位构建使用不同对齐和 pool/arena 参数；
- 关闭 radix tree 会改变默认 pool 尺寸；
- 编译启用 pymalloc hugepage 支持时，arena 的逻辑尺寸可以变成 2 MiB，运行时仍需显式启用且允许回退；
- Emscripten、WASI、Valgrind、debug hooks 和自定义 allocator 都可能改变实际路径。

所以“CPython 的 pool 就是多大”应该写成带条件的句子，而不是刻在所有版本上的常数。

## 自由线程构建走的是另一套路径

更大的版本边界来自 free-threaded CPython。

在当前 3.16.0a0 源码中，`--disable-gil` 构建默认让 RAW、MEM、OBJ 三个 domain 都进入 mimalloc。普通 Python 对象不再以本文这套 pymalloc block/pool/arena 作为主分配路径。

free-threaded 实现还不是简单地“把 pymalloc 换成一个全局 mimalloc”：

- 每个 thread state 初始化自己的 mimalloc heaps；
- MEM、普通对象、GC 对象、带 preheader 的 GC 对象使用不同 heap；
- 线程退出时，仍有存活块的 segment 可以进入解释器级 abandoned pool；
- 对象页还要配合 QSBR，等潜在无锁读者经过静默状态后再安全换用途或回收。

这意味着本文的结论要分两层阅读：

```text
仍然成立的原则：
对象死亡、分配器释放、空间复用、RSS 回落不是同一步。

不能直接套用的细节：
传统 pymalloc 的 size class、pool 状态机和 arena 回收条件。
```

自由线程不是在旧分配器外面加一把细锁；对象存储、线程归属和延迟回收都要重新安排。那适合留给后续独立文章，不应塞进一张传统 pymalloc 结构图里假装没有边界。

## 线上看到 RSS 不降，应该怎样查

一个更可靠的排查顺序是从上到下；别先按 `gc.collect()`：

### 先确认现象是哪条曲线

至少同时记录：

- 当前 RSS，而不是只记高水位；
- Python 层对象数量或目标类型数量；
- `tracemalloc current` 与热点 traceback；
- 若环境允许，pymalloc 当前 arena 与 size class 分布；
- 请求量、缓存规模、线程数和原生库指标。

### 再区分三种常见现场

```text
对象数量持续上涨
    → 优先找引用路径、缓存、任务、traceback、闭包

对象数量回落，arena 基线持续上涨
    → 检查尺寸分布、稀疏长寿命对象和碎片

Python 指标回落，RSS 仍上涨
    → 检查 libc、扩展模块、mmap、线程栈与其他原生分配
```

三者可以同时发生，不要急着选一个单一解释。

### 最后才决定治理边界

对于有明确峰值、任务间数据无需共享的工作，进程边界往往是最确定的释放边界：

- 图片或文档批处理；
- 大型模型的一次性加载与转换；
- 不可信输入解析；
- 偶发但很高的内存峰值任务。

工作进程退出后，操作系统可以回收整个地址空间，不需要等待某个 arena 恰好全空。代价是进程创建、IPC、预热和状态管理，是否值得要由实际负载决定。

相比之下，下面这些做法不应成为默认答案：

- 每个请求后强制全量 GC；
- 把 RSS 平稳一段时间直接命名为泄漏；
- 依赖 Linux/glibc 私有的 `malloc_trim()` 保证业务正确性；
- 为了“清内存”随意清空仍承担业务语义的缓存；
- 只看 `ru_maxrss`，然后等待一个峰值指标下降。

## 一块 block 的归还路径

对象释放只是把 block 交回当前分配器。那块空间通常立刻可以复用，但不保证马上越过 pool、arena、系统 allocator 和操作系统四层边界。

pool 让同规格的小请求集中管理：正在使用时一个 pool 只服务一个 size class，完全空闲后可以换去服务另一档请求。arena 必须整体满足条件才能退还：只要其中还有一个在用 block，哪怕其他几十个 pool 都空了，整座 arena 仍要留下；pymalloc 还会保留最后一座全空可用的 arena，避免反复申请与释放。

碎片描述的是布局，不是对象是否死亡。本机实验只剩四十个实验对象时，三十九座 arena 仍未归还；删除整个幸存者列表后，三十六座随即退场。这个前后对照说明稀疏存活布局可以阻止整体回收。说 pymalloc 永不归还不符合事实：小对象场景里 arena 从峰值 41 座降到了 3 座。大对象也不保证 RSS 立刻下降，绕过 pymalloc 只是进入另一套分配器规则，本机 glibc 在释放大对象后仍暂时保留页面。

指标要按层解释：`tracemalloc current`、`tracemalloc peak`、当前 RSS、高水位和 pymalloc arena 不是同一个数字的不同名字。版本和构建决定结构图是否成立：旧版参数不能机械套到 3.14/3.16，自由线程构建的默认 mimalloc 路径更不能用传统 arena 模型解释。

对象销毁以后，空下来的 block 没有消失。它们先回到 pool，等同规格的新对象；pool 全空以后回到 arena，等重新划分；只有整座 arena 都满足条件，分配器才会把它交给更下一层。这套层级不是为了扣住内存，是在快速复用与及时归还之间做取舍：短命对象聚在一起时，整座 arena 很快能清空；长命对象散开时，空 pool 再多也凑不出一座整体空闲的 arena。进程没有义务因为某个名字被删掉就立刻变瘦，但每一块空间都有明确去向：在用、等待复用，或者已经归还。
