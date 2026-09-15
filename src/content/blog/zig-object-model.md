---
title: 类型即命名空间：Zig 没有 class，代码怎么摆
description: Zig 手册里翻不到 class。这篇讲一个 struct 如何同时承担类型、命名空间与对象三重身份，init/deinit 惯例如何替代构造析构，anytype 与 vtable 如何分场合替代接口。文中代码均运行于 Zig 0.16.0。
pubDate: 2026-09-09
category: zig
tags: [Zig, 编程语言]
---

从一个空文件开始写 Zig，写完 `main` 的第二行，问题就来了：业务逻辑放哪？别的语言有现成的答案：Java 和 Python 建个包或者模块，里面放 class；C++ 建个命名空间，还是放 class。Zig 的手册里翻不到 class 这个词。

于是第一反应是找替代品：struct 是不是弱化版 class？能不能继承？接口在哪？`self` 怎么写？这篇逐个回答。答案可以先概括出来：class 绑在一起的三件事，类型、命名空间、对象，在 Zig 里各自还原成原始形态，然后一个 struct 就够承担全部。文中的代码来自 Zig 0.16.0 的真实运行。

## 一个 struct，三重身份

从最不像「类型」的用法开始：空的 struct。

```zig
const geo = struct {
    pub const origin = Point{ .x = 0, .y = 0 };

    pub fn distance(a: Point, b: Point) f64 {
        const dx = @as(f64, a.x - b.x);
        const dy = @as(f64, a.y - b.y);
        return @sqrt(dx * dx + dy * dy);
    }

    pub const Point = struct {
        x: i32,
        y: i32,
    };
};
```

`geo` 里没有一个字段，一个实例都不会创建。它纯粹是个容器：装常量、装函数、装别的类型。问它多大：

```zig
std.debug.print("namespace size: {d}\n", .{@sizeOf(geo)});
```

```text
namespace size: 0
```

零字节。这就是 Zig 的「包」：不需要 package 关键字，也不需要 `static class`，一个 struct 就是命名空间。标准库自己就是这么组织的：`std.mem`、`std.fmt`、`std.unicode` 全是零字节的 struct。字符串那篇用过的 `std.mem.eql`，本质是命名空间 mem 里的函数 eql。

同一个语法，加上字段，就成了数据类型：

```zig
const Point = struct {
    x: i32,
    y: i32,
};
```

再加上接收 self 的函数，就成了「对象」。三重身份之间没有边界，因为它们本来就不需要边界。class 当年把这些绑在一起，是设计选择，不是自然法则。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="一个 struct 的三重身份：不加字段是零字节命名空间，装常量函数与嵌套类型；加上字段是数据类型，值语义赋值即拷贝；再加接收 self 的函数就成了对象，self 只是参数名" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="omA1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="200" y="16" width="260" height="36" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="39" text-anchor="middle" font-size="11" fill="#2b2a26">const X = struct { … }</text>
<line class="fl" x1="270" y1="52" x2="128" y2="82" stroke="#6b675e" stroke-width="1.2" marker-end="url(#omA1)"/>
<line class="fl" x1="330" y1="52" x2="330" y2="82" stroke="#6b675e" stroke-width="1.2" marker-end="url(#omA1)"/>
<line class="fl" x1="390" y1="52" x2="532" y2="82" stroke="#6b675e" stroke-width="1.2" marker-end="url(#omA1)"/>
<rect class="bx-q" x="20" y="86" width="200" height="100" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="120" y="108" text-anchor="middle" font-size="11" fill="#2b2a26">命名空间</text>
<text class="ts" x="120" y="128" text-anchor="middle" font-size="9" fill="#6b675e">没有字段 · @sizeOf = 0</text>
<text class="ts" x="120" y="144" text-anchor="middle" font-size="9" fill="#6b675e">装常量 / 函数 / 嵌套类型</text>
<text class="ts" x="120" y="164" text-anchor="middle" font-size="9" fill="#6b675e">std.mem、std.fmt 都是它</text>
<rect class="bx-q" x="230" y="86" width="200" height="100" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="330" y="108" text-anchor="middle" font-size="11" fill="#2b2a26">数据类型</text>
<text class="ts" x="330" y="128" text-anchor="middle" font-size="9" fill="#6b675e">加字段：x: i32, y: i32</text>
<text class="ts" x="330" y="144" text-anchor="middle" font-size="9" fill="#6b675e">值语义 · 赋值即拷贝</text>
<text class="ts" x="330" y="164" text-anchor="middle" font-size="9" fill="#6b675e">字面量构造，编译期查完备</text>
<rect class="bx-q" x="440" y="86" width="200" height="100" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="540" y="108" text-anchor="middle" font-size="11" fill="#2b2a26">对象</text>
<text class="ts" x="540" y="128" text-anchor="middle" font-size="9" fill="#6b675e">再加接收 self 的函数</text>
<text class="ts" x="540" y="144" text-anchor="middle" font-size="9" fill="#6b675e">self 只是第一个参数名</text>
<text class="ts" x="540" y="164" text-anchor="middle" font-size="9" fill="#6b675e">init / deinit 是惯例不是语法</text>
</svg>
</figure>

## 方法是函数，self 是参数名

Zig 里没有 `self` 关键字。方法就是普通函数，只不过第一个参数是这个类型：

```zig
const Counter = struct {
    count: u32 = 0,

    const Self = @This();

    pub fn peek(self: Self) u32 {
        return self.count;
    }

    pub fn bump(self: *Self) void {
        self.count += 1;
    }
};
```

`self` 是参数名，不是语法元素，理论上可以叫任何名字，只是没人那么干。`Self = @This()` 是个惯用别名，避免在泛型代码里手写自己的长名字（comptime 那篇用过它，这里不重讲）。

调用时有点糖：

```zig
var c = Counter{};
c.bump();            // 语法糖
Counter.bump(&c);    // 等价展开
```

糖只有一层：`a.b()` 展开成 `A.b(a)`，仅此而已。指针上可以直接调（`box_ptr.set(42)` 会自动解一层引用），两层指针就不再自动解，编译器会明确告诉你「方法调用只支持一层隐式解引用」。

真正重要的是接收者的选择，因为它就是 const 约束的传播：

```zig
const c = Counter{};
c.bump(); // 编译错误
```

```text
error: expected type '*Counter', found '*const Counter'
note: cast discards const qualifier
```

`bump` 要 `*Self`，const 值只能给出 `*const Self`，const 门槛直接挡在方法调用上。哪个方法能改自己、哪个只读，看一眼签名就知道，不用翻文档里「这个方法会不会修改 receiver」的说明。切片那篇讲过 `[]const u8` 只管「经由这条路能不能改」，方法的接收者就是那条路的第一段。

这里也没有「默认按值传递还是按引用传递」的悬念。接收者写 `Self` 就是值，写 `*Self` 就是指针，写 `*const Self` 就是只读指针。值语义贯穿始终，赋值即拷贝：

```zig
var a = Box{ .value = 1 };
var b = a;      // 整个 struct 拷贝
b.set(99);
std.debug.print("a: {d}, b: {d}\n", .{ a.get(), b.get() });
```

```text
a: 1, b: 99（互不影响）
```

没有引用语义，也没有隐式共享。两个 `Box` 互不影响，本来就是两块独立的内存。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 190" role="img" aria-label="方法调用的一层糖与三种接收者：c.bump() 展开为 Counter.bump 传入 &amp;c，隐式解引用只有一层；接收者写 Self 是值拷贝，写 *Self 可改原对象，写 *const Self 只读、可变方法被 const 挡下" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="omA2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="30" y="26" width="140" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="100" y="49" text-anchor="middle" font-size="10.5" fill="#2b2a26">c.bump()</text>
<line class="fl" x1="170" y1="44" x2="286" y2="44" stroke="#6b675e" stroke-width="1.3" marker-end="url(#omA2)"/>
<text class="ts" x="228" y="34" text-anchor="middle" font-size="9" fill="#6b675e">糖只有一层</text>
<rect class="bx" x="290" y="26" width="200" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="390" y="49" text-anchor="middle" font-size="10.5" fill="#2b2a26">Counter.bump(&amp;c)</text>
<text class="ts" x="506" y="49" font-size="9" fill="#6b675e">隐式解引用只到一层指针</text>
<rect class="bx-q" x="20" y="96" width="196" height="64" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="118" y="120" text-anchor="middle" font-size="10.5" fill="#2b2a26">self: Self</text>
<text class="ts" x="118" y="142" text-anchor="middle" font-size="9" fill="#6b675e">按值：拿到的是一份拷贝</text>
<rect class="bx-q" x="232" y="96" width="196" height="64" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="120" text-anchor="middle" font-size="10.5" fill="#2b2a26">self: *Self</text>
<text class="ts" x="330" y="142" text-anchor="middle" font-size="9" fill="#6b675e">可写：改动落在原对象上</text>
<rect class="bx-sick" x="444" y="96" width="196" height="64" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="542" y="120" text-anchor="middle" font-size="10.5" fill="#b03a2e">self: *const Self</text>
<text class="ts" x="542" y="142" text-anchor="middle" font-size="9" fill="#6b675e">只读：bump 这类调用被挡下</text>
<text class="ts" x="20" y="182" font-size="9.5" fill="#6b675e">能不能改自己，写在签名里，不用翻文档</text>
</svg>
</figure>

## 构造与析构：一对惯例

没有构造函数，但有一个惯例，牢固到标准库无处不在地遵守：

```zig
const Session = struct {
    token: []u8,

    const Self = @This();

    pub fn init(allocator: std.mem.Allocator, user: []const u8) !Self {
        const token = try allocator.dupe(u8, user);
        return .{ .token = token };
    }

    pub fn deinit(self: Self, allocator: std.mem.Allocator) void {
        allocator.free(self.token);
    }
};

var s = try Session.init(allocator, "kaiven");
defer s.deinit(allocator);
```

`init` 是普通的静态函数：分配、复制、返回值。没有 `new`，没有构造顺序的玄学，也没有初始化列表。字面量 `.{ .token = token }` 就是构造现场，而且它是编译期检查的：

```zig
const u = User{ .name = "听雨" }; // User 还有 age 字段
```

```text
error: missing struct field: age
```

漏一个字段，编译不过。字段没默认值就必须写，写了类型就必须对。构造的完备性由类型系统把守，不靠「构造函数里记得赋值」。

`deinit` 同样是普通函数，配 `defer` 使用（错误处理那篇讲过这对搭档）。它没有被语言特殊对待：忘了调 `deinit`，编译器不会像 C++ 漏析构那样事后追责；分配器那篇讲过的 `DebugAllocator` 会，`deinit` 时逐块报告没还的内存，文件行号精确到分配现场。

`init` 接 allocator 作第一参数（`ArrayList` 在 0.16.0 中改为每个方法传），是这个惯例和分配器哲学的接缝：对象不从全局堆里凭空出现，内存由调用方指定。构造需要分配，分配就可能失败，所以 `init` 返回 `!Self`。三个推论连成一串，全写在签名里。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 130" role="img" aria-label="init 与 deinit 的一对惯例：Session.init 接收 allocator 返回 !Self，使用期间普通访问，defer s.deinit(allocator) 把内存按原路还回同一个分配器" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="omA3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="20" y="30" width="220" height="52" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="130" y="51" text-anchor="middle" font-size="10" fill="#2b2a26">try Session.init(allocator, …)</text>
<text class="ts" x="130" y="70" text-anchor="middle" font-size="9" fill="#6b675e">普通静态函数 · 返回 !Self</text>
<line class="fl" x1="240" y1="56" x2="276" y2="56" stroke="#6b675e" stroke-width="1.3" marker-end="url(#omA3)"/>
<rect class="bx-q" x="280" y="30" width="120" height="52" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="340" y="51" text-anchor="middle" font-size="10" fill="#2b2a26">使用</text>
<text class="ts" x="340" y="70" text-anchor="middle" font-size="9" fill="#6b675e">s.token …</text>
<line class="fl" x1="400" y1="56" x2="436" y2="56" stroke="#6b675e" stroke-width="1.3" marker-end="url(#omA3)"/>
<rect class="bx" x="440" y="30" width="200" height="52" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="540" y="51" text-anchor="middle" font-size="10" fill="#2b2a26">defer s.deinit(allocator)</text>
<text class="ts" x="540" y="70" text-anchor="middle" font-size="9" fill="#6b675e">普通函数 · 还回同一个分配器</text>
<text class="ts" x="20" y="114" font-size="9.5" fill="#6b675e">语言不强制这对惯例：漏调 deinit 没人追责，DebugAllocator 退出时逐块点名</text>
</svg>
</figure>

继承呢？没有。曾经有个叫 `usingnamespace` 的机制能把手写转发简化一点，0.16.0 里它已被整个删除，解析器直接报错。想要「复用另一个类型的行为」，答案只有一个：放一个字段，然后自己写转发：

```zig
const Dog = struct {
    animal: Animal,   // 组合：一个字段，不是基类
    breed: []const u8,
};
```

```zig
d.speak() // 编译错误
```

```text
error: no field or member function named 'speak' in 'Dog'
```

`Dog` 不继承 `Animal` 的任何方法，`d.animal.speak()` 才是合法写法。转发的样板代码确实要自己敲。Zig 的立场是，显式写三行转发，好过隐式的三层继承链。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 186" role="img" aria-label="组合而非继承：Dog 结构体里 animal 是一个普通字段，类型是 Animal；d.speak() 编译错误，因为 Dog 没有这个方法；d.animal.speak() 合法，显式多走一跳；要复用就手写三行转发函数" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<rect class="bx" x="30" y="30" width="290" height="120" rx="6" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="t" x="175" y="52" text-anchor="middle" font-size="11.5" fill="#2b2a26">Dog</text>
<rect class="bx-q" x="50" y="64" width="250" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="175" y="82" text-anchor="middle" font-size="10" fill="#2b2a26">animal: Animal</text>
<text class="ts" x="175" y="99" text-anchor="middle" font-size="9" fill="#6b675e">一个普通字段 · 会 speak()</text>
<text class="ts" x="175" y="134" text-anchor="middle" font-size="10" fill="#2b2a26">breed: []const u8</text>
<text class="tc" x="350" y="52" font-size="10.5" fill="#b03a2e">✗ d.speak()</text>
<text class="ts" x="350" y="70" font-size="9" fill="#6b675e">error: no field or member</text>
<text class="ts" x="350" y="84" font-size="9" fill="#6b675e">function named 'speak' in 'Dog'</text>
<text class="ts" x="350" y="112" font-size="10.5" fill="#2b2a26">✓ d.animal.speak()</text>
<text class="ts" x="350" y="130" font-size="9" fill="#6b675e">显式多走一跳，路径看得见</text>
<text class="ts" x="350" y="152" font-size="9.5" fill="#6b675e">要复用：fn speak(self: Dog) 里转发一行</text>
</svg>
</figure>

## 接口的两副面孔

「接口在哪」是最后一个悬着的问题。Zig 给了两套机制，分场合用。

编译期场合用 `anytype`。函数参数写 `anytype`，调用时是什么类型，编译期就单态化出一份专属版本：

```zig
const ConsoleLogger = struct {
    pub fn log(self: ConsoleLogger, msg: []const u8) void {
        _ = self;
        std.debug.print("[console] {s}\n", .{msg});
    }
};

const QuietLogger = struct {
    prefix: []const u8,
    pub fn log(self: QuietLogger, msg: []const u8) void {
        std.debug.print("[{s}] {s}\n", .{ self.prefix, msg });
    }
};

fn reportTo(logger: anytype, msg: []const u8) void {
    logger.log(msg);
}

reportTo(ConsoleLogger{}, "听雨");
reportTo(QuietLogger{ .prefix = "夜" }, "夜凉");
```

```text
[console] 听雨
[夜] 夜凉
```

两个类型没有任何声明上的联系：不实现接口，不继承基类，只是「恰好有这个方法」。像不像，编译期说了算。传一个整数进去：

```zig
reportTo(42, "听雨");
```

```text
error: no field or member function named 'log' in 'comptime_int'
```

报错发生在实例化现场，还行；但调用者的真实诉求往往是「我要什么样的类型」。惯用的守卫是 `@hasDecl` 加 `@compileError`：

```zig
fn reportTo(logger: anytype, msg: []const u8) void {
    const T = @TypeOf(logger);
    comptime if (@typeInfo(T) != .@"struct" or !@hasDecl(T, "log"))
        @compileError("reportTo 需要一个带 pub fn log 的 struct，得到的是 " ++ @typeName(T));
    logger.log(msg);
}
```

```text
error: reportTo 需要一个带 pub fn log 的 struct，得到的是 comptime_int
```

这就是 Zig 的「鸭子类型」：静态检查，错误信息由库作者用普通代码定制。`std.meta.hasMethod` 可以把检查本身也变成可复用的函数。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 214" role="img" aria-label="anytype 的编译期单态化：reportTo 一个泛型函数，被 ConsoleLogger 调用就生成一份专属版本，被 QuietLogger 调用再生成一份，各自直调自己的 log，没有运行期派发；传入整数 42 时在实例化现场报错，加 hasDecl 守卫后错误信息可由库作者定制" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="omA5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="omA5c" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<rect class="bx" x="190" y="16" width="280" height="40" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="41" text-anchor="middle" font-size="10.5" fill="#2b2a26">fn reportTo(logger: anytype, …)</text>
<line class="fl" x1="250" y1="56" x2="128" y2="92" stroke="#6b675e" stroke-width="1.2" marker-end="url(#omA5)"/>
<line class="fl" x1="330" y1="56" x2="330" y2="92" stroke="#6b675e" stroke-width="1.2" marker-end="url(#omA5)"/>
<line class="flc" x1="410" y1="56" x2="538" y2="92" stroke="#b03a2e" stroke-width="1.2" marker-end="url(#omA5c)"/>
<text class="ts" x="150" y="80" font-size="9" fill="#6b675e">编译期实例化</text>
<text class="ts" x="345" y="80" font-size="9" fill="#6b675e">编译期实例化</text>
<text class="tc" x="486" y="80" font-size="9" fill="#b03a2e">没有 log 方法</text>
<rect class="bx-q" x="20" y="96" width="200" height="60" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="118" text-anchor="middle" font-size="9.5" fill="#2b2a26">专属版本 · ConsoleLogger</text>
<text class="ts" x="120" y="138" text-anchor="middle" font-size="9" fill="#6b675e">直调它的 log · 零派发</text>
<rect class="bx-q" x="230" y="96" width="200" height="60" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="118" text-anchor="middle" font-size="9.5" fill="#2b2a26">专属版本 · QuietLogger</text>
<text class="ts" x="330" y="138" text-anchor="middle" font-size="9" fill="#6b675e">另一份机器码 · 互不相干</text>
<rect class="bx-sick" x="440" y="96" width="200" height="60" rx="5" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="540" y="118" text-anchor="middle" font-size="9.5" fill="#b03a2e">reportTo(42, …)</text>
<text class="ts" x="540" y="138" text-anchor="middle" font-size="9" fill="#6b675e">实例化现场报错</text>
<text class="ts" x="20" y="188" font-size="10" fill="#6b675e">两个 Logger 没有任何声明上的联系：像不像，编译期在调用点逐一核对</text>
<text class="ts" x="20" y="206" font-size="9.5" fill="#a29d90">加 @hasDecl 守卫后，报错信息换成库作者写的那句话</text>
</svg>
</figure>

运行期场合用 vtable。当接口值需要存进数组、跨函数传递、在运行期切换实现时，`anytype` 就不够了：不同 `anytype` 实例是不同类型，装不进同一个数组。这时需要一个统一的运行期类型：

```zig
const Logger = struct {
    ctx: *anyopaque,
    vtable: *const VTable,

    const VTable = struct {
        log: *const fn (ctx: *anyopaque, msg: []const u8) void,
        name: *const fn (ctx: *anyopaque) []const u8,
    };

    pub fn log(self: Logger, msg: []const u8) void {
        self.vtable.log(self.ctx, msg);
    }

    pub fn name(self: Logger) []const u8 {
        return self.vtable.name(self.ctx);
    }
};
```

`Logger` 是个 16 字节的普通值：一个指向实现者状态的指针，加一张函数表的地址。实现者提供两个东西：转成 `*anyopaque` 的自己，和一张静态函数表。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="vtable 接口值结构：Logger 十六字节，由 ctx 指针与 vtable 指针两格组成；vtable 指向静态函数表 log 与 name；ctx 指向 Console 或 Prefixed 实例，实现函数进去第一件事用 ptrCast 转回真身；std.mem.Allocator 是同款形状" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="omA6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="30" y="40" width="230" height="86" rx="5" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="145" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">Logger · 接口值 16 字节</text>
<rect class="bx-q" x="44" y="72" width="96" height="38" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="92" y="88" text-anchor="middle" font-size="9" fill="#2b2a26">ctx</text>
<text class="ts" x="92" y="102" text-anchor="middle" font-size="8" fill="#6b675e">*anyopaque</text>
<rect class="bx-q" x="150" y="72" width="96" height="38" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="198" y="88" text-anchor="middle" font-size="9" fill="#2b2a26">vtable</text>
<text class="ts" x="198" y="102" text-anchor="middle" font-size="8" fill="#6b675e">*const VTable</text>
<line class="fl" x1="198" y1="72" x2="386" y2="52" stroke="#6b675e" stroke-width="1.3" marker-end="url(#omA6)"/>
<rect class="bx-q" x="390" y="24" width="240" height="76" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="510" y="44" text-anchor="middle" font-size="10" fill="#2b2a26">VTable · 静态函数表</text>
<text class="ts" x="510" y="64" text-anchor="middle" font-size="9" fill="#6b675e">log: *const fn (ctx, msg) void</text>
<text class="ts" x="510" y="80" text-anchor="middle" font-size="9" fill="#6b675e">name: *const fn (ctx) []const u8</text>
<line class="fl" x1="92" y1="110" x2="386" y2="166" stroke="#6b675e" stroke-width="1.3" marker-end="url(#omA6)"/>
<rect class="bx-q" x="390" y="140" width="240" height="60" rx="5" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="510" y="162" text-anchor="middle" font-size="10" fill="#2b2a26">Console / Prefixed 实例</text>
<text class="ts" x="510" y="182" text-anchor="middle" font-size="9" fill="#6b675e">函数进门第一件事：@ptrCast 转回真身</text>
<text class="ts" x="30" y="226" font-size="10" fill="#6b675e">标准范本：std.mem.Allocator = ptr + vtable{ alloc, resize, remap, free }</text>
</svg>
</figure>

```zig
const Console = struct {
    fn log(ctx: *anyopaque, msg: []const u8) void {
        _ = ctx;
        std.debug.print("[console] {s}\n", .{msg});
    }
    fn name(ctx: *anyopaque) []const u8 {
        _ = ctx;
        return "console";
    }
    pub fn logger(self: *Console) Logger {
        return .{ .ctx = self, .vtable = &vtable };
    }
    const vtable = Logger.VTable{ .log = log, .name = name };
};

const Prefixed = struct {
    prefix: []const u8,

    fn log(ctx: *anyopaque, msg: []const u8) void {
        const self: *Prefixed = @ptrCast(@alignCast(ctx));
        std.debug.print("[{s}] {s}\n", .{ self.prefix, msg });
    }
    // ...name 与 logger 同理
};
```

实现里的函数都拿 `*anyopaque` 开头，进去第一件事转回真身。然后，运行期多态成立：

```zig
const loggers = [_]Logger{ console.logger(), prefixed.logger() };
for (loggers) |l| {
    std.debug.print("{s} 说：\n", .{l.name()});
    l.log("听雨");
}
```

```text
console 说：
[console] 听雨
prefixed 说：
[夜] 听雨
```

这不是奇技淫巧，`std.mem.Allocator` 就是这个形状。分配器那篇看过它的字段：`ptr: *anyopaque` 加 `vtable: *const VTable`，函数表里是 `alloc`、`resize`、`remap`、`free` 四个函数。用 `@typeInfo` 再看一眼：

```text
Allocator 字段：
  ptr: *anyopaque
  vtable: *const mem.Allocator.VTable
```

同一个模式，标准库自己也用在 `std.Io.Writer` 上（0.16.0 重做后的形状是 vtable 加缓冲区）。vtable 在 Zig 里是「手写，但照着好的形状写」：语言不给语法，只给惯例和样板，照 Allocator 的形状写就对了。

## 封闭多态：别忘了 union

有一类「多态」其实不需要接口：变体集合在编译期就全部已知。图形要么是圆要么是矩形，JSON 值就那几种。这类问题的原配是 tagged union，union 那篇的主角，这里从对象模型的角度再看一次：

```zig
const Shape = union(enum) {
    circle: Circle,
    rect: Rect,

    const Circle = struct { radius: f64 };
    const Rect = struct { w: f64, h: f64 };

    fn area(self: Shape) f64 {
        return switch (self) {
            .circle => |c| std.math.pi * c.radius * c.radius,
            .rect => |r| r.w * r.h,
        };
    }
};
```

一个 tag 字段加一个 payload，24 字节装下圆或矩形，派发是一次 switch 而不是一次函数指针跳转。加一个变体，编译器强制你补全 switch 分支，这是接口给不了的保证。

三种机制摆在一起，选择就看代码成本：

| | tagged union | vtable | anytype |
| --- | --- | --- | --- |
| 变体集合 | 编译期封闭 | 运行期开放 | 按调用点单态化 |
| 派发方式 | switch 直调 | 函数指针间接调用 | 无派发，直调 |
| 值能否统一存放 | 能（本身就是值） | 能（接口值） | 不能 |
| 新增实现 | 改 union 定义 | 写新 struct，不动接口 | 写新 struct |
| 典型场景 | 状态机、AST、消息 | 插件、策略、Allocator | 容器、工具函数 |

「开放还是封闭」这个问题，在这里落地成三行代码成本的比较。多数程序里，真正的开放多态比面向对象教材暗示的少得多。

## 拼装一个像样的类型

把这一篇的零件组装起来，一个生产级的类型大致长这样。命名空间装类型，`init`/`deinit` 管生命周期，泛型参数化，vtable 留给真需要的场合：

```zig
const Node = struct {
    name: []u8,
    children: std.ArrayList(*Node),

    const Self = @This();

    pub fn init(allocator: std.mem.Allocator, name: []const u8) !*Self {
        const self = try allocator.create(Self);
        self.* = .{
            .name = try allocator.dupe(u8, name),
            .children = .empty,
        };
        return self;
    }

    pub fn deinit(self: *Self, allocator: std.mem.Allocator) void {
        for (self.children.items) |child| {
            child.deinit(allocator);
        }
        self.children.deinit(allocator);
        allocator.free(self.name);
        allocator.destroy(self);
    }
};
```

注意 `deinit` 里那行 `for (self.children.items) |child| child.deinit(allocator)`：树形结构的清理是递归的，每个节点负责自己的子树。没有析构函数从幕后接手这趟递归，它就写在明处。忘了写的后果前面见过：`DebugAllocator` 在程序退出时把没还的内存逐块报出来，行号指向分配现场。

## 这套对象模型的代价

样板代码是真实存在的。`init`/`deinit` 要手写，组合的转发要手写，vtable 的表和 `@ptrCast` 也要手写。继承体系里「白拿」的那部分行为，这里全都要自己敲。换来的是每一行转发都看得见、可跳转、可删除；但初学阶段的手感确实是「怎么这么啰嗦」。

anytype 把检查推迟到实例化，也把膨胀留给了编译器。一个 `anytype` 函数被几种类型调用，就单态化出几份机器码，这是泛型容器的经典代价，comptime 篇讲过。报错信息如果不加 `@compileError` 守卫，调用者看到的是模板展开式的底层错误；加了守卫，就是库作者的话。这个责任在库作者，语言不代劳。

vtable 没有语言背书，只有惯例维持。`Allocator` 的形状是标杆，但没有任何机制阻止你把 vtable 写出花来。接口的稳定性靠文档和自律，不靠编译器。这是「语言不管」哲学在对象模型上的又一次落地，和生命周期不进类型系统是同一个立场。

值语义直白，大对象的拷贝也直白。赋值即拷贝，没有隐式共享的惊喜；把一个大 struct 按值传来传去，拷贝成本也没有任何机制替你挡。C++ 程序员对「什么时候触发拷贝」的警觉，在这里用得上；只是 Zig 里答案更简单：接收者写 `Self` 就是拷贝，想要引用就写 `*Self`，没有第三种可能。

没有继承，也没有「替代继承的官方姿势」。组合、tagged union、anytype、vtable 四条路都通，选哪条是设计判断。这把面向对象里「默认用继承」的惰性拿掉了，代价是每次复用都要自己想清楚形状。

---

回头看这一路：命名空间就是零字节的 struct，方法就是第一个参数恰好的函数；构造和析构是一对惯例，继承落在一个字段上，接口分场合用 `anytype` 或 vtable。

class 被还原之后，每个零件都回到了它本来的名字。还原之后没有多出什么新概念，反而少了四样：构造顺序、访问控制、虚函数表的语言级存在、方法解析顺序。剩下的每一件东西，都在这一系列的前文里出现过：struct 在内存布局篇排过字段，泛型在 comptime 篇当过值，vtable 在分配器篇量过 16 字节，`init` 里的 allocator 是分配器篇的主角，`deinit` 配 `defer` 是错误处理篇的搭档。这一章没有引入新零件，只是把前面各篇的东西拼成了一张完整的图。
