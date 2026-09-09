---
title: 同一个点号，四种答案：CPython 的属性查找与描述符协议
description: 同名属性上，实例字典压过普通类属性，data 描述符又压过实例字典；`__slots__`、`property`、方法绑定、`super()` 全部由同一套仲裁规则驱动。本文从 `obj.x` 的完整链路出发，拆开 `_PyObject_GenericGetAttrWithDict` 的四层优先级、MRO 查找、零参 super 的 `__class__` cell 与 LOAD_ATTR 特化，辨清描述符层级、绑定时机与版本号失效各自来自哪里。实验在 CPython 3.14.7 上复核，并对照 CPython 3.12.13 与 3.16.0a0 开发源码。
pubDate: 2026-09-10T11:30:00+08:00
category: cpython
tags: [CPython, 编程语言, 面向对象]
---

```text
实例字典有 x，类上有普通 x      →  实例赢
实例字典有 x，类上有 non-data x  →  实例赢
实例字典有 x，类上有 data x      →  类上的描述符赢，写都被拦下
```

三行结论都在 CPython 3.14.7 上验证：

```python
class NonData:
    def __get__(self, obj, objtype=None):
        return "nondata"

class Data:
    def __get__(self, obj, objtype=None):
        return "data"
    def __set__(self, obj, value):
        pass          # 有 __set__ 即 data 描述符

class C:
    plain = "class-value"
    nd = NonData()
    d = Data()

o = C()
for name in ("plain", "nd", "d"):
    setattr(o, name, "instance-value")
    print(name, "->", getattr(o, name))
```

```text
plain -> instance-value
nd    -> instance-value
d     -> data
```

`o.d = "instance-value"` 甚至没有进实例字典——data 描述符连写都拦了。同一个点号背后不是一张查找表，是一场**有优先级的仲裁**。

这个系列已经攒了太多通向这里的伏笔：对象布局篇讲过实例的 inline values 与 managed dict；dict 篇拆透了共享键表与值数组；str 篇解释了属性名的驻留与哈希缓存；类型槽篇说过“实例属性进不了特殊方法通道”。这一篇把 `obj.x` 的完整链路走通，全部伏笔在此收束。

本文实验以 **CPython 3.14.7、x86_64 Linux、64 位、默认 GIL、非 debug 构建**为主，并与 CPython 3.12.13 做对照。源码结构同时核对本地一份标记为 **CPython 3.16.0a0** 的开发快照；该目录没有 Git 元数据，无法绑定到具体提交。优先级次序与描述符协议属于 Python 语义层（数据模型），具体实现路径与特化形态是版本事实。

## 先画全程：一个点号要走几道门

`obj.x` 在字节码层是 `LOAD_ATTR`。通用路径（`PyObject_GetAttr`）先问类型的 `tp_getattro` 槽；普通类的这个槽指向 `PyObject_GenericGetAttr`，落到 `_PyObject_GenericGetAttrWithDict`——本文的主角。它的工作按固定次序进行：

```text
1. 沿 MRO 在类型链上找 x            → 找到 res，暂存为 descr
2. descr 是 data 描述符？
   ├─ 是  → 立刻调用 __get__(obj, type)，返回，全程结束
   └─ 否  → 记下它的 __get__，继续
3. 查实例自己的属性存储
   ├─ inline values / managed dict / __dict__ 里找到 → 返回
   └─ 没找到 → 继续
4. descr 存在且有 __get__（non-data 描述符）→ 调用 __get__(obj, type)
5. descr 存在但不是描述符（普通类属性）→ 直接返回 descr
6. 都没有 → AttributeError
```

四层优先级一目了然：**data 描述符 > 实例存储 > non-data 描述符 > 普通类属性**。data/non-data 的分界线只有一个 C 判断：

```c
PyDescr_IsData(ob)  ==  (Py_TYPE(ob)->tp_descr_set != NULL)
```

**有 `__set__`（或 `__delete__`）就是 data 描述符**，与 `__get__` 写得多花哨无关。这个判定的直觉是：能控制写的对象，才有资格控制读——否则实例字典的写会绕过你、读却要听你的，状态就撕裂了。

第 3 步的“实例存储”在现代 CPython 里是三级形态：inline values（值数组内联在实例主体，dict 篇的主角）、managed dict（按需物化的 `__dict__`）、老式 `__dict__` 指针。对本文的优先级讨论，三者等价——都是“实例自己的账本”。

## 每一层都可以用记账描述符看到

上一节的仲裁顺序不需要盲信源码，让每层留下字迹：

```python
LOG = []

class DataDescr:
    def __init__(self, name): self.name = name
    def __get__(self, obj, objtype=None):
        LOG.append(("data.get", self.name))
        return f"data:{self.name}"
    def __set__(self, obj, value):
        LOG.append(("data.set", self.name))

class NonDataDescr:
    def __init__(self, name): self.name = name
    def __get__(self, obj, objtype=None):
        LOG.append(("nondata.get", self.name))
        return f"nondata:{self.name}"
```

对三类属性分别做“读一次 → 实例赋值 → 再读一次”，LOG 的轨迹完整还原仲裁：

```text
普通类属性：    读 = 类值；实例赋值后读 = 实例值          （第 3 层压过第 4 层）
non-data：     读 = nondata.get；实例赋值后读 = 实例值    （第 3 层压过第 3.5 层）
data：         读 = data.get；实例赋值 → LOG 记下 data.set，
               实例字典里根本没有这个键；再读 = data.get   （第 2 层压过第 3 层）
```

data 描述符的拦截是双向的：`__set__` 吞掉写请求，`__get__` 接管所有读。实例字典连“试一试”的机会都没有——这正是 `property`、`__slots__` 能严守边界的原因。

## `__slots__`：一组天生的 data 描述符

`__slots__` 的机制在类创建时就定型了。`type_new_descriptors` 把每个 slot 名字登记为一张成员表（`tp_members`）里的 `Py_T_OBJECT_EX` 条目，内容是**固定偏移**；类字典里对应的则是一个成员描述符：

```python
class P:
    __slots__ = ("x", "y")

print(P.x)        # <member 'x' of 'P' objects>
print(type(P.x))  # member_descriptor
```

成员描述符有 `tp_descr_get` 也有 `tp_descr_set`（`member_get`/`member_set` 按 offset 读写实例主体）——它是标准 data 描述符。所以 slot 名字的读写全部走第 2 层：读 = 从偏移处取指针，写 = 往偏移处存指针。所谓“slots 实例没有 `__dict__`”，准确说是“没有通用属性账本，只有固定槽位”；访问没登记的名字自然 AttributeError：

```text
p.z = 1
AttributeError: 'P' object has no attribute 'z' and no __dict__ for setting new attributes
```

错误消息后半句（3.14 起更明确）点破了机制：写不进来，是因为既没有 slot 偏移、又没有字典可下账。

继承会破坏这层严防。基类没有 `__slots__` 时，它已经带了 managed dict 标志；子类哪怕声明了自己的 slots，也挡不住从基类继承的字典：

```python
class A: pass              # 无 slots，实例有属性账本

class B(A):
    __slots__ = ("x",)

b = B()
b.x = 1
b.anything = 2             # 畅通无阻，进了继承来的 __dict__
print(b.__dict__)          # {'anything': 2}
```

对象布局篇测过 slots 的内存收益；这一篇补上机制：**slots 省内存的原因不是“删掉字典”这四个字，而是“属性读写被偏移量描述符接管”**。

## `property`：C 实现的 data 描述符

`property` 本身就是一个 C 级描述符对象（`propertyobject`），`fget`/`fset` 存在它的字段里，`tp_descr_get` 调用它们：

```python
class T:
    @property
    def value(self):
        return 42

print(type(T.value))                      # property
print(hasattr(T.value, "__set__"))        # True —— 即使没写 setter
```

没写 setter 的 property 也有 `tp_descr_set`（那个会抛 `AttributeError: can't set attribute` 的实现），所以它永远按 data 描述符仲裁。类身上直接访问 `T.value` 得到 property 对象本身——`__get__` 收到 `obj=None` 时按协议返回自身，这是“类访问拿到生工具、实例访问拿到熟结果”的统一出处。

方法绑定也是这套协议的产物。函数是非 data 描述符（有 `__get__` 无 `__set__`），实例读方法时走到第 4 层，`__get__(obj, type)` 返回 bound method：

```python
class E:
    def method(self): ...

E.method          # <function ...>        类访问：__get__(None, E) 给裸函数
e = E()
e.method          # <bound method ...>    实例访问：__get__(e, E) 给绑定方法
e.method.__self__ is e          # True
e.method.__func__ is E.method   # True
```

`staticmethod` 是“逃出协议”的描述符——它的 `__get__` 无视 obj 直接返回裸函数；`classmethod` 的 `__get__` 则把 cls 绑进去。三者都是“第 4 层的住户”，全部服从同一个优先级表。

## `__getattribute__`：唯一能改规则的地方

想劫持点号本身，唯一入口是 `__getattribute__`——它在第 0 层，`tp_getattro` 槽被你的实现占据，`_PyObject_GenericGetAttrWithDict` 根本不会被调用：

```python
class G:
    def __getattribute__(self, name):
        print(f"  [hook] {name}")
        return object.__getattribute__(self, name)
```

每次属性访问都会过这道门——包括钩子自己要调的 `object.__getattribute__` 里的每一步。这也解释了为什么 `__getattr__`（找不到才调）几乎总是比 `__getattribute__`（每次都调）更合适：前者只是在仲裁全部落空后追加一层，不扰动优先级。

`__getattr__` 的挂载点不在字节码层，而在类型槽：类里定义了 `__getattr__` 时，`update_one_slot` 给这个类装的是 `_Py_slot_tp_getattr_hook`——先走常规仲裁，落空时在 AttributeError 抛出前把机会转给 `__getattr__`；只有 `__getattribute__` 时装的是更简单的 `_Py_slot_tp_getattro`。所以两个钩子的真实分工是：一个换掉全部规则，一个只在仲裁落空后追加一层。

## super：换一条起跑线的同一场仲裁

`super()` 不创建新规则，它只是**换掉 MRO 的起点**。`do_super_lookup` 从 `su_obj_type` 的 MRO 里、`su_type` 之后的位置开始找；找到后照常走描述符协议：

```python
class A:
    def who(self): return "A"
class B(A):
    def who(self): return "B+" + super().who()
class C(A):
    def who(self): return "C+" + super().who()
class D(B, C):
    def who(self): return "D+" + super().who()

print(D.__mro__)    # (D, B, C, A, object)
print(D().who())    # D+B+C+A
```

`D().who()` 的调用链值得走一遍：D 的 super 沿 MRO 找到 B.who；**B.who 里的 super 沿的是 D 实例的 MRO**（不是 B 的），越过 B 找到 C.who；C 的 super 再找到 A.who。菱形继承里 `B` 和 `C` 都能被穿越，靠的就是“MRO 属于实例的类，不属于当前方法所在的类”。这一行 `D+B+C+A` 是 C3 线性化最精炼的证词。

零参 `super()` 的魔法在编译期。反汇编 `Sub.run`：

```text
LOAD_GLOBAL              0 (super)
LOAD_DEREF               1 (__class__)
LOAD_FAST_BORROW         0 (self)
LOAD_SUPER_ATTR          5 (run + NULL|self)
```

零参 super 其实是双参 super：编译器把 `__class__` 和 `self` 显式填进调用。`__class__` 是一个**闭包自由变量**（`co_freevars` 里躺着 `('__class__',)`，帧篇讲过的 cell 对象在此处上岗）——它绑定的是**词法上包含这个方法的类**，与 `type(self)` 无关。这就是为什么在 B 的方法里，super 的起点永远是 B 之后，哪怕实例的真实类型是子类 D。

`super_getattro` 里还有一行特判：`super().__class__` 返回 super 对象自己的类，不是 `su_obj` 的类——否则这个“看遍历器”会忘了自己是谁。

## 特化：仲裁也要有快路

四层仲裁是一场不小的开销：MRO 查找、描述符判定、字典访问。`LOAD_ATTR` 的特化把“这个点号通常落在哪一层”缓存进行内联缓存。specialize.c 先把属性归类（`DescriptorClassification` 十余种：OVERRIDING / PROPERTY / OBJECT_SLOT / METHOD / NONDESCRIPTOR / ABSENT……），再按类选择专用形态：

```python
class H:
    x = 1                # 类体定义的普通属性

h = H()
def read_x(obj):
    return obj.x

for _ in range(20_000):
    read_x(h)

# 热身后 adaptive dis 显示:
# LOAD_ATTR_NONDESCRIPTOR_WITH_VALUES
```

`NONDESCRIPTOR_WITH_VALUES` 的守卫是两把锁：类型版本号（类的属性集没变过）+ 值数组的键版本。守卫命中时，一次比较换掉整场 MRO 仲裁。而同样这段代码在 3.12.13 上热身十万次也停留在通用 `LOAD_ATTR`——3.12 的这套特化只覆盖纯实例字典路径（`self.x` 在 `__init__` 里赋值的场景可特化为 `LOAD_ATTR_INSTANCE_VALUE`，3.12 与 3.14 都支持）；“类体普通属性 + inline values”的形态是 3.13/3.14 才纳入的。又一次版本边界：**特化覆盖面在扩大，但任何一版的具体形态都只是当期事实**。

属性写入同样有 `STORE_ATTR` 特化：slot 偏移可缓存成 `STORE_ATTR_SLOT`（直接按 offset 存指针），而 PROPERTY、METHOD、READ_ONLY 等类别直接放弃特化——快路只做无争议的事，有语义风险的写路径交给通用仲裁。

## 类型与模块：点号的另外两条路

以上全程假设 `tp_getattro == PyObject_GenericGetAttr`。两条常见的岔路值得标记：

**类身上的点号**（`Plain.attr_plain`）走 `type.__getattribute__`（`_Py_type_getattro`）：仲裁照旧，但“实例存储”换成了“元类链查找”——找类属性先查类自己的 MRO，找不到再问元类。所以 `SomeClass.__name__` 拿到的是元类提供的 data 描述符产物。

**模块身上的点号**（`m.v`）走 `module_getattro`：普通属性查模块 `__dict__`，落空后还要翻一遍 `__getattr__` 钩子与系统级模块属性。`LOAD_ATTR` 特化对模块有专门的 `LOAD_ATTR_MODULE` 形态，守卫正是 dict 篇讲过的模块键表版本号——一篇的机制在下一篇当守卫用，这就是这个系列的咬合方式。

## 边界

**优先级是四层，不是两层。** data 描述符 > 实例存储 > non-data 描述符 > 普通类属性；data/non-data 的分界是有无 `__set__`。

**仲裁的入口可以整体替换。** `__getattribute__` 占据 `tp_getattro`，改的是全部规则；`__getattr__` 只在仲裁落空后兜底。

**`__slots__` 是成员描述符接管读写。** 固定偏移的 data 描述符既省内存（无字典）又保边界（写不进没登记的名字）；基类不带 slots 时防线从继承处漏开。

**`property` 永远是 data 描述符。** 没写 setter 也有 `tp_descr_set`（抛错的那个）；类访问得到 property 对象本身，来自 `__get__(None, type)` 返回自身的协议约定。

**方法绑定、staticmethod、classmethod 都是第 4 层住户。** 绑定即 `__get__(obj, type)`；它们与用户描述符服从同一张优先级表。

**super 不改规则，只改起点。** 沿实例的 MRO 从 `su_type` 之后找；零参 super 是编译器填好的 `__class__` cell + `self`，`__class__` 绑定词法类，与运行时类型无关。

**特化缓存的是“落在哪一层”。** 守卫由类型版本号与键版本号构成；覆盖面逐版扩大（3.12 → 3.14 的 NONDESCRIPTOR_WITH_VALUES），任何形态都不是永久承诺。

**类与模块的点号走各自的路。** 元类链与模块 `__getattr__` 是 `GenericGetAttr` 之外的两套 `tp_getattro`，优先级表不适用于它们。

---

```text
点号落下，先问类型。
类型说：我这里有个带锁的管家——你不用进屋了。
没有管家，才轮到实例自己的账本。
账本也没有，看看有没有只读的介绍人。
介绍人也没有，还剩一条普通的类属性。
都空着，这才轮到 __getattr__ 叹一口气。
```

系列的伏笔到这里收束：对象布局篇的 inline values，是仲裁第 3 层的存储；dict 篇的共享键表与版本号，是这一篇特化守卫的两把锁；str 篇的驻留，是 MRO 查找里指针短路的前提；类型槽篇的“实例属性进不了特殊方法通道”，说的正是 `tp_getattro` 与 `tp_nb_add` 各管各的门。

CPython 的主线机制——对象怎么活、怎么住、怎么跑、怎么快、怎么让、怎么并发，加上 dict、str、属性这三块地基——到这里已经连成一张完整的网。往后要么开新方向（异常表、import 机制、sys.monitoring 这些还没动过的子系统），要么等 3.16 的开发分支再长出新的故事。等想写了再说。
