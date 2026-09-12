---
title: 名字已经划掉，住客还没退房：CPython 的引用计数与循环垃圾回收
description: del 删掉的是名字绑定，不是一条直接销毁对象的命令。本文从一份还在使用的“已删除”对象出发，沿引用计数、循环垃圾回收、弱引用、对象复活与资源释放一路追下去，分清名字消失、对象终结和内存归还各自发生在何时。文中实验在 CPython 3.14.7 上完成。
pubDate: 2026-09-07
category: cpython
tags: [CPython, 编程语言]
---

名字已经删掉，对象还活着。先看几行代码：

```python
guest = ["一把伞", "半本书"]
room_207 = guest

del guest
print(room_207)
```

```text
['一把伞', '半本书']
```

再去找原来的名字，Python 会拒绝：

```python
print(guest)
```

```text
NameError: name 'guest' is not defined
```

`guest` 确实被删掉了，列表也确实还活着。矛盾只存在于一句不够准确的话里：我们常说“`del` 删除对象”，实际被划掉的是一个名字与对象之间的绑定。只要别处还握着引用，对象便没有退房。

名字消失、对象不可达、终结器运行、内存被分配器回收，不是同一个时刻。

这篇以 CPython 3.14.7、x86_64 Linux 的默认 GIL 构建为主，文内代码和输出均在本机复核，部分行为又与 CPython 3.12.13 做了对照。引用计数、垃圾回收步骤和源码符号是 CPython 的实现事实，不是所有 Python 实现都必须照搬的语言承诺。

## `del` 划掉的是绑定

Python 语言参考对删除名字说得很直接：

> Deletion of a name removes the binding of that name from the local or global namespace, depending on whether the name occurs in a global statement in the same code block.

变量不是装着对象的盒子，更接近贴在对象上的一张名牌。赋值可以让两张名牌指向同一个对象：

```python
guest = ["一把伞", "半本书"]
room_207 = guest
```

此刻没有第二份列表，只有两条引用：

```text
名字 guest ──────┐
                  ├──> 同一个 list 对象
名字 room_207 ───┘
```

执行 `del guest` 后，第一条线被撤掉：

```text
名字 room_207 ───────> 原来的 list 对象
```

所以 `room_207` 仍能访问列表，`guest` 则成为一个未绑定的名字。`del` 也可以删除容器中的一项或对象的属性：

```python
# 示意：两条语句都要求相应容器或对象已经存在。
del rooms[207]
del hotel.current_guest
```

这些语句最终改变的是容器或对象保存的引用。被引用的对象是否因此死亡，要看那是不是最后一条拥有关系。

这也解释了为什么下面两句不能互换：

```python
guest = None
del guest
```

第一句让名字继续存在，只是改为指向单例 `None`；第二句让名字本身不再绑定。二者都可能减少旧对象的一条引用，却表达不同的命名空间状态。

语言只规定名字删除后的可见行为。至于旧对象何时回收，交给具体实现。到了 CPython，这个问题首先落在每个对象随身携带的一本账上。

## 引用计数是一份动态账本

CPython 对象头中保存引用计数。一个新的强引用成立，计数增加；一条强引用撤销，计数减少。概念上可以写成：

```text
建立强引用    ob_refcnt += 1
撤销强引用    ob_refcnt -= 1
计数归零      进入对象的释放路径
```

C API 把这套操作暴露为 `Py_INCREF()` 与 `Py_DECREF()`。后者不只是做减法：若减完变成零，它会调用 `_Py_Dealloc()`，由后者取出类型 `tp_dealloc` 槽上注册的析构函数执行，让对象清理自己持有的引用并释放存储。

拿一层容器包住对象，就会多出一笔：

```python
import sys

class Token:
    pass

token = Token()
print(sys.getrefcount(token))

holder = [token]
print(sys.getrefcount(token))

holder.clear()
print(sys.getrefcount(token))
```

CPython 3.14.7 的输出是：

```text
2
3
2
```

`holder` 持有对象时，计数由 2 变成 3；清空列表后，又回到 2。不过这里的 2 已经暴露了观察工具本身的影响：源代码里明明只看见 `token` 一条长期引用。

引用计数不是“有几个变量名”的计数。列表元素、字典值、函数参数、闭包、实例属性、正在执行的栈帧，都可能持有引用。反过来，一个名字也不保证自己独占对象。判断对象为何还活着，不能只在当前几行代码里数变量。

更重要的是，这本账只解释 CPython 的一条实现路径。PyPy 等实现可以采用不同的回收策略；Python 程序不应把“某行之后必定立即析构”当作跨实现契约。

## 观察账本，也会添上一笔

`sys.getrefcount(object)` 的官方说明专门提醒：

> The count returned is generally one higher than you might expect, because it includes the (temporary) reference as an argument to getrefcount.

调用函数时，待观察对象本身作为参数来到 `getrefcount()`，这条临时引用也被数进结果。因此前一个实验里的 2，可以理解为：

```text
名字 token 的引用          1
getrefcount 临时参数引用    1
返回结果                    2
```

但不要把这张算式扩展成“以后每一层函数调用都固定加一”。CPython 3.14 会在解释器内部尽量借用操作数栈上的引用，减少不必要的增减计数；同一段探针跨版本可能看到不同数字。`getrefcount()` 适合证明“多了一条持有关系”，不适合把某个瞬时值当作稳定接口。

还有一类数字更加显眼：

```python
print(sys.getrefcount(None))
print(sys._is_immortal(None))
print(sys._is_immortal(token))
```

本次输出：

```text
3221225472
True
False
```

`None`、`True` 等常驻对象在现代 CPython 中可以是 immortal object。它们的引用计数使用特殊值，普通增减不会决定其生死。CPython 3.12 和 3.14 的具体哨兵值也不相同，所以这个巨大数字不表示程序真的保存了三十多亿条 `None` 引用。

## 最后一条普通引用离开时

引用计数最直观的优点，是许多对象能在最后一条普通引用撤销时立即进入终结路径。可以用 `__del__` 和弱引用旁观：

```python
import weakref

class Guest:
    def __del__(self):
        print("__del__")

guest = Guest()
watch = weakref.ref(
    guest,
    lambda _: print("weakref callback"),
)

del guest
print("watch:", watch())
```

CPython 3.14.7 的输出如下：

```text
__del__
weakref callback
watch: None
```

没有显式调用垃圾回收器。`del guest` 撤销最后一条强引用，计数归零，对象就在这条执行路径上完成终结。弱引用不会增加强引用计数，因此不能替对象续住生命；对象离开以后，调用 `watch()` 只会得到 `None`。

这份即时性很方便，却不能被误写成下面这条等式：

```text
del guest == guest.__del__()
```

数据模型的原话是：

> `del x` doesn't directly call `x.__del__()` — the former decrements the reference count for `x` by one, and the latter is only called when `x`'s reference count reaches zero.

而且 `__del__` 不是 C++ 意义上可预测、可安全安排的普通析构函数。它运行时可能处于任意线程，内部抛出的异常只会写到标准错误后被忽略；解释器关闭时，依赖的模块全局变量也可能已经清理。把数据库提交、锁释放或文件落盘押在这里，等于把正确性交给一条不够稳固的退路。

此处观察到的“`__del__` 在弱引用回调之前”也不是所有死亡路径的统一次序。等循环垃圾回收器进场，同一对旁观者会反过来发言。

## 两位住客互相写进了登记册

引用计数有一道天然难题：一个已经从程序入口消失的环，内部计数仍可能大于零。

```python
class Node:
    def __init__(self, name):
        self.name = name
        self.peer = None

left = Node("left")
right = Node("right")

left.peer = right
right.peer = left
```

引用关系现在是：

```text
名字 left ──> left 对象 ──peer──> right 对象
名字 right ─> right 对象 ─peer──> left 对象
```

撤销两个外部名字：

```python
del left, right
```

程序已经没有路径能再取回这两个对象，但它们仍互相引用。各自的引用计数都没有归零：

```text
left 对象  <──────>  right 对象
     外部已经不可达，内部仍各记一笔
```

只看各自的引用计数，每个对象都能说“还有人引用我”；站到整个对象图之外，才看得见这两笔引用形成一座封闭小岛。

这正是循环垃圾回收器存在的理由。它不取代引用计数，只处理引用计数单独解不开的环。

## 垃圾回收器寻找封闭的小岛

CPython 会追踪那些可能参与引用环的容器对象。一次循环回收，可以粗略理解为：

```text
选出一批被追踪对象
      ↓
从各自引用计数中扣除“批次内部互相引用”
      ↓
仍有外部引用的对象及其可达对象：保留
只剩内部引用的封闭对象图：不可达垃圾
      ↓
处理弱引用与终结器，打断引用，再释放
```

这个过程的重点不在寻找“引用计数大于零”的对象，而在对象图中分辨哪些引用来自候选集合外部。环内两个对象互相引用，不能再被当成继续存活的外部担保。

做一次最小实验：

```python
import gc

class Node:
    def __init__(self, name):
        self.name = name
        self.peer = None

    def __del__(self):
        print("finalize", self.name)

gc.collect()

left = Node("left")
right = Node("right")
left.peer = right
right.peer = left

del left, right

print("collected:", gc.collect())
print("garbage:", gc.garbage)
```

输出是：

```text
finalize left
finalize right
collected: 2
garbage: []
```

开头那次 `gc.collect()` 用来清掉此前可能遗留的不可达对象，避免返回值混入无关结果。第二次回收发现两个对象；它们没有任何外部可达路径，于是完成终结与释放。

CPython 还按代组织被追踪对象，让新对象更频繁接受检查，长期存活者减少扫描频率。本机 CPython 3.14.7 的配置可以现场查看：

```python
print(gc.get_threshold())
```

```text
(2000, 10, 10)
```

这组数值属于当前版本和构建，不应写进业务判断。尤其要留意 3.14 的版本边界：3.14.0 到 3.14.4 曾采用新的增量式垃圾回收器，因生产环境内存压力报告，自 3.14.5 起又回到此前的分代回收设计。只说“Python 3.14 的 GC 是什么”已经不够精确，补丁版本也会改变答案。

## 不是所有对象都要进入巡检名单

引用计数作用于普通 CPython 对象，循环回收器却只需追踪可能成为环上一环的对象。

```python
import gc

print(gc.is_tracked(42))
print(gc.is_tracked([]))
```

在当前 CPython 中，整数这样的原子对象不会引用其他 Python 对象，不需要循环探测；列表即使为空或只装整数也会被追踪，真正避开追踪的典型是只含原子对象的元组。`gc.is_tracked()` 描述的是当前实现如何组织巡检名单。

这一区分能纠正一句常见描述：

```text
不够准确：Python 定期运行 GC，删除所有没用的对象。
更接近事实：CPython 用引用计数处理大部分生命周期，
            再用循环 GC 寻找被内部引用困住的不可达对象图。
```

垃圾回收器何时自动运行，要受分配活动、阈值和运行状态影响。`gc.collect()` 可以在测试中制造清晰边界，却不应该成为日常代码每做完一点工作就按一次的“清理按钮”。频繁全量回收可能花掉本可避免的扫描成本，也掩盖真正长期持有引用的位置。

## 带终结器的环，今天也能收走

很早以前，带 `__del__` 的循环引用很难安全决定终结顺序，常被放进 `gc.garbage` 留给程序处理。这个历史印象至今仍在不少文章里流传。

PEP 442 改变了这件事。自 Python 3.4 起，安全对象终结允许循环回收器处理带 `__del__` 的 Python 对象。前一个 `Node` 实验已经包含终结器，结果仍是：

```text
collected: 2
garbage: []
```

现代文档对 `gc.garbage` 的说明也划出了边界：正常情况下它应当大多为空，例外主要来自某些拥有非空 `tp_del` 槽的 C 扩展类型，或者程序主动打开 `gc.DEBUG_SAVEALL`。后者会故意把找到的不可达对象全部留在列表中，适合调试，却也会让它们继续存活。

```python
gc.set_debug(gc.DEBUG_SAVEALL)
```

这不是“更彻底地清理”，恰恰是“找到以后先别清理”。线上进程若忘记关闭，`gc.garbage` 自己就会变成一只不断收纳对象的箱子。

PEP 442 也没有让终结顺序变成业务协议。一个环里的多个 `__del__` 谁先运行，不应成为程序正确性的前提；终结器执行期间，对象图还可能复活。循环如今可以安全收走，不等于适合把关键资源交给它保管。

## 同样是死亡，两条告别路径次序相反

前面普通引用归零的实验输出是：

```text
__del__
weakref callback
```

把对象改成自环，再交给循环回收器：

```python
import gc
import weakref

class Ring:
    def __del__(self):
        print("__del__")

ring = Ring()
ring.self = ring
watch = weakref.ref(
    ring,
    lambda _: print("weakref callback"),
)

del ring
gc.collect()
```

CPython 3.14.7 输出却是：

```text
weakref callback
__del__
```

同一个类，同一类弱引用，只因死亡路径不同，发言次序便倒了过来。

普通零引用路径中，`Objects/typeobject.c` 的 `subtype_dealloc()` 会先尝试调用终结器；对象没有被复活，才继续清理弱引用。循环回收路径则由 `Python/gc.c` 组织，`handle_weakrefs()` 先清理弱引用并调用相应回调，`finalize_garbage()` 随后处理终结器，再检查是否有对象复活。

这不是建议程序利用先后顺序协调工作。恰恰相反，它说明“对象即将死亡时总会先做 X”是一项危险假设。弱引用回调适合维护旁路缓存和索引，不适合与 `__del__` 共同拼成一套隐蔽的事务协议。

源码路径也要写上版本。从 Python 2.0 引入循环回收到 3.12，核心一直位于 `Modules/gcmodule.c`；自 3.13 起，回收核心迁入 `Python/gc.c`，`gc` 模块接口仍留在 `Modules/gcmodule.c`。函数名和步骤会继续演进，文章能解释当前实现，不能替内部文件布局许下永久承诺。

## 告别时，对象可以把自己重新留下

终结器运行时，对象尚未完全消失。它甚至可以重新建立一条外部引用，让自己“复活”：

```python
import gc

saved = []

class Lazarus:
    def __del__(self):
        print("__del__ runs")
        saved.append(self)

obj = Lazarus()
obj.self = obj
del obj

print("collect #1:", gc.collect())
returned = saved.pop()
print("finalized:", gc.is_finalized(returned))

del returned
print("collect #2:", gc.collect())
```

本次输出：

```text
__del__ runs
collect #1: 0
finalized: True
collect #2: 1
```

第一次回收确实找到了自环，却没有把复活的对象计入已收集结果。`saved.append(self)` 在终结器里重新搭出一条外部路径，对象又回到程序手中。`gc.is_finalized()` 为 `True`，说明它已经走过终结步骤。

第二次撤掉引用后，对象终于可以回收，但当前 CPython 不会再次调用它的 `__del__`。所以输出里只有一次 `__del__ runs`。这项“只调用一次”是 CPython 当前实现行为；数据模型明确指出，复活对象再次销毁时是否再调用 `__del__`，属于实现相关事项。

对象复活让终结器变得更难推理：

- 终结器已经执行，对象却仍可被普通代码访问；
- 它持有的部分资源可能已经关闭，部分状态仍然存在；
- 第二次死亡不能指望终结器再收一次尾；
- 循环回收器还必须重新判断整座对象图是否恢复可达。

能够做到，不等于值得设计。一个需要在告别仪式上逃回程序的对象，通常已经把生命周期写得过于曲折。

## 真正留住对象的，常常不是眼前的名字

没有循环，也可能出现“明明 `del` 了，对象为何还活着”。原因往往藏在栈帧、异常 traceback、闭包或调试工具里。

下面的 `Marker` 只在函数局部变量中出现：

```python
import gc

saved_traceback = None

class Marker:
    def __del__(self):
        print("Marker leaves")

def fail():
    marker = Marker()
    raise RuntimeError("boom")

try:
    fail()
except RuntimeError as error:
    saved_traceback = error.__traceback__

print("after except")
gc.collect()
print("after collect")

saved_traceback = None
print("after clearing traceback")
```

输出：

```text
after except
after collect
Marker leaves
after clearing traceback
```

异常对象的 traceback 引用了出错栈帧，栈帧又保留当时的局部变量，`marker` 因此活了下来。强制 `gc.collect()` 也无能为力：这不是不可达垃圾，`saved_traceback` 仍从程序入口提供一条真实的可达路径。直到最后一条 traceback 引用撤销，`Marker` 才离开。

类似的持有者还有：

```text
缓存字典          ──> 业务对象
回调闭包          ──> 外层局部变量
生成器对象        ──> 暂停的执行帧
任务或 Future     ──> 异常与 traceback
调试器和分析器    ──> 被检查的对象
```

因此，内存排查的第一问是“从根对象到它还有哪条引用路径”，不是“GC 为什么不工作”。`gc.get_referrers()` 可以辅助调查，却会返回解释器正在使用的内部对象，调用探针本身也可能改变现场。它适合诊断，不适合成为生产业务逻辑。

垃圾回收器负责不可达对象；仍然可达但程序不再需要的对象，在回收器看来完全健康。

## 文件句柄不能等退房巡检

内存对象晚一点回收，常常只意味着多占一段空间；文件、锁、数据库事务和网络连接却有外部世界的期限。

考虑一个上下文管理器：

```python
class Door:
    def __enter__(self):
        print("open")
        return self

    def __exit__(self, kind, value, traceback):
        name = kind.__name__ if kind else None
        print("close:", name)
        return True

with Door():
    raise RuntimeError("rain")

print("after with")
```

输出：

```text
open
close: RuntimeError
after with
```

即使代码块抛出异常，`__exit__` 也在控制流离开 `with` 时执行。资源的获取与归还写在同一段结构里，不需要等待引用计数归零，更不需要猜下一轮循环回收何时到来。

未关闭文件在开发模式下会留下另一种警告：

```sh
python3 -X dev -c '
import gc
stream = open("/dev/null")
del stream
gc.collect()
'
```

```text
<string>:4: ResourceWarning: unclosed file <_io.TextIOWrapper name='/dev/null' mode='r' encoding='utf-8'>
ResourceWarning: Enable tracemalloc to get the object allocation traceback
```

这个例子可能因为 CPython 的引用计数而很快关闭底层文件，但警告仍然正确：程序没有明确完成资源协议。换到别的实现、引入一个环，或让引用被异常栈帧留住，释放时刻都会变化。

可靠的工程顺序应是：

```text
with / try...finally / 显式 close    负责按时归还外部资源
引用计数与循环 GC                   负责回收 Python 对象
进程退出清理                        只做最后兜底
```

解释器退出时也不保证为所有仍存活对象调用 `__del__`。`os._exit()` 更会直接跳过常规清理。把数据正确性寄托在“程序结束时总会帮我收尾”，是一份没有写进语言契约的承诺。

## 对象已经释放，不等于进程立刻变瘦

走到这里，还剩最后一层容易混淆的边界。

假设一个对象已经：

1. 不再可达；
2. 引用计数或循环回收确认它可以销毁；
3. 完成终结并把内存交还给 CPython 分配器。

操作系统看到的 RSS 仍不一定立刻下降。

CPython 为大量小对象使用 pymalloc。它把较大的 arena 切成 pool，再切成不同尺寸的 block。对象释放时，一个 block 可以回到池中供后续 Python 对象复用；只有满足更高层的空闲条件，整片 arena 才可能归还给系统。底层 `malloc` 实现也可以保留已释放区域，以便未来分配。

因此至少要区分四个时刻：

```text
T1 最后一条业务引用撤销
T2 引用计数或循环 GC 确认对象可回收
T3 对象存储回到 CPython / libc 分配器
T4 相应页面真正从进程 RSS 中回落
```

`gc.collect()` 最多推进与对象图有关的步骤，不是一条“把 RSS 还给操作系统”的命令。看到对象数量下降而 RSS 平稳，不能直接断言泄漏；看到 RSS 持续上升，也不能只用“分配器缓存”搪塞。要把 Python 对象保有量、分配器状态与操作系统页面分别测量。

下一篇再走进 `Objects/obmalloc.c`，看看一只仍然存活的小对象，如何让整座 arena 暂时不能退租。本篇只留下结论：对象生命结束，是内存回收链条的一站，不是终点。

## 生命周期留下的结论

`del` 保证的是删除目标，不是销毁对象：删除名字、属性或容器项都撤销一条绑定，对象是否死亡，取决于是否还有其他强引用。

引用计数换来常见路径上的及时回收：最后一条普通引用离开时，CPython 往往立刻进入释放路径。代价是每次引用转移都要维护计数，并且单靠局部计数看不穿环。循环垃圾回收器是它的补充：从被追踪对象中寻找只剩内部引用的封闭对象图，解决引用计数独自解不开的问题，也带来额外扫描与终结顺序的复杂度。

终结器能够观察死亡，也能干扰死亡：`__del__` 可能抛错、死锁、遇上解释器关闭，甚至让对象复活。它适合有限的兜底，不适合作为关键资源协议。可达就是仍在使用，哪怕业务已经忘了它：traceback、栈帧、缓存和闭包保留的引用都是真实引用，垃圾回收器不会猜测程序员的主观意图。资源释放应写进控制流，`with` 和 `try...finally` 把归还时刻变成程序结构的一部分，不依赖某个实现恰好及时发现对象死亡。

对象回收与 RSS 回落属于不同层。CPython 可以已经完成自己的生命周期工作，分配器和操作系统仍保留页面。排查内存时，先问指标正在描述哪一层。

CPython 没有把对象的生死交给一句 `del`。它先数清仍在外的引用，再巡查那些只会彼此引用的封闭对象图；有对象在终结时复活，就重新核对可达性。对象终于离开以后，分配器还要决定那块空间留给下一个对象，还是逐层退还。

理解这条路以后，许多看似古怪的现象便不再矛盾：名字不存在而对象仍能访问，循环无人使用却迟迟不走，强制 GC 也清不掉 traceback 留住的局部变量，以及对象数量已经回落而 RSS 仍停在高处。
