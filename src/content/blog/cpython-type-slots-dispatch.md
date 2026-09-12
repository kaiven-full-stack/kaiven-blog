---
title: 一枚加号怎样找到 __add__：CPython 的类型槽与操作分派
description: 一枚 + 为什么能找到整数加法、字符串拼接与用户定义的 __add__？本文沿 ob_type 进入 PyTypeObject，从 BINARY_OP、PyNumber_Add 与 nb_add 追到反向运算、严格子类优先、NotImplemented、序列拼接后备和类型槽更新，并分清哪些结论属于 Python 数据模型、哪些属于 CPython 当前实现。实验跑在 CPython 3.14.7 上，另对照 3.12.13 与 3.16.0a0 开发源码。
pubDate: 2026-09-08T20:00:00+08:00
category: cpython
tags: [CPython, 编程语言]
---

```text
value.__add__(value)    -> instance-add
value + value           -> class-add
```

两行结果为什么不同？代码是：

```python
class Addable:
    def __add__(self, other):
        return "class-add"

value = Addable()
value.__add__ = lambda other: "instance-add"

print(value.__add__(value))
print(value + value)
```

实例上明明已经有一只新的 `__add__`，显式调用也确实拿到了它；一枚 `+` 落下来时，解释器却绕开这份实例属性，仍然执行类上的实现。

矛盾只存在于一句过度简化的话里：

```text
left + right == left.__add__(right)
```

它适合作为初学时的近似，不是完整分派规则。真正的 `+` 还要处理右侧反向实现、严格子类优先、`NotImplemented` 转交、序列拼接后备，以及类型方法在运行期间被修改的情况。

上一篇沿对象头里的 `ob_type` 走到 `PyTypeObject`，先读取 `tp_basicsize` 与 `tp_itemsize`，回答一块内存有多大、该怎样解释。可类型对象保存的不只是尺寸信息。表达式 `left + right` 到来时，解释器还要沿同一条指针寻找操作入口，再判断左右哪一方愿意处理这对对象。

这一篇不再称对象的重量，而是追一枚加号的完整分派过程。

实验环境是 64 位 x86_64 Linux 上的 CPython 3.14.7 默认 GIL 非 debug 构建，对照组为 3.12.13。源码结构另核对一份本地 CPython 3.16.0a0 开发快照，该目录缺少 Git 元数据，绑定不到具体提交。`__add__`、`__radd__`、`NotImplemented` 与严格子类的反向优先属于 Python 数据模型；`BINARY_OP`、`binary_op1()`、槽包装函数和专用指令名称则是当前 CPython 实现事实。

## `ob_type` 的另一半：类型不只规定尺寸

上一文已经画过这条线：

```text
PyObject
    ↓ ob_type
PyTypeObject
```

当时我们关心的是：

```text
tp_basicsize    固定主体多大
tp_itemsize     每个变长项多大
```

这一篇关心的是同一类型对象上的另一组协议：

```text
PyTypeObject
    ├── tp_as_number
    │     ├── nb_add
    │     ├── nb_subtract
    │     └── ...
    ├── tp_as_sequence
    │     ├── sq_concat
    │     └── ...
    ├── tp_dealloc
    └── 其他操作入口
```

`tp_dealloc` 在引用计数篇里已经出现过：对象被回收时，类型决定怎样清理。`nb_add` 则站在另一端：对象还活着，一枚 `+` 到来时，类型决定自己如何参与加法协议。

这里的 type slot 是 `PyTypeObject` 及其协议表中的 C 层操作入口，不是 Python 类声明里的 `__slots__`。后者安排实例属性存储，前者连接运行时行为；名字相似，职责完全不同。

类型槽带来一层统一抽象。解释器不必在每次运算中写出一份无限延长的判断：

```text
如果是 int，就这样加
如果是 float，就那样加
如果是某个扩展类型，再做另一件事
...
```

它先取对象的运行时类型，再沿协议槽把问题交给该类型。内建 C 类型可以直接安装专用函数；Python 定义的类则通常通过通用 wrapper，把槽调用继续映射到 `__add__` 与 `__radd__`。

## 源码里的加号，先变成 `BINARY_OP`

先看最小函数：

```python
def add(left, right):
    return left + right
```

用 CPython 3.14.7 的 `dis` 查看基准字节码：

```python
import dis

dis.dis(add, adaptive=False)
```

与本文相关的部分是：

```text
BINARY_OP               0 (+)
RETURN_VALUE
```

源代码里的 `+` 被编成通用的 `BINARY_OP`，参数 `0` 在这个版本中表示 `NB_ADD`。这一条逻辑指令还没有把操作数写死为整数、字符串或用户类；它只知道“请执行加法这一类二元操作”。

当前通用实现可以概括成：

```text
BINARY_OP(oparg = NB_ADD)
    ↓
_PyEval_BinaryOps[NB_ADD]
    ↓
PyNumber_Add(left, right)
```

`_PyEval_BinaryOps` 是一张函数表。`NB_ADD` 对应 `PyNumber_Add`，`NB_SUBTRACT` 对应减法入口，原地加法则有自己的 `NB_INPLACE_ADD` 与 `PyNumber_InPlaceAdd`。

这点也划出范围：本文讨论纯 `left + right`。`left += right` 会先尝试 `nb_inplace_add`，失败后才回到普通二元协商，并且序列还有自己的原地拼接后备。富比较也有不同的反向关系和最终后备，不能把本篇规则原样复制过去。

`dis` 输出同样不是 Python 语言规范。不同版本可以改变指令名称、合并方式和缓存呈现；本文只用它定位 CPython 3.14.7 中从表达式进入运行时的入口路径。

## `PyNumber_Add()` 先问数字协议

很多普通算术 API 会通过一层 `binary_op()` 包装 `binary_op1()`；加法却单独实现，因为它还承担序列拼接后备。

当前调用链是：

```text
PyNumber_Add(left, right)
    ↓
binary_op1(left, right, nb_add, "+")
    ↓
左右数值槽协商
    ↓ 都拒绝
检查左操作数的 sq_concat
    ↓ 仍没有入口
TypeError
```

也就是说，`PyNumber_Add()` 不是直接取 `left.__add__`。它先从左右类型的 `tp_as_number` 中读取目标槽，再按二元协议决定顺序。

把两只操作数记作：

```text
left type   = V
right type  = W
left slot   = V.tp_as_number->nb_add
right slot  = W.tp_as_number->nb_add
```

`binary_op1()` 先定下几条顺序规则：

- 左右类型相同，不把同一类型槽当作右侧再调用一次；
- 类型不同但两个 C 槽指针完全相同，也会取消第二次顶层槽调用；
- 右类型是左类型的严格子类，并且拥有不同的槽实现时，右槽可以先回答；
- 一般情况下，左槽先答，返回 `NotImplemented` 后才轮到右槽；
- 所有候选都拒绝，内部才把 `NotImplemented` 交回更外层处理。

但对 Python 定义的类，还要再加一层：左右类的 `nb_add` 经常都指向同一只通用 `slot_nb_add` wrapper。顶层 C 槽只调用一次，不意味着 Python 层永远不会调用 `__radd__`；wrapper 内部会对正向与反向方法再做一次选择。

所以不能把实现机械画成两个独立字段：

```text
错误示意：nb_add  -> __add__
          nb_radd -> __radd__
```

`PyNumberMethods` 没有一只独立的 `nb_radd`。对 Python 类，`__add__` 与 `__radd__` 共同关联同一个 `nb_add` 槽和同一类 wrapper，wrapper 再依据操作数类型与方法覆盖情况决定调用哪一个。

## `NotImplemented` 是转交，不是报错

先让左边主动拒绝这一组操作数：

```python
log = []

class Left:
    def __add__(self, other):
        log.append("Left.__add__")
        return NotImplemented

class Right:
    def __radd__(self, other):
        log.append("Right.__radd__")
        return "reflected"

print(Left() + Right())
print(log)
```

CPython 3.14.7 与 3.12.13 都输出：

```text
reflected
['Left.__add__', 'Right.__radd__']
```

`NotImplemented` 是一只单例值。这里的意思不是“程序功能还没写完”，而是：

> 当前实现不接受这对操作数，请把决定权交回二元操作协议。

解释器收到它后，释放当前返回引用，继续尝试允许的另一侧实现。若右侧接受，整个 `+` 仍然成功。

把左侧改成抛异常：

```python
class ErrorLeft:
    def __add__(self, other):
        log.append("ErrorLeft.__add__")
        raise NotImplementedError

class ErrorRight:
    def __radd__(self, other):
        log.append("ErrorRight.__radd__")
        return "unreached"
```

执行 `ErrorLeft() + ErrorRight()`：

```text
NotImplementedError
['ErrorLeft.__add__']
```

`NotImplementedError` 是普通异常，属于 `RuntimeError` 的子类。槽返回异常时，C 层得到的是失败标志，不是 `Py_NotImplemented`；异常立即向上传播，不再尝试右侧反向实现。

两边都返回 `NotImplemented`，并且没有其他后备入口时，才由外层生成面向用户的错误：

```text
TypeError: unsupported operand type(s) for +: 'Left' and 'Right'
```

因此要区分三件事：

```text
return NotImplemented      当前一侧转交，协议继续尝试另一侧
raise NotImplementedError  当前执行直接失败
最终 TypeError             两侧都不处理，协议层报错
```

3.14 还有一条版本变化：`bool(NotImplemented)` 现在直接抛 `TypeError`；3.12.13 会给出 `DeprecationWarning` 后返回 `True`。它本来就不该被当作普通布尔结果判断，正确做法是返回它，让操作分派层识别这只单例。

## 右边为什么有时先开口

“先 `__add__`，返回 `NotImplemented` 后再试 `__radd__`”仍然不完整。右侧若是左侧类型的严格子类，并且提供了不同的反向实现，它可以优先回答。

```python
log = []

class Base:
    def __add__(self, other):
        log.append("Base.__add__")
        return "base"

    def __radd__(self, other):
        log.append("Base.__radd__")
        return "base-r"

class Sub(Base):
    def __radd__(self, other):
        log.append("Sub.__radd__")
        return "sub-r"

print(Base() + Sub())
print(log)
```

输出是：

```text
sub-r
['Sub.__radd__']
```

左侧 `Base.__add__` 明明可以直接返回结果，却没有先发言。右侧 `Sub` 更具体，并覆盖了自己的反向实现，所以协议先给它机会处理“Base 加 Sub”这对混合类型。

这条规则让派生类型可以接管基类原本不知道的新语义。例如一个数值基类已经会与普通对象相加，后来出现的单位数、矩阵或符号表达式子类，仍可通过反向实现优先解释混合运算。

但“右边是子类”本身还不够：

```python
class Inherit(Base):
    pass

print(Base() + Inherit())
print(log)
```

清空日志后，本机输出：

```text
base
['Base.__add__']
```

`Inherit` 只是继承同一份 `__radd__`，没有提供不同反向语义，因此不获得额外优先权。

在 C 槽层，`binary_op1()` 判断严格子类和不同槽指针；在 Python heap type 常见的共享 `slot_nb_add` 场景中，wrapper 还会比较右类解析出的 `__radd__` 是否真的不同。文章若只写“右侧是子类就先 `__radd__`”，会漏掉这项关键条件。

## 同类型为什么不再试一次 `__radd__`

再看一组容易误判的代码：

```python
log = []

class Same:
    def __add__(self, other):
        log.append("Same.__add__")
        return NotImplemented

    def __radd__(self, other):
        log.append("Same.__radd__")
        return "same-r"

try:
    Same() + Same()
except TypeError:
    print(log)
```

输出：

```text
['Same.__add__']
```

`Same.__radd__` 没有被调用。两个操作数类型相同，协议不会把同一类型的同一加法能力换个方向再重复问一次。

在 `binary_op1()` 顶层，只有左右类型不同才会读取右侧数值槽；C 函数指针相同也会去掉第二次顶层调用。对于 Python 类，共享 wrapper 在一次调用内部同样识别类型相同，不安排普通右侧反向尝试。

这项去重不是“反向方法失效”。前面的 `Left + Right` 已证明异型操作数中，wrapper 可以在左侧返回 `NotImplemented` 后找到右侧 `__radd__`；严格子类实验还证明反向方法有时会最先执行。它只是不对相同类型重复询问同一份类型协议。

## 加号还有一扇序列后门

如果数字槽都不接，`PyNumber_Add()` 还没有立刻结束。它会检查**左操作数**类型的序列协议，寻找 `sq_concat`：

```text
左右 nb_add 均未处理
        ↓
left.tp_as_sequence->sq_concat 存在？
        ├── 是：调用序列拼接
        └── 否：TypeError
```

这就是同一枚 `+` 可以连接列表和字符串的实现入口：

```python
print([1] + [2])
print("雨" + "声")
```

```text
[1, 2]
雨声
```

结果本身只能证明“它们支持加号”，不能单独证明底层走哪只槽。本次还通过公开 C API `PyType_GetSlot()` 观察三类类型：

```text
             nb_add    sq_concat
list         False     True
str          False     True
自定义 __add__ True      False
```

槽号取自对应版本的公开 `typeslots.h`。结合 `PyNumber_Add()` 源码，可以确认本机 list 与 str 由左侧 `sq_concat` 承接；普通 Python 类定义 `__add__` 时，则由 `nb_add` 的通用 wrapper 处理。

这里没有一套对称的 `sq_rconcat`：

- 数值槽先完成左右协商；
- 序列后备只读取左类型的 `sq_concat`；
- 不会自动再询问右操作数的序列拼接槽。

CPython 还特意避免让 Python heap type 的同一个 `__add__` 同时安装到可调用的 `nb_add` 与 `sq_concat`，否则数值槽返回 `NotImplemented` 后，同一用户方法可能又从序列后备被调用一次。

`+` 与 `*` 在这方面是算术入口中的特例：前者可回退到序列拼接，后者可回退到序列重复。不能把这扇后门推广成所有二元操作的共同规则。

## 为什么实例属性进不了特殊方法通道

回到开场：

```python
value.__add__ = lambda other: "instance-add"
```

显式写 `value.__add__` 时，这是普通属性查找，实例字典可以影射类上的同名方法。

隐式运算却从对象的运行时类型进入。当前 `_PyObject_LookupSpecial()` 的核心是沿 `Py_TYPE(value)` 查找特殊方法，再把描述符绑定到实例；它不是普通的 `PyObject_GetAttr(value, name)`。因此实例字典中的 `__add__` 不参与 `+` 的隐式协议。

`len()` 也有同样边界：

```python
class Sized:
    def __len__(self):
        return 3

value = Sized()
value.__len__ = lambda: 9

print(len(value))
print(value.__len__())
```

```text
3
9
```

绕过实例属性不是只为加法定制的古怪例外，这是隐式特殊方法查找的一般设计。它让 `len(value)`、`value + other` 等协议直接连接类型槽，避免单个实例任意影射核心操作。

这也能避开一层 metaclass 混淆。若 metaclass 定义 `__add__`，它控制的是类对象本身参与的加法，因为类对象的运行时类型是 metaclass；它不会自动成为该类实例的加法实现。

```text
A() + A()    查 A 的实例协议
A + A        查 type(A) 的协议，也就是 metaclass
```

本文不展开完整 descriptor、MRO 与 metaclass 查找过程，只留下边界：隐式特殊方法从操作数类型出发，不等同于把 `type(value).__add__` 这段 Python 表达式原样执行一遍。

## 类型槽不是冻结的函数指针

特殊方法从类型出发，不代表类创建后行为就永远写死。

```python
class Value:
    pass

value = Value()
```

按顺序修改类：

```python
Value.__add__ = lambda self, other: "v1"
print(value + value)

Value.__add__ = lambda self, other: "v2"
print(value + value)

del Value.__add__
```

结果是：

```text
添加以前      TypeError
第一次添加    v1
替换以后      v2
删除以后      TypeError
```

同一只早已存在的 `value` 会立即跟随类变化。特殊方法没有在实例创建时复制进每个对象。

当前 CPython 中，类属性更新先经过 `type_setattro`。若名字对应特殊槽，运行时调用 `update_slot()` / `update_one_slot()`，沿当前 MRO 重新计算该槽；修改还会传播到没有自行覆盖这个名字的子类分支。

删除 `Value.__add__` 也不总是把 `nb_add` 清成空。若基类仍有实现，重新扫描 MRO 后会恢复继承来的槽。只有整条可见继承链都没有对应实现，槽才会失去该能力。

把 `Value.__add__` 设为整数 42，则不是“删除”：

```text
TypeError: 'int' object is not callable
```

这次槽仍能沿类找到 `__add__`，只是实际调用时发现它不可调用。错误类型同样是 `TypeError`，但成因与“双方都没有加法能力”不同；异常文案有助于本次诊断，却不应被业务代码当作稳定接口解析。

还有一个限制：`int` 这类 immutable static type 通常不允许直接执行 `int.__add__ = ...`。原因不在槽更新机制只支持用户类，而是类型本身带有不可修改标志。Python 定义的可变子类仍可以安装自己的特殊方法与槽 wrapper。

## 一条通用协议，几种不同终点

现在可以把开场几种加号放在一张表里：

| 表达式场景 | 通用语义入口 | 常见终点 |
| --- | --- | --- |
| exact `int + int` | 数值加法协议 | 整数加法实现 |
| `str + str` | 数值协议拒绝后序列后备 | Unicode 拼接 |
| `list + list` | 数值协议拒绝后序列后备 | list 拼接 |
| Python 用户类相加 | `nb_add` 通用 wrapper | `__add__` / `__radd__` |
| 两侧都不接且无序列后备 | 同一协商过程 | `TypeError` |

“共享协议”不表示每次执行都经过完全相同数量的函数调用。内建类型可以把槽直接指向专用 C 函数；Python heap type 常用 wrapper 才继续查找语言级特殊方法；热代码还可能被自适应解释器送到更短的专用指令。

真正保持一致的是语义边界：

- 更具体的右侧类型有覆盖机会；
- `NotImplemented` 可以转交；
- 异常不能伪装成转交；
- 操作符不读取实例上的同名属性；
- 最终无人处理时才形成错误。

优化可以缩短路径，不能悄悄改变这些结果。

## 通用字节码与自适应形态是两个观察层

重新看最初的函数：

```python
def add(left, right):
    return left + right
```

在一个新进程里，运行前查看：

```python
[(i.opname, i.argrepr) for i in dis.get_instructions(add, adaptive=True)
 if "BINARY" in i.opname]
```

```text
[('BINARY_OP', '+')]
```

反复执行整数加法：

```python
for _ in range(20_000):
    add(1, 2)
```

再看自适应形态：

```text
[('BINARY_OP_ADD_INT', '+')]
```

而 `adaptive=False` 在运行前后仍展示逻辑上的通用 `BINARY_OP`。

本次输出能证明：在 CPython 3.14.7 与 3.12.13 的这段固定运行中，解释器把长期看到 exact int 的操作点展示成了专用整数加法形态。它不能证明所有加号从此都绕过 `PyNumber_Add()`，也不能用来推导用户类的 `__add__` / `__radd__` 顺序。

专用路径只在 guard 足够强时成立。类型忽然改变、不满足 exact-type 条件或当前组合不支持特化，解释器必须回到语义等价的通用路径。当前 3.16.0a0 开发快照还扩大了 `BINARY_OP_EXTEND` 覆盖的容器与混合数值组合，具体指令名和范围仍会随版本变化。

这一节只留下下一个问题：解释器怎样判断一处操作已经“足够稳定”，inline cache 记住什么，guard 失败后又如何退回？那是下一篇的主线。

## 结论归到哪一层

读源码文章时，最好把结论放回三层：

### Python 数据模型

它规定语言层可观察的协议，例如：

- `__add__` 与 `__radd__` 的职责；
- 严格子类反向实现的优先机会；
- `NotImplemented` 触发继续协商；
- 隐式特殊方法通常在类型上查找；
- 最终无法完成运算时抛出 `TypeError`。

### CPython 公开 C API

`PyNumber_Add()`、类型槽和 `PyType_GetSlot()` 为扩展与嵌入程序提供公开入口。它们比内部函数名稳定，却也受所选 API/ABI 层级约束。

### 当前内部实现

下面这些属于版本事实：

```text
BINARY_OP
_PyEval_BinaryOps
binary_op1()
slot_nb_add
update_one_slot()
BINARY_OP_ADD_INT
```

本地 3.16.0a0 快照与 3.14 的核心左右协商结构一致，但自适应指令族和 `BINARY_OP_EXTEND` 覆盖范围已经继续扩大。工具若依赖具体 opcode 名称、缓存布局或私有结构偏移，就必须按版本重新验证。

实验中的打印顺序也有证据边界。它能说明本次 Python 类型经历了哪些用户可见方法，不能单独证明内部 C 函数地址；源码则能解释通用实现，却不能据此断言热点代码每一次都实际走完所有中间层。两类证据要相互校验，不能互相冒充。

## 分派规则汇总

`ob_type` 连接的不只是对象的字节，还有对象的行为：类型对象既给出尺寸与析构协议，也提供数值、序列等操作入口。一枚 `+` 先进入抽象操作协议，不等于普通调用 `left.__add__(right)`：实例同名属性不参与，严格子类可能优先，还有序列后备。对 Python 类，`__add__` 与 `__radd__` 常通过同一只 `slot_nb_add` wrapper 接入一个 `nb_add` 槽，并非两只互不相干的 C 槽。

协商里的三种返回值各有去向：`NotImplemented` 是转交信号，让协议继续尝试另一侧；`NotImplementedError` 是普通异常，立即传播；两侧都拒绝且无其他后备时，外层才生成 `TypeError`。右侧反向实现获得优先权有条件：子类必须提供不同的反向语义，只继承同一实现不会自动插队。同类型之间不会把同一份反向协议重复问一次。字符串与列表的拼接走左侧 `sq_concat` 后备，没有对称的右侧序列仲裁。

特殊方法从类型出发，实例同名属性不能替换隐式操作；显式 `obj.__add__()` 与 `obj + other` 走的是不同查找入口。类型槽可以动态更新：修改类上的特殊方法会重算槽并影响已有实例，删除后是否清空，取决于 MRO 中是否还有继承实现。特化可以缩短执行路径，但不能改写协议语义，guard 不成立时解释器必须回到等价的通用分派。

这一篇回答了语义上该找谁。可若一段循环里连续做一百万次 exact int 加法，每次都走完整套协商就太贵了。下一篇继续留在这枚加号上：当答案长期不变，CPython 怎样记住它，何时尝试特化，inline cache 保存什么，专用指令凭什么走短路，类型忽然改变时又怎样回到通用分派。
