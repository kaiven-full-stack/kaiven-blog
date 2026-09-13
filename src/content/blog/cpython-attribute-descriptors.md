---
title: 点号的四层优先级：CPython 的属性查找与描述符协议
description: 同名属性上，实例字典压过普通类属性，data 描述符又压过实例字典；`__slots__`、`property`、方法绑定、`super()` 全部由同一套查找规则驱动。本文从 `obj.x` 的完整链路出发，拆开 `_PyObject_GenericGetAttrWithDict` 的四层优先级、MRO 查找、零参 super 的 `__class__` cell 与 LOAD_ATTR 特化，讲清描述符层级、绑定时机与版本号失效各自的来源。实验数据来自 CPython 3.14.7，并对照 3.12.13 与 3.16.0a0 源码。
pubDate: 2026-09-10T11:30:00+08:00
category: cpython
tags: [CPython, 编程语言, 面向对象]
---

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 150" role="img" aria-label="同名属性三场对抗的实测结果：实例字典对普通类属性，实例赢；对 non-data 描述符，实例赢；对 data 描述符，类上的描述符赢，连写都被拦下" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三场同名对抗（CPython 3.14.7 实测）</text>
<text class="ts" x="20" y="52" font-size="11" fill="#6b675e">实例字典有 x，类上有普通 x</text>
<rect class="bx-q" x="330" y="38" width="130" height="22" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="395" y="53" text-anchor="middle" font-size="10" fill="#6b675e">实例赢</text>
<text class="ts" x="20" y="84" font-size="11" fill="#6b675e">实例字典有 x，类上有 non-data x</text>
<rect class="bx-q" x="330" y="70" width="130" height="22" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="395" y="85" text-anchor="middle" font-size="10" fill="#6b675e">实例赢</text>
<text class="ts" x="20" y="116" font-size="11" fill="#6b675e">实例字典有 x，类上有 data x</text>
<rect class="bx-sick" x="330" y="102" width="300" height="22" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="480" y="117" text-anchor="middle" font-size="10" fill="#b03a2e">类上的描述符赢：读被接管，写都被拦下</text>
<text class="ts" x="20" y="144" font-size="12" fill="#6b675e">点号背后不是一张查找表，是一套有优先级的查找规则</text>
</svg>
</figure>

三条结论在 CPython 3.14.7 上验证过：

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

`o.d = "instance-value"` 甚至没有进实例字典，data 描述符连写都拦了。点号背后不是一张查找表，是一套有优先级的查找规则。

前几篇已经为这里做过铺垫：对象布局篇讲过实例的 inline values 与 managed dict，dict 篇拆透了共享键表与值数组，str 篇解释了属性名的驻留与哈希缓存，类型槽篇说过「实例属性进不了特殊方法通道」。这一篇把 `obj.x` 的完整链路走通。

本文实验跑在 CPython 3.14.7（x86_64 Linux，64 位，默认 GIL，非 debug 构建）上，并与 CPython 3.12.13 对照。源码结构同时核对本地一份标记为 CPython 3.16.0a0 的开发快照，该目录没有 Git 元数据，绑定不到具体提交。优先级次序与描述符协议属于 Python 语义层（数据模型），具体实现路径与特化形态是版本事实。

## `obj.x` 的查找顺序

`obj.x` 在字节码层是 `LOAD_ATTR`。通用路径（`PyObject_GetAttr`）先问类型的 `tp_getattro` 槽；普通类的这个槽指向 `PyObject_GenericGetAttr`，落到 `_PyObject_GenericGetAttrWithDict`，即本文的主角。它的工作按固定次序进行：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="obj.x 的六步查找流程：先沿 MRO 找 x 暂存为 descr；descr 是 data 描述符就立刻调用 __get__ 返回；否则查实例存储，找到返回；没有再试 non-data 描述符的 __get__；再没有就返回普通类属性；全落空抛 AttributeError" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="attrAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">_PyObject_GenericGetAttrWithDict 的固定次序</text>
<rect class="bx-q" x="40" y="36" width="380" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="230" y="57" text-anchor="middle" font-size="11" fill="#6b675e">① 沿 MRO 在类型链上找 x → 找到暂存为 descr</text>
<line class="fl" x1="230" y1="70" x2="230" y2="80" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<rect class="bx-sick" x="40" y="84" width="380" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="230" y="105" text-anchor="middle" font-size="11" fill="#6b675e">② descr 是 data 描述符？（tp_descr_set != NULL）</text>
<line class="fl" x1="420" y1="101" x2="466" y2="101" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<text class="ts" x="440" y="92" text-anchor="middle" font-size="10" fill="#6b675e">是</text>
<rect class="bx-sick" x="470" y="84" width="170" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="555" y="105" text-anchor="middle" font-size="10" fill="#b03a2e">调 __get__ 返回，全程结束</text>
<line class="fl" x1="230" y1="118" x2="230" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<text class="ts" x="238" y="130" font-size="10" fill="#6b675e">否：记下 __get__ 继续</text>
<rect class="bx" x="40" y="136" width="380" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="230" y="157" text-anchor="middle" font-size="11" fill="#6b675e">③ 查实例存储：inline values / managed dict / __dict__</text>
<line class="fl" x1="420" y1="153" x2="466" y2="153" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<text class="ts" x="440" y="144" text-anchor="middle" font-size="10" fill="#6b675e">找到</text>
<rect class="bx-q" x="470" y="136" width="170" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="555" y="157" text-anchor="middle" font-size="10" fill="#6b675e">返回实例值</text>
<line class="fl" x1="230" y1="170" x2="230" y2="184" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<text class="ts" x="238" y="182" font-size="10" fill="#6b675e">没找到</text>
<rect class="bx" x="40" y="188" width="380" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="230" y="209" text-anchor="middle" font-size="11" fill="#6b675e">④ descr 有 __get__（non-data 描述符）→ 调用返回</text>
<line class="fl" x1="230" y1="222" x2="230" y2="232" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<rect class="bx" x="40" y="236" width="380" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="230" y="257" text-anchor="middle" font-size="11" fill="#6b675e">⑤ descr 是普通类属性 → 直接返回</text>
<line class="fl" x1="230" y1="270" x2="230" y2="280" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs2)"/>
<rect class="bx-gone" x="40" y="284" width="380" height="34" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="230" y="305" text-anchor="middle" font-size="11" fill="#6b675e">⑥ 都没有 → AttributeError（__getattr__ 在抛出前兜底）</text>
<text class="tc" x="470" y="250" font-size="11" fill="#b03a2e">四层优先级：</text>
<text class="tc" x="470" y="268" font-size="11" fill="#b03a2e">data 描述符 &gt; 实例存储</text>
<text class="tc" x="470" y="286" font-size="11" fill="#b03a2e">&gt; non-data &gt; 普通类属性</text>
</svg>
</figure>

四层优先级一目了然：data 描述符 > 实例存储 > non-data 描述符 > 普通类属性。data/non-data 的分界线只有一个 C 判断：

```c
PyDescr_IsData(ob)  ==  (Py_TYPE(ob)->tp_descr_set != NULL)
```

有 `__set__`（或 `__delete__`）就是 data 描述符，与 `__get__` 写得多花哨无关。这个判定的直觉是：能控制写的对象，才有资格控制读；否则实例字典的写会绕过它、读却要听它的，状态就撕裂了。

第 3 步的「实例存储」在现代 CPython 里是三级形态：inline values（值数组内联在实例主体，dict 篇的主角）、managed dict（按需物化的 `__dict__`）、老式 `__dict__` 指针。对本文的优先级讨论，三者等价，都是实例自己持有的属性存储。

## 用日志描述符验证查找顺序

上一节的顺序不需要盲信源码，让每层留下记录：

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

对三类属性分别做「读一次 → 实例赋值 → 再读一次」，LOG 的轨迹完整还原查找过程：

```text
普通类属性：    读 = 类值；实例赋值后读 = 实例值          （第 3 层压过第 4 层）
non-data：     读 = nondata.get；实例赋值后读 = 实例值    （第 3 层压过第 3.5 层）
data：         读 = data.get；实例赋值 → LOG 记下 data.set，
               实例字典里根本没有这个键；再读 = data.get   （第 2 层压过第 3 层）
```

data 描述符的拦截是双向的：`__set__` 吞掉写请求，`__get__` 接管所有读。实例字典连「试一试」的机会都没有。这正是 `property`、`__slots__` 能严守边界的原因。

## `__slots__`：一组天生的 data 描述符

`__slots__` 的机制在类创建时就定型了。`type_new_descriptors` 把每个 slot 名字登记为一张成员表（`tp_members`）里的 `Py_T_OBJECT_EX` 条目，内容是固定偏移；类字典里对应的则是一个成员描述符：

```python
class P:
    __slots__ = ("x", "y")

print(P.x)        # <member 'x' of 'P' objects>
print(type(P.x))  # member_descriptor
```

成员描述符有 `tp_descr_get` 也有 `tp_descr_set`（`member_get`/`member_set` 按 offset 读写实例主体），是标准 data 描述符。所以 slot 名字的读写全部走第 2 层：读 = 从偏移处取指针，写 = 往偏移处存指针。所谓「slots 实例没有 `__dict__`」，准确说是没有通用属性字典、只有固定槽位；访问没登记的名字自然 AttributeError：

```text
p.z = 1
AttributeError: 'P' object has no attribute 'z' and no __dict__ for setting new attributes
```

错误消息后半句（3.14 起更明确）点破了机制：写不进来，是因为既没有 slot 偏移、又没有字典可存。

slots 的机制与它的漏洞：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="slots 机制两联图：左边类字典里每个 slot 名字对应一个 member_descriptor，按固定偏移直接读写实例主体，没有通用字典，写没登记的名字报 AttributeError；右边基类没有 slots 时自带 managed dict，子类声明 slots 也挡不住继承来的字典，b.anything 畅通无阻" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="attrAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一组天生的 data 描述符，和一道继承来的口子</text>
<rect class="bx" x="20" y="40" width="300" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="170" y="60" text-anchor="middle" font-size="12" fill="#2b2a26">class P: __slots__ = ("x", "y")</text>
<rect class="bx-q" x="36" y="70" width="268" height="26" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="170" y="87" text-anchor="middle" font-size="10" fill="#6b675e">类字典：x → member_descriptor（固定偏移）</text>
<line class="fl" x1="170" y1="96" x2="170" y2="110" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs3)"/>
<rect class="bx" x="36" y="114" width="60" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="66" y="131" text-anchor="middle" font-size="9" fill="#6b675e">对象头</text>
<rect class="bx-q" x="96" y="114" width="60" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="126" y="131" text-anchor="middle" font-size="9" fill="#6b675e">x · 偏移</text>
<rect class="bx-q" x="156" y="114" width="60" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="186" y="131" text-anchor="middle" font-size="9" fill="#6b675e">y · 偏移</text>
<rect class="bx-gone" x="216" y="114" width="88" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="260" y="131" text-anchor="middle" font-size="9" fill="#6b675e">无通用字典</text>
<text class="tc" x="170" y="164" text-anchor="middle" font-size="10" fill="#b03a2e">p.z = 1 → AttributeError：</text>
<text class="ts" x="170" y="180" text-anchor="middle" font-size="10" fill="#6b675e">没有偏移可存，也没有字典可放</text>
<rect class="bx" x="340" y="40" width="300" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="490" y="60" text-anchor="middle" font-size="12" fill="#2b2a26">class B(A)，A 没有 slots</text>
<rect class="bx-q" x="356" y="70" width="268" height="26" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="490" y="87" text-anchor="middle" font-size="10" fill="#6b675e">基类 A：实例自带 managed dict 标志</text>
<rect class="bx-q" x="356" y="102" width="268" height="26" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="490" y="119" text-anchor="middle" font-size="10" fill="#6b675e">子类 B：__slots__ = ("x",) 只有 x 进槽</text>
<rect class="bx-sick" x="356" y="134" width="268" height="26" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="490" y="151" text-anchor="middle" font-size="10" fill="#b03a2e">b.anything = 2：畅通无阻，进继承来的 __dict__</text>
<text class="ts" x="490" y="180" text-anchor="middle" font-size="10" fill="#6b675e">防线从继承处漏开</text>
<text class="ts" x="20" y="216" font-size="12" fill="#6b675e">读写全走第 2 层：member_get / member_set 按 offset 直接存取实例主体</text>
</svg>
</figure>

继承会破坏这层严防。基类没有 `__slots__` 时，它已经带了 managed dict 标志；子类哪怕声明了自己的 slots，也挡不住从基类继承的字典：

```python
class A: pass              # 无 slots，实例带 __dict__

class B(A):
    __slots__ = ("x",)

b = B()
b.x = 1
b.anything = 2             # 畅通无阻，进了继承来的 __dict__
print(b.__dict__)          # {'anything': 2}
```

对象布局篇测过 slots 的内存收益；这一篇补上机制：属性读写被固定偏移的描述符接管，通用字典就不需要了。

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

没写 setter 的 property 也有 `tp_descr_set`（那个会抛 `AttributeError: can't set attribute` 的实现），所以它永远按 data 描述符参与查找。类身上直接访问 `T.value` 得到 property 对象本身：`__get__` 收到 `obj=None` 时按协议返回自身。类访问拿到工具本身、实例访问拿到计算结果，出处都是这一条协议。

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

`staticmethod` 的 `__get__` 无视 obj 直接返回裸函数，`classmethod` 的 `__get__` 把 cls 绑进去。三者都位于协议的第 4 层，服从同一个优先级表。

## `__getattribute__`：唯一能改规则的地方

想劫持点号本身，唯一入口是 `__getattribute__`：它在第 0 层，`tp_getattro` 槽被你的实现占据，`_PyObject_GenericGetAttrWithDict` 根本不会被调用：

```python
class G:
    def __getattribute__(self, name):
        print(f"  [hook] {name}")
        return object.__getattribute__(self, name)
```

每次属性访问都会经过这里，包括钩子自己要调的 `object.__getattribute__` 里的每一步。这也解释了为什么 `__getattr__`（找不到才调）几乎总是比 `__getattribute__`（每次都调）更合适：前者只是在查找全部落空后追加一层，不扰动优先级。

`__getattr__` 的挂载点不在字节码层，而在类型槽：类里定义了 `__getattr__` 时，`update_one_slot` 给这个类装的是 `_Py_slot_tp_getattr_hook`，先走常规查找，落空时在 AttributeError 抛出前把机会转给 `__getattr__`；只有 `__getattribute__` 时装的是更简单的 `_Py_slot_tp_getattro`。所以两个钩子的真实分工是：一个换掉全部规则，一个只在落空后追加一层。

## super：换一条起跑线的同一场查找

`super()` 不创建新规则，它只是换掉 MRO 的起点。`do_super_lookup` 从 `su_obj_type` 的 MRO 里、`su_type` 之后的位置开始找；找到后照常走描述符协议：

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

`D().who()` 的调用链值得走一遍：D 的 super 沿 MRO 找到 B.who；B.who 里的 super 沿的是 D 实例的 MRO（不是 B 的），越过 B 找到 C.who；C 的 super 再找到 A.who。菱形继承里 `B` 和 `C` 都能被穿越，靠的就是「MRO 属于实例的类，不属于当前方法所在的类」。`D+B+C+A` 这行输出正是 C3 线性化的结果。

同一条 MRO，三个起跑点：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="super 沿 D 实例的 MRO 换起跑线：MRO 是 D、B、C、A、object；D.who 里的 super 从 D 之后起步找到 B.who；B.who 里的 super 沿的仍是 D 的 MRO，越过 B 找到 C.who 而不是 A；C 的 super 再找到 A.who，输出 D+B+C+A" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="attrAs4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="attrAc4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">D.__mro__ = (D, B, C, A, object)：super 只换起跑线</text>
<rect class="bx-q" x="30" y="44" width="90" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="75" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">D</text>
<line class="fl" x1="120" y1="62" x2="146" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs4)"/>
<rect class="bx" x="150" y="44" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="195" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">B</text>
<line class="fl" x1="240" y1="62" x2="266" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs4)"/>
<rect class="bx" x="270" y="44" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="315" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">C</text>
<line class="fl" x1="360" y1="62" x2="386" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs4)"/>
<rect class="bx" x="390" y="44" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="435" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">A</text>
<line class="fl" x1="480" y1="62" x2="506" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#attrAs4)"/>
<rect class="bx-gone" x="510" y="44" width="110" height="36" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="565" y="66" text-anchor="middle" font-size="11" fill="#6b675e">object</text>
<path class="flc" d="M75 84 L75 96 L195 96 L195 86" fill="none" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#attrAc4)"/>
<text class="tc" x="135" y="112" text-anchor="middle" font-size="10" fill="#b03a2e">D.who 里的 super：从 D 之后起步 → B.who</text>
<path class="flc" d="M195 120 L195 132 L315 132 L315 86" fill="none" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#attrAc4)"/>
<text class="tc" x="255" y="148" text-anchor="middle" font-size="10" fill="#b03a2e">B.who 里的 super：沿的还是 D 的 MRO，越过 B → C.who（不是 A）</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">零参 super 的 __class__ 是编译期填好的 cell，绑定词法类：起点永远是 B 之后，哪怕实例是 D</text>
<text class="ts" x="20" y="194" font-size="12" fill="#6b675e">输出 D+B+C+A：菱形继承里 B 和 C 都被穿越，每个 A 只执行一次</text>
</svg>
</figure>

零参 `super()` 的答案在编译期。反汇编 `Sub.run`：

```text
LOAD_GLOBAL              0 (super)
LOAD_DEREF               1 (__class__)
LOAD_FAST_BORROW         0 (self)
LOAD_SUPER_ATTR          5 (run + NULL|self)
```

零参 super 其实是双参 super：编译器把 `__class__` 和 `self` 显式填进调用。`__class__` 是一个闭包自由变量（`co_freevars` 里躺着 `('__class__',)`，帧篇讲过的 cell 对象在这里用上），它绑定的是词法上包含这个方法的类，与 `type(self)` 无关。这就是为什么在 B 的方法里，super 的起点永远是 B 之后，哪怕实例的真实类型是子类 D。

`super_getattro` 里还有一行特判：`super().__class__` 返回 super 对象自己的类，不是 `su_obj` 的类，否则 super 对象连自己的类型都报不出来。

## 特化：查找也要有快路

四层查找是一场不小的开销：MRO 查找、描述符判定、字典访问。`LOAD_ATTR` 的特化把「这个点号通常落在哪一层」缓存进内联缓存。specialize.c 先把属性归类（`DescriptorClassification` 十余种：OVERRIDING / PROPERTY / OBJECT_SLOT / METHOD / NONDESCRIPTOR / ABSENT……），再按类选择专用形态：

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

`NONDESCRIPTOR_WITH_VALUES` 的守卫是两把锁：类型版本号（类的属性集没变过）+ 值数组的键版本。守卫命中时，一次比较换掉整场 MRO 查找。而同样这段代码在 3.12.13 上热身十万次也停留在通用 `LOAD_ATTR`：3.12 的这套特化只覆盖纯实例字典路径（`self.x` 在 `__init__` 里赋值的场景可特化为 `LOAD_ATTR_INSTANCE_VALUE`，3.12 与 3.14 都支持），「类体普通属性 + inline values」的形态是 3.13/3.14 才纳入的。又一次版本边界：特化覆盖面在扩大，但任何一版的具体形态都只是当期事实。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="LOAD_ATTR 特化：通用路径每次做 MRO 查找加描述符判定加字典访问；热身后换成专用形态，守卫是类型版本号与值数组键版本两把锁，命中时一次比较换掉整场查找，失败退回通用路径" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="attrAs5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">查找的快路：把「通常落在哪一层」缓存进内联缓存</text>
<rect class="bx" x="20" y="40" width="250" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="145" y="60" text-anchor="middle" font-size="11" fill="#6b675e">通用 LOAD_ATTR</text>
<text class="ts" x="145" y="78" text-anchor="middle" font-size="10" fill="#6b675e">MRO 查找 + 描述符判定 + 字典访问</text>
<line class="fl" x1="270" y1="64" x2="326" y2="64" stroke="#6b675e" stroke-width="1.5" marker-end="url(#attrAs5)"/>
<text class="ts" x="298" y="54" text-anchor="middle" font-size="10" fill="#6b675e">热 2 万次</text>
<rect class="bx-q" x="330" y="40" width="310" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="485" y="60" text-anchor="middle" font-size="11" fill="#2b2a26">NONDESCRIPTOR_WITH_VALUES</text>
<text class="ts" x="485" y="78" text-anchor="middle" font-size="10" fill="#6b675e">守卫① 类型版本号　守卫② 值数组键版本</text>
<text class="ts" x="20" y="118" font-size="11" fill="#6b675e">两把锁都命中：</text>
<text class="tc" x="130" y="118" font-size="11" fill="#b03a2e">一次比较换掉整场 MRO 查找</text>
<text class="ts" x="350" y="118" font-size="11" fill="#6b675e">任一守卫失败：退回通用路径重新走</text>
<text class="ts" x="20" y="148" font-size="12" fill="#6b675e">STORE_ATTR 同理：SLOT 偏移可特化，PROPERTY / METHOD / READ_ONLY 直接放弃</text>
<text class="ts" x="20" y="168" font-size="12" fill="#6b675e">快路只做无争议的事，有语义风险的写路径交给通用查找</text>
</svg>
</figure>

属性写入同样有 `STORE_ATTR` 特化：slot 偏移可缓存成 `STORE_ATTR_SLOT`（直接按 offset 存指针），而 PROPERTY、METHOD、READ_ONLY 等类别直接放弃特化。快路只做无争议的事，有语义风险的写路径交给通用查找。

## 类型与模块：点号的另外两条路

以上全程假设 `tp_getattro == PyObject_GenericGetAttr`。两条常见的岔路值得标记。

类身上的点号（`Plain.attr_plain`）走 `type.__getattribute__`（`_Py_type_getattro`）：查找照旧，但「实例存储」换成了「元类链查找」，找类属性先查类自己的 MRO，找不到再问元类。所以 `SomeClass.__name__` 拿到的是元类提供的 data 描述符产物。

模块身上的点号（`m.v`）走 `module_getattro`：普通属性查模块 `__dict__`，落空后还要翻一遍 `__getattr__` 钩子与系统级模块属性。`LOAD_ATTR` 特化对模块有专门的 `LOAD_ATTR_MODULE` 形态，守卫正是 dict 篇讲过的模块键表版本号：一篇的机制在下一篇当守卫用。

---

## 四层优先级回顾

优先级是四层：data 描述符 > 实例存储 > non-data 描述符 > 普通类属性，data/non-data 的分界是有无 `__set__`。查找的入口可以整体替换：`__getattribute__` 占据 `tp_getattro`，改的是全部规则；`__getattr__` 只在落空后兜底。

`__slots__` 是固定偏移的成员描述符接管读写，既省内存又守住边界，写不进没登记的名字；基类不带 slots 时，防线从继承处漏开。`property` 永远是 data 描述符，没写 setter 也有 `tp_descr_set`；类访问得到 property 对象本身，来自 `__get__(None, type)` 返回自身的协议约定。方法绑定、staticmethod、classmethod 都在第 4 层，与用户描述符服从同一张优先级表。

super 不改规则，只改起点：沿实例的 MRO 从 `su_type` 之后找；零参 super 是编译器填好的 `__class__` cell 加 `self`，`__class__` 绑定词法类，与运行时类型无关。特化缓存的是「落在哪一层」，守卫由类型版本号与键版本号构成，覆盖面逐版扩大（3.12 到 3.14 的 NONDESCRIPTOR_WITH_VALUES），任何形态都不是永久承诺。类与模块的点号走各自的 `tp_getattro`：元类链与模块 `__getattr__`，优先级表不适用于它们。

前几篇的机制在这里各就各位：对象布局篇的 inline values 是第 3 层的存储，dict 篇的共享键表与版本号是本篇特化守卫的两把锁，str 篇的驻留是 MRO 查找里指针短路的前提，类型槽篇的「实例属性进不了特殊方法通道」，说的正是 `tp_getattro` 与 `tp_nb_add` 各管各的入口。
