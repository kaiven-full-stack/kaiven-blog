---
title: 哈希不直接决定位置，索引表才说了算：CPython 的 dict 内部结构
description: 同样三条数据，str 键字典 184 字节、int 键字典 224 字节；删掉五个键中的四个，尺寸纹丝不动。本文从索引表与条目表的分层出发，拆开探测递推、tombstone、扩容公式、三种键形态与共享键配额，讲清插入序、哈希分布与版本号失效各自从哪里来。实测基于 CPython 3.14.7，结构同时核对 3.12.13 与 3.16.0a0 开发源码。
pubDate: 2026-09-09T22:30:00+08:00
category: cpython
tags: [CPython, 编程语言, 数据结构]
---

```text
{str 键 × 3}   getsizeof = 184 bytes
{int 键 × 3}   getsizeof = 224 bytes
删到只剩 1 键   getsizeof = 184 bytes，纹丝不动
```

这三行输出来自 CPython 3.14.7：

```python
import sys

d = {"a": 1, "b": 2, "c": 3}
print(len(d), sys.getsizeof(d))

n = {1: "x", 2: "y", 3: "z"}
print(len(n), sys.getsizeof(n))

for k in list(d)[:2]:
    del d[k]
print(len(d), sys.getsizeof(d))
```

```text
3 184
3 224
1 184
```

三条数据的键数完全相同，尺寸却差 40 字节；删掉三分之二的内容，尺寸一动不动。要解释这三件事，得先回答一个更根本的问题：哈希值算出来之后，键到底放在哪里。

先把全文最重要的分层画出来：

```text
PyDictObject（外壳）
    │
    ├─ ma_used            当前条目数
    ├─ ma_keys ──────────► PyDictKeysObject（键表）
    │                        ├─ dk_indices[]   真正的哈希表：槽位 → 条目下标
    │                        └─ dk_entries[]   条目数组：按插入序追加
    │
    └─ ma_values          split 表才有：值数组（键留在共享键表里）
```

哈希表不在条目数组里，条目数组也不按哈希序排列。`dk_indices` 是哈希表，它存的不是键，是下标；`dk_entries` 是一个几乎只追加的数组，插入序就是它天生的顺序。dict 的大部分行为，迭代有序、删除不缩表、共享键、版本号失效，都是这张分层的推论。

实验以 CPython 3.14.7 默认 GIL 构建为主（x86_64 Linux，64 位，非 debug），对照 3.12.13。源码结构另核对本地一份 CPython 3.16.0a0 开发快照；该目录没有 Git 元数据，无法绑定到具体提交。文中结构、常量与公式都是这两个版本的实现事实，不是 Python 语言的承诺。

## 外壳：48 字节里放了什么

`PyDictObject` 在 64 位默认 GIL 构建下的主体是：

```text
PyObject 公共前缀          16 bytes
ma_used（条目数）           8 bytes
_ma_watcher_tag（监控位）   8 bytes
ma_keys（键表指针）         8 bytes
ma_values（split 表值指针）  8 bytes
────────────────────────────────────
dict.__basicsize__         48 bytes
```

`sys.getsizeof({})` 报告 64：48 的主体加 16 字节 GC 前置头，对象布局篇已经拆过这个构成。注意 `ma_values`：普通字典它是 NULL，键和值一起存在键表的条目里；实例 `__dict__` 却大量使用另一形态，键表共享、值单独存放，这正是后半篇的主角。

`ma_keys` 指向的键表才是字典的心脏。

## 键表：索引表加条目数组

`PyDictKeysObject` 把“哈希定位”和“存储条目”拆成两块：

```text
PyDictKeysObject
┌────────────────────────────────┐
│ dk_refcnt   引用计数（可共享）   │
│ dk_log2_size        槽数 = 2^n │
│ dk_log2_index_bytes 索引宽度    │
│ dk_kind     键形态（见后文）    │
│ dk_version  键集合版本号        │
│ dk_usable   剩余可用条目        │
│ dk_nentries 已用条目数          │
├────────────────────────────────┤
│ dk_indices[dk_size]  哈希槽位数组 │
├────────────────────────────────┤
│ dk_entries[USABLE_FRACTION]     │
│   条目数组，按插入序追加          │
└────────────────────────────────┘
```

`dk_indices` 每个槽存的是 `-1`（空）、`-2`（墓碑）或一个非负下标，指向 `dk_entries` 里的条目。槽位宽度随表大小增长：8～128 槽用 1 字节，之后依次 2、4、8 字节。所以表越大，索引表本身相对越省：槽位宽度是按需选择的，不是一律 8 字节。

条目有两种规格。全是精确 str 键的表用 16 字节的 `PyDictUnicodeEntry`：

```text
PyDictUnicodeEntry          PyDictKeyEntry（通用）
┌────────────┬──────────┐   ┌────────┬────────┬──────────┐
│ me_key     │ me_value │   │ me_hash│ me_key │ me_value │
│ 8 bytes    │ 8 bytes  │   │ 8      │ 8      │ 8        │
└────────────┴──────────┘   └────────┴────────┴──────────┘
```

通用条目多出的 `me_hash` 缓存非 str 键的哈希值；str 自带哈希缓存（下一篇的主角），不必重复存。这就解释了开场第二行：同样三条数据，int 键表用 24 字节条目、str 键表用 16 字节条目，224 对 184 的差距 40 = 5 个条目容量槽 × 8 字节的单条差。两种表的 8 槽都提供 5 条容量，差的是每条规格。

用公式完整验算一遍（默认 GIL 构建中键表头是 32 字节：引用计数 8 + 三个单字节布局位 + 4 字节版本号 + 两个 8 字节计数）：

```text
表大小 8、全 str 键时：
sizeof(PyDictKeysObject)          32
dk_indices 8 槽 × 1 byte           8
条目容量 5 × 16 bytes             80
────────────────────────────────────
键表合计                         120
+ PyDictObject 外壳 48 + GC 头 16
────────────────────────────────────
sys.getsizeof({'a':1})           184 ✓
```

而空 dict 只剩外壳：64 字节。`PyDict_New()` 交出的是一张全局共享的空键表，并不新建；首次插入才分配真正的键表。`dict.clear()` 也会把字典换回这张空键表，这就是为什么删空之后 `getsizeof` 会从 184 回到 64。

## 插入序不是附加功能，是分层的副产品

从 3.7 起 dict 保证插入序。实现上没有维护什么插入链表：条目数组本来就按插入序追加，迭代只是从下标 0 走到 `dk_nentries`，跳过值为空的条目。顺序是存储布局的天然结果。

删除呢？条目数组原则上只追加不搬家，删除只做两件事：条目的 `me_key`、`me_value` 置 NULL，索引表对应槽位写 `-2`（DKIX_DUMMY，墓碑）。

```text
删除前：dk_entries = [a][b][c][d][e]   dk_indices: 槽6 → 条目b
删除 b：dk_entries = [a][ ][c][d][e]   dk_indices: 槽6 → DUMMY(-2)
```

墓碑保留在探测链上，这条链才不断（下一节细说）。但条目数组里留下了一个洞：`dk_nentries` 不减，`dk_usable` 也不回收。重插同一个键不会填洞，而是在尾部追加新条目、覆盖墓碑槽位：

```python
d = {"a": 1, "b": 2, "c": 3}
print(list(d))          # ['a', 'b', 'c']
del d["a"]
d["a"] = 10
print(list(d))          # ['b', 'c', 'a']
```

`a` 挪到了队尾。`dict.popitem()` 是唯一从尾部摘除条目、递减 `dk_nentries` 的操作，摊还 O(1)。

由此可以精确回答“删一半会不会变瘦”：删除永不缩表。表大小只在插入路径上改变。开场第三行的 184 纹丝不动，就是这条规则最直接的例证。

## 扩容：三分之二这条线

条目数组的容量是槽位数的三分之二，不是槽位数本身：

```c
#define USABLE_FRACTION(n) (((n) << 1)/3)
#define GROWTH_RATE(d)     ((d)->ma_used*3)
```

表大小 8 时可放 5 条、16 槽放 10 条、32 槽放 21 条。向满表再插一个新键时，`GROWTH_RATE` 按 `ma_used` 的 3 倍申请新表：没有删除历史时恰好翻倍（3×used 取 log2 向上取整，used 接近 2/3×size 时新表正好是 2×size），删除越多余量越大。

本机实测的尺寸阶梯（str 键、逐个插入）：

```text
n        0     1..5   6..10  11..21  22..42  43..85  86..170  171..
getsizeof 64     184     272     464     832    1584     3328   6576
表大小          8      16      32      64     128      256     512
条目容量         5     10      21      42      85      170     341
```

每一级台阶都精确落在 2/3 线上，公式可整体验算：外壳 48 + GC 头 16 + 键表头 32 + 索引表 + 条目容量 × 16。86..170 那一级是 256 槽表，索引已升到 2 字节宽：48 + 16 + 32 + 512 + 170×16 = 3328。逆推也成立：`dict.fromkeys(range(n))` 与字面量构建都会按 `estimate_log2_keysize` 预留，一次到位不扩容。

删除后再插入是更微妙的一课：

```text
len=5 时 getsizeof = 184（表 8 已满）
del 一个键          184（条目成洞，容量不回收）
插入一个新键        272（usable 已耗尽，触发扩容）
```

满表删一插一，`ma_used` 没有净增，表却从 8 槽涨到 16 槽。因为 `dk_usable` 只数条目数组里未用过的槽位，墓碑占住的洞不能复用。dict 不做原地压实，要压实就得换新表，扩容正好顺路完成这件事。

## 探测：那条著名的递推式

槽位冲突之后走哪条路？CPython 用开放定址，不是链地址。源码注释指明算法基于 Knuth Vol. 3 算法 D 的变体：

```c
perturb >>= PERTURB_SHIFT;              /* PERTURB_SHIFT = 5 */
i = (i*5 + perturb + 1) & mask;
```

初始槽位是 `hash & mask`；此后每一步，旧槽位乘 5、加上不断右移的 perturb、再加 1。右移让哈希的全部位最终都参与进来，`+1` 保证即使哈希退化为 0 序列也不断链。源码注释特意提醒：Python 的 `hash(i) == i`（小整数）高度规律，`i*5+1` 的扰动正是为了让连续整数键不会在表里连成一片。

这套递推可以真的看到。做一个所有键 `hash` 都是 1 的实验：五只自定义对象，`__eq__` 里做记录：

```python
class K:
    def __init__(self, name): self.name = name
    def __hash__(self): return 1
    def __eq__(self, other): CALLS.append(self.name); return self.name == other.name
```

hash 相同，五只键在 8 槽表里只能各占一槽。按递推式手算（mask=7，perturb 初值 1，一次右移后恒 0）：槽序是 1 → 6 → 7 → 4 → 5。实际查找 `K("d")` 时，`__eq__` 依次见到 a、b、c、d，探测链 1, 6, 7, 4 上的每只键都确实被比对过。

墓碑的作用在这一刻显形。删掉链中段的 b 再查 d：`__eq__` 见到 a、c、d，链上少了 b 那一环，但槽 6 的 DUMMY 让探测继续走到 4。更极端的实验：删掉链上除 e 以外的全部四只键，再查 e，一次 `__eq__` 就命中。

如果把墓碑当空位抹掉会怎样？查 e 的探测在槽 1 就遇到「空」，按开放定址的约定空位即止步，查找会误报 KeyError。墓碑必须在，探测链的历史才成立。代价是删除留下的洞不能复用，这正是上一节「删一插一触发扩容」的根源。

顺带一提哈希分布。`hash('雨')` 每次进程都不同：str 哈希默认带随机种子（`PYTHONHASHSEED`），而 `hash(42) == 42` 是写死的规则。开地址表最怕群体碰撞，随机化就是给 str 键准备的，它也是 3.3 时代那场「哈希碰撞 DoS」的回应。

## 键形态：一张表的身份由首键决定

键表有三种身份（`dk_kind`）：

```text
DICT_KEYS_UNICODE   全部精确 str 键，条目 16 字节，无 me_hash
DICT_KEYS_GENERAL   任意键，条目 24 字节，带 me_hash
DICT_KEYS_SPLIT     共享键表（实例 __dict__ 专用），见下节
```

新建空 dict 的键表是 UNICODE 形态。第一条 str 键插进来，维持 UNICODE；第一条非精确 str 键插进来，`insert_combined_dict` 发现形态不符，当场整表转 GENERAL：分配新键表、搬运全部旧条目、重建索引。

```python
class S(str): pass          # str 子类不是 exact str

d = {"a": 1, "b": 2, "c": 3}
print(sys.getsizeof(d))     # 184：8 槽 UNICODE 表
d[S("sub")] = 4
print(sys.getsizeof(d))     # 352：已转 GENERAL，16 槽表
```

352 可以完整验算：外壳 48 + GC 头 16 + 键表头 32 + 索引 16 + 10 条 × 24 = 352。转换发生在插入路径上：`insert_combined_dict` 发现 UNICODE 表容不下非精确 str 键，按 `GROWTH_RATE(3×3=9)` 申请 16 槽的 GENERAL 新表、搬运三条旧条目、重建索引，新键落进新条目数组。转换不可逆：此后再插满 str 键，表也回不去 UNICODE。`PyDict_New` 交出的空表按 UNICODE 起步，依据的是「绝大多数 dict 的键都是 str」这个现实。

转换的触发条件是「不是 exact str」，所以 str 子类会触发，int 键从第一刻起就是 GENERAL。这也是系列里反复出现的 exact 类型判断的又一次现身：特化篇的 `BINARY_OP_ADD_INT` 拒绝 int 子类，此处 UNICODE 表拒绝 str 子类，原则相同，快路径要求精确匹配，语义留给通用路径。

## 共享键表：一个类一份键表

如果每只实例的 `__dict__` 都自带一份键表，一千只 Point 实例的键都是 x、y 两条，键表就要存一千份。PEP 412 起的答案是共享键表（split 表）：

```text
类 Point（所有实例共享）
    PyDictKeysObject（SPLIT 形态，最多 30 个键）
    dk_entries: [x][y][z]...     ← 键只存一份
        ▲
        │ ma_keys 指向同一张表
   ┌────┴────┬─────────┐
instance_1  instance_2  instance_3
   values: [1,2]  [3,4]  [5,6]   ← 各自的值数组（inline values 或独立分配）
```

键存在类上，值存在实例上。访问 `p.x` 时，解释器拿着共享键表查到下标 1，再从 p 自己的值数组取 values[1]。`p.__dict__` 这个真字典对象按需物化，物化时直接把实例的值数组接上去，不复制键值。

配额机制是理解三个数字的关键：

```text
_PyDict_NewKeysForClass:  dk_usable = 30（SHARED_KEYS_MAX_SIZE）
类创建时：__static_attributes__ 里的属性名预插进共享键表
每个实例创建：dk_usable 减一（为 inline values 预留增长空间）
每个新键名（任何实例首次写入）：dk_usable 再减一
```

验证 `__static_attributes__` 确实存在：

```python
class Point:
    def __init__(self):
        self.x = 1
        self.y = 2

print(Point.__dict__["__static_attributes__"])   # ('x', 'y')
```

`__init__` 里的 `self.x`、`self.y` 在编译期就被记进这枚元组，类创建时 x、y 已经在共享键表里。所以 Point 实例的 `__dict__` 从第一天起就报 88：外壳 48 + GC 头 16 + 3 个值槽（x、y 两条键加一格钳位余量）× 8。这不是「物化出的字典都长一样」，而是这只类此刻的配额状态算出来就是 88。

配额如何随实例数变化？固定属性的场景（Point 只有 x、y）本机实测：

```text
第 1 个实例物化 __dict__ 时      296
第 2 个实例                     288
第 3 个实例                     280
...每实例恰好 -8...
第 26 个实例                      96
第 27 个实例起稳定               88
```

先拆 296。split 表的 `__sizeof__` 不取数值数组的实际字节数，它按指针槽数计：外壳 48 + GC 头 16 + `shared_keys_usable_size() × 8`。首实例物化时 `nentries + dk_usable = 2 + 27 = 29` 个值槽，48 + 16 + 29×8 = 296。此后每个新实例创建都让 `dk_usable` 减一（键已存在的 x、y 不再消耗），第二个实例物化时只剩 28 槽，于是 288；阶梯的每一级恰好是 8 字节，一格值槽。`dk_usable` 被钳位到 1 之后不再下降，`usable_size` 收敛到 `nentries + 1`：两条键的类收敛在 3 槽，即 88。这类类永远不会 unshare，共享键表稳定服务任意多个实例。

配额真正耗尽的是另一种场景：属性名持续增长的类。

```text
class Wide: pass
第 i 个实例写入 a0..a_{i-1} 共 i+1 个属性（每个实例都引入新键名）
实测：296, 288, ..., 184（第 15 个实例，16 个属性）
第 16 个实例起 832 —— 配额耗尽，物化的字典转 combined 表
```

新键名比实例创建消耗更快：每记一个新键，`nentries` 加一的同时 `dk_usable` 减一，两者在 `usable_size` 里相互抵消，而配额池 `dk_usable` 以每实例「创建一格 + 新键若干格」的速度下降。第 15 个实例创建时配额已见底，第 16 个实例的属性再也挤不进共享键表，`insert_split_key` 返回 DKIX_EMPTY，物化路径当场把这只实例的字典转成独立 combined 表（GROWTH_RATE(17×3=51) → 64 槽 → 832 字节）。这只类自第 16 个实例起 unshare。注意：更早物化的 split 字典继续挂在旧共享键表上，但此后新键名也进不了共享表了。

这正是对象布局篇「首个实例 296、第二十六个起 88」那条曲线背后的机制：那个实验逐实例累加属性（本节的场景二），配额被新键名持续消耗。如果属性固定（场景一），同样的类建一百个实例，`__dict__` 稳定在 88。对象布局篇结尾那句「报告值不是可以无条件复制到整个实例群的常量」，在这两种场景的对照里有了完整的机制解释。

共享键表给了 split 表几个鲜明个性：

- 键集合永远 ≤ 30，超出即 unshare；
- 迭代序靠值数组旁的插入序字节组维持（每键一字节，记录条目下标），不靠条目的物理顺序：split 表的键在共享条目数组里，值分散在各实例，顺序只能另记。`del` 一个属性要在这个字节数组里找到它、整体前移补洞；
- 值数组可能内联在实例主体里（inline values，`values->embedded == 1`），不占独立分配；这是对象布局篇见过的 managed preheader 之后的又一层实例属性存储。

顺带解释一个日常困惑：`sys.getsizeof(p.__dict__)` 为什么会「自己变小」。物化时它快照的是 `nentries + usable`（值数组容量），而配额是类全局状态：实例越多、配额越紧，早先物化的那只字典下次被问尺寸时，`shared_keys_usable_size()` 返回的数就越小：

```text
第 1 个实例物化时                 296
再创建 30 个实例后（不再动它）      88
```

同一只字典对象，两次 `getsizeof` 给出不同答案。它没有变，是它引用的类配额变了。`getsizeof` 对 split 表报告的是「当前类配额下这只值数组的尺寸」，这个数会跟着类状态走。

## 版本号：globals 的键变动信号

键表头部还有一个 `dk_version`。它不是为用户准备的，是为特化准备的。

回到特化篇的老朋友：`LOAD_GLOBAL`。模块顶层函数里的 `TARGET`，热身后特化成 `LOAD_GLOBAL_MODULE`，内联缓存里记下 TARGET 在 globals 键表的条目下标，以及当时键表的版本号。此后每次执行，守卫只做一次整数比较：`keys->dk_version == 缓存里的版本` 就直接取对应条目的 `me_value`，跳过完整查找。

版本号的规则很朴素：键集合的任何一次变动，插入、删除、转换、扩容，都把 `dk_version` 清零重发。惰性分配：第一次被问到版本号才从解释器全局计数器领一个新号；清零后下次再问，领到的就是不同的号。内联缓存里的旧号于是失效，守卫失手，回到通用路径重新查找，攒够证据后重新特化。

用 3.14.7 的 `dis` 缓存观察可以直接看到这套机制运转。特化后 `LOAD_GLOBAL` 的内联缓存有四个槽：counter、module 版本、builtin 版本、条目下标（按 C 结构体 `_PyLoadGlobalCache` 的字段顺序）：

```text
热身后（TARGET 在模块 globals）：
  opname=LOAD_GLOBAL_MODULE  counter=832  module版本=56  builtin版本=0(未用)  index=10

连跑 100 次（不改任何东西）：       counter=832（守卫全命中，counter 不动）
TARGET = 222 后连跑 100 次：       counter=832  module版本=56  index=10（仍全命中）
globals()['UNRELATED'] = 1 后：    index 10 → 15（版本重发，重特化后下标变化）
```

中间那行是这篇文章最反直觉的观察：改值不失效。`TARGET = 222` 之后守卫依然全命中、依然直接取 `entries[10]`，而拿到的已经是新值。因为特化路径每次都现读条目的 `me_value`，缓存的是「去哪里取」，不是「取到什么」。版本号守护的是键集合的结构（下标 10 还是不是 TARGET），值是活数据，随时新鲜。

第三行则是键集合变动的标准结局：加一个无关的新全局，globals 键表版本清零重发，守卫失手，回到通用路径；重新特化时缓存记下新的条目下标。TARGET 在条目数组里的位置其实没变（新键追加到它后面），变的是 56 → 61 这类被记录的版本号本身。缓存里的下标与版本成对更新，任何一项对不上就回到通用路径。

一个必须交代的观察陷阱：`dis` 打印 CACHE 行时，标签顺序来自 `Lib/opcode.py` 的 `_cache_format`（counter, index, module_keys_version, builtin_keys_version），与 C 结构体的字段顺序（counter, module, builtin, index）不一致。直接照抄 dis 的标签会得出「module 版本恒为 0」的荒谬结论：那个 0 其实是 MODULE 形态下未使用的 builtin 版本槽。交叉验证的方法是同一函数里同时放一个模块全局和一个内置名：MODULE 形态与 BUILTIN 形态共享同一个 globals，两者的 module 版本槽必须相等（实测 62 与 62），而 BUILTIN 形态的 builtin 版本槽非零（50 对 MODULE 形态的 0）。诊断工具的展示顺序和内存布局是两回事，读数字以前先对齐布局。

版本号不只是 Tier 1 的机制。`_ma_watcher_tag` 里的监控位服务 sys.monitoring，Tier 2 的 `_GUARD_KEYS_VERSION` micro-op 做同一件事；JIT 篇里「改一个 builtins 让整张 trace 图失效」的实验，失效信号正是从这里来的。dict 的键集合版本，横跨三层执行机制。

## 谁在引用这张键表

`dk_refcnt` 说明键表是可共享资源。共享的不只实例字典一族：

```text
dict(d) / d.copy()      分配新键表，深复制条目（dk_refcnt == 1 的普通拷贝）
实例 __dict__（split）   同一张键表挂在类上，dk_refcnt = 实例数 + 1
模块 globals            dk_refcnt == 1，但被特化缓存按版本号引用
```

普通的 `d.copy()` 不共享键表：

```python
d = {f"k{i}": None for i in range(5)}
c = d.copy()
# 两者都是 184，互不影响
del d["k0"]; d["new"] = 1
# d 涨到 272，c 仍是 184，k0 仍在 c 里
```

`.copy()` 之后两只字典的键集合立刻分开，这是「浅拷贝」在 dict 内部的精确含义：条目数组独立，键对象与值对象共享。

## 三版对照：一张布局的十年稳定与一个新面孔

本文所有实验在 3.12.13、3.14.7、3.16.0a0 三版上输出完全一致（除 str 哈希种子不同外）：尺寸阶梯、删除行为、键形态转换、共享键配额、探测与墓碑行为逐字节相同。compact dict 的索引表、条目数组分层自 3.6 定型，到 3.14 已稳定十年。sys.getsizeof 的阶梯不是实现细节的抖动，是结构公式的直接输出。

3.16 带来一个新面孔：内置 `frozendict`（PEP 763）。

```python
# CPython 3.16.0a0
frozendict(a=1, b=2)        # getsizeof = 192，可哈希，不可变
dict(a=1, b=2)              # getsizeof = 184
```

它的结构是 `PyDictObject` 外面再包一层：与同键数的 dict 恰好差 8 字节，多出的正是 `ma_hash` 缓存。可哈希对象每次进 dict 键、进 set 都要算哈希，冻结的字典把这笔计算提前付掉了（72 字节的空 frozendict 对 64 字节的空 dict，同样的 +8）。键表布局与 dict 完全一致，int 键的 frozendict 同样比 str 键多出条目规格的差距；「不可变」体现在没有写路径，存储仍是同一套。

顺带一提源码里的一个考古点：dictobject.c 顶部的设计注释至今写着「split 表用 4-bit 移位的位向量记录插入序，因此上限 16」。而两棵源码树里的实现都是每键一字节的插入序数组，`SHARED_KEYS_MAX_SIZE = 30`。注释落后实现至少两个版本。读源码时，代码与注释打架，信代码。

---

## 分层的推论

dict 不是链地址哈希表：索引表存下标、条目数组存键值，两层分离；插入序来自条目数组的追加顺序，不靠链表维护。哈希不决定条目位置，只决定槽位；冲突走 `i*5 + perturb + 1` 递推，探测遇到空位即止步，遇到墓碑必须跨过。

删除不缩表、不填洞：条目置空、槽位立墓碑，重插同键追加到条目数组末尾；满表删一插一即触发扩容，因为 usable 只数未用过的槽位。首键决定键表身份，转换不可逆：非 exact str 键把整表从 16 字节条目转成 24 字节条目，str 子类一样触发。

实例字典的键表是共享资源，配额 30：新键名与每个新实例消耗配额，耗尽即 unshare；物化的 `__dict__` 报告尺寸随类配额变化。版本号守护键集合，不守护值：改值不失效缓存，特化路径现读 `me_value`；加键删键才清零重发版本。

getsizeof 的数字要分层读：外壳、GC 头、索引表、条目数组、值数组各是一层，split 表的数字还是类全局状态的函数。这套布局不是语言承诺：三版一致是稳定性的事实，不是对未来的保证；frozendict 的出现说明键表布局还会被新类型复用。

上一篇拆 GIL 时，引用计数、分配器、字节码特化都要跟着变；这一篇回到单线程场景，把 dict 的布局本身讲清。特化篇提过的字典版本、对象布局篇的共享键 88 字节、JIT 篇的 trace 失效信号，出处都在这里。

对象布局篇留过一句「str 根据 ASCII、字符宽度、compact 状态采用多种布局」就停住了；dict 的键表也反复提到「str 自带哈希缓存」。下一篇走进 `PyUnicodeObject`：一个字符的重量怎么随内容变、哈希缓存在哪里、驻留机制为谁服务。
