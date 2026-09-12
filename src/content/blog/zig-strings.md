---
title: 一串字节，各自认领：Zig 为什么没有 string 类型
description: Zig 没有 string，没有 char，字符串是 []const u8 加上一份约定：格式串在编译期查过，拼接要自带分配器，中文按 UTF-8 字节计数。示例出自 Zig 0.16.0 实际运行。
pubDate: 2026-09-09
category: zig
tags: [Zig, 编程语言]
---

学一门新语言，人总是先找熟悉的东西：class 在哪，字符串怎么写。Zig 的文档翻遍了也找不到 `string` 这个关键字，不是藏在哪一章，是根本没有。第一天就会撞上的一串问题：为什么 `"hello"` 打印要用 `{s}` 不能用 `{}`？为什么两个字符串不能用 `==` 比？为什么拼个字符串还要传 allocator？

这篇就把这串问题一次答完。结论是：Zig 的字符串是一串字节，加一份写清楚的约定。打印怎么解释、相等怎么定义、内存归谁、字符怎么数，全部由人在代码里认领，语言不代劳。文中的示例输出都来自 Zig 0.16.0。

## 没有 string，只有「一串字节」

最普通的写法：

```zig
const title: []const u8 = "听雨";
```

`[]const u8`，一个字节切片。它和 `[]const i32`、`[]const bool` 在语言眼里没有本质区别，都是「一段元素，只读」。

语言也不是没有偏爱它的地方。字符串字面量的类型就专门为它定制过：

```zig
std.debug.print("{s}\n", .{@typeName(@TypeOf("听雨"))});
```

```text
*const [6:0]u8
```

指针那篇讲过这个形状：只读指针，指向长度为 6、以 0 结尾的字节数组。六个字节装下两个汉字（UTF-8 里一个汉字占三个字节），外加一个哨兵 0。它携带的信息比 `[]const u8` 多，所以能按需放下一部分，隐式变成普通切片。

但这份偏爱到此为止。一旦变成 `[]const u8`，类型系统对它的态度就和对待任何切片一样：这里有一段内存，从哪开始，多长，只读。至于这些字节是不是合法的 UTF-8、是不是文字、该按字节还是按字符理解，类型不知道，也不假装知道。

别的语言里 `string` 是个容器，带容量、带编码、带方法；Zig 里它只是别人内存上的一张借条。借条的规矩，切片那篇已经写透了；这篇要补的是另一边：既然语言不认「字符串」这个概念，打印、比较、拼接、数长度、遍历字符这些日常手艺，各自去哪儿认领。

## 打印：为什么要写 `{s}`

从打印开始。

```zig
const name: []const u8 = "听雨";
std.debug.print("[{s}]\n", .{name});
```

```text
[听雨]
```

`{s}` 说「按字节串打印」。手滑写成 `{}`，编译器当场拦下：

```text
error: cannot format slice without a specifier (i.e. {s}, {x}, {b64}, or {any})
```

初看像刁难，细想是负责。`{}` 的意思是「你看着办」，可一串字节有许多种「看着办」：当 UTF-8 文字、当十六进制、当 base64？猜错了就是输出乱码或者更糟。Zig 的立场是：打印方式也是一种解释方式，解释必须由人声明。

用错了说明符也一样拦。`{d}` 想把字符串当数字打：

```zig
std.debug.print("{d}\n", .{"听雨"});
```

```text
error: invalid format string 'd' for type '*const [6:0]u8'
```

而这一整套检查发生在编译期，是因为格式串本身就是一个 comptime 参数。试着把格式串当普通值传，会得到另一个错误：

```zig
fn greet(format: []const u8, name: []const u8) void {
    std.debug.print(format, .{name});
}
```

```text
error: unable to resolve comptime value
note: argument to comptime parameter must be comptime-known
```

格式串必须在编译期就知道，所以占位符与实参的匹配、说明符与类型的匹配，全是编译器替你查的。等价的检查在别的语言里是运行时异常，或者干脆没有检查。这也是 comptime 那篇的老话：检查从运行时搬进了编译器。

代价也直说：格式串没法运行时拼出来。日志库想允许用户配置输出格式，就得自己走解析那条路，标准库的 `{s}` 体系帮不上忙。

## 比较：`==` 比不了内容

接下来是比较。直觉写法直接被拒：

```zig
const s1: []const u8 = "ink";
const s2: []const u8 = "ink";
if (s1 == s2) {}
```

```text
error: operator == not allowed for type '[]const u8'
```

原因和打印那关同源：切片是「指针加长度」。`==` 若存在，是比地址，还是比内容？两种语义都合理，选哪种都是替人做决定。C 的 `strcmp` 返回 int、Java 拆 `==` 与 `equals` 两套，都是在同一个岔路口做了不同选择。Zig 的做法是让岔路口明着来：

```zig
std.mem.eql(u8, s1, s2)         // 比内容
std.mem.eql(u8, s1.ptr, s2.ptr) // 想比地址？这不是那个函数
```

第二行是故意的错写。比地址没有专门函数，因为地址比较就是普通指针比较 `s1.ptr == s2.ptr`，不需要字符串语境。比内容才需要专门的 `std.mem.eql`，而且要写明元素类型 `u8`：它本质是个字节比较函数，只是恰好常用于字符串。

顺带一个实验结果：两个字面量 `"ink"`，`s1.ptr == s2.ptr` 是真的，编译器把相同内容合并到了同一地址。但这是这次编译的优化行为，不是承诺；今天靠它，明天换 `-O` 级别就可能是另一回事。地址相等能推出内容相等，反过来不成立。比较内容，用 `eql`。

标准库还备着一排常用判等与查找，形状都是「字节操作」而不是「字符串方法」：

```zig
std.mem.startsWith(u8, "听雨博客", "听雨")   // true
std.mem.endsWith(u8, "听雨博客", "博客")     // true
std.mem.indexOf(u8, "Rain,听雨", ",")       // 4（字节偏移）
std.mem.eql(u8, "ink", "ink")               // true
```

注意 `indexOf` 给的是字节偏移，不是第几个字符。这句话马上要变成一个更大的话题。

## 六个字节，两个汉字

最扎心的是数长度。

```zig
std.debug.print("len: {d}\n", .{"听雨".len});
```

```text
len: 6
```

不是 2，是 6。`len` 数的是字节，源码里的字符串字面量装的是 UTF-8 编码。`听` 的 UTF-8 编码是 `e5 90 ac` 三个字节：

```zig
std.debug.print("bytes:", .{});
for ("听雨") |b| std.debug.print(" {x:0>2}", .{b});
std.debug.print("\n", .{});
```

```text
bytes: e5 90 ac e9 9b a8
```

这带来一个所有中文用户都会踩的坑：下标和切片按字节算，而汉字的边界不落在字节上。

```zig
const s = "听雨";
const cut: []const u8 = s[0..2]; // “听”的前两个字节
std.debug.print("cut: [{s}]\n", .{cut});
```

```text
cut: [�]
```

切出来的是残缺的 UTF-8 序列，打印出替换符，程序照常往下跑。没有崩溃，没有报错，因为对 `[]const u8` 来说，`s[0..2]` 是一次完全合法的切片操作，字节没有越界，「越界」的是文字。内存的边界类型系统能守，语义的边界它不接管。

数「字符」要显式走 Unicode 那条路：

```zig
const n = try std.unicode.utf8CountCodepoints("听雨");
```

```text
codepoints: 2
```

遍历也一样，两个视角并存：

```zig
const s = "听雨a";
for (s) |b| { ... }                  // 字节视角：e5 90 ac e9 9b a8 61
var it = (try std.unicode.Utf8View.init(s)).iterator();
while (it.nextCodepoint()) |cp| { ... } // 码点视角：U+542C U+96E8 U+0061
```

`Utf8View.init` 会先验证整段字节是合法 UTF-8，不合法返回错误；只想验证不遍历，有 `utf8ValidateSlice`。拿刚才切残的 `cut` 去验：

```zig
std.debug.print("valid: {}\n", .{std.unicode.utf8ValidateSlice(cut)});
```

```text
valid: false
```

还要交代一个容易混淆的层次：码点不等于「字」。`é` 可以是单个码点，也可以是 `e` 加组合变音符两个码点；emoji 的肤色、组字更是把一个视觉上的字拆成一串码点。Unicode 的正式概念叫字素（grapheme cluster），Zig 标准库到 0.16.0 为止没有提供字素切分，那需要完整的 Unicode 属性表，体量和维护成本都不小。标准库把线画在码点这一层；要按字素处理，得请 ICU 这类专门的库。

再往下一层还有个容易漏看的细节：`'A'` 也不是 `char`。Zig 根本没有 `char` 类型，`'A'` 是 `comptime_int`，值 65：

```zig
std.debug.print("type: {s}, value: {d}\n", .{ @typeName(@TypeOf('A')), 'A' });
```

```text
type: comptime_int, value: 65
```

单引号是「一个数字的字符写法」，双引号是「一串字节」。没有 char，是因为一个「字符」在字节世界里未必装得进一个字节。u21 勉强装得下码点，但那已经是 Unicode 语境的事，语言层不想替你预设。

## 拼接要自带分配器

然后是拼接。`+` 不行，`++` 可以，但只在编译期：

```zig
const title = "听雨" ++ "博客"; // 编译期拼接，结果仍是字面量
```

`++` 要求两边都是编译期已知的数组，拼出来的还是那个 `*const [N:0]u8`，静态存储，零运行时成本，长度相加在编译期就算好了。

运行期拼接就要回到那个贯穿全系列的问题：新内存从哪儿来。两段字符串拼出第三段，第三段得有地方住，于是 allocator 登场：

```zig
var gpa = std.heap.DebugAllocator(.{}){};
const allocator = gpa.allocator();
defer _ = gpa.deinit();

const greeting = try std.fmt.allocPrint(allocator, "{s}，{s}", .{ "听雨", "夜凉" });
defer allocator.free(greeting);
```

```text
greeting: 听雨，夜凉
```

多段拼一起，用 `std.mem.concat`：

```zig
const joined = try std.mem.concat(allocator, u8, &.{ "听雨", "和", "博客" });
defer allocator.free(joined);
```

```text
joined: 听雨和博客
```

分配器那篇的老话在这里再次适用：分配是调用方的决策。别的语言里 `"a" + b + "c"` 背后是运行时悄悄扩容的缓冲区；Zig 把那块缓冲区摆到了签名里。写起来确实多两行，换来的是拼接的成本和归属都在明面上，谁分配的、谁负责还、什么时候还，一眼可查。

已知结果装得下时，还可以绕开分配，让调用方出缓冲区：

```zig
var buf: [32]u8 = undefined;
const fixed = try std.fmt.bufPrint(&buf, "第 {d} 章", .{3});
```

```text
fixed: 第 3 章 (len 9)
```

9 个字节：`第` 3 字节、空格 1、`3` 1、空格 1、`章` 3。装不下返回 `error.NoSpaceLeft`，不猜、不扩。

要一段一段往里追加，0.16.0 的写法是 `std.Io.Writer.Allocating`：

```zig
var aw: std.Io.Writer.Allocating = .init(allocator);
defer aw.deinit();

const chapters = [_][]const u8{ "一", "二", "三" };
for (chapters) |c| {
    try aw.writer.print("第{s}章 ", .{c});
}
const assembled = try aw.toOwnedSlice();
defer allocator.free(assembled);
```

```text
assembled: [第一章 第二章 第三章 ] len 30
```

`Writer.Allocating` 是个自己带 ArrayList 的写入器，`print` 按需扩容，最后 `toOwnedSlice` 把积累的字节正式移交。它就是其他语言里 StringBuilder 的位置，只是这里不叫 Builder，叫「一个会分配的 Writer」，而且谁给它分配、何时结清，都在签名和 defer 里写着。

还有个 C 边界专用的变体值得一提。`allocPrint` 给的是普通 `[]u8`，过 C 桥要的是以 0 结尾的字符串，直接 free 掉再拼哨兵是不行的，得让分配时就带上：

```zig
const z = try std.fmt.allocPrintSentinel(allocator, "{s}", .{"ink"}, 0);
defer allocator.free(z);

std.debug.print("type: {s}, len: {d}, z[3] = 0x{x}\n",
    .{ @typeName(@TypeOf(z)), z.len, z[3] });
```

```text
type: [:0]u8, len: 3, z[3] = 0x0
```

类型 `[:0]u8`，长度 3，哨兵在 `z[3]`，不占 `len`。C 互操作那篇讲过哨兵的来龙去脉；这里只看字符串这一侧：要不要这个结尾 0，是一次显式的选择，不是 string 的默认属性。

## 借来的，还是新分配的

日常操作里藏着一条贯穿性的分界：哪些函数借走你的字符串，哪些替你复制一份。分界线几乎总跟着 allocator 走。

借的一侧不分配、不修改，结果只是输入的另一个视角：

```zig
const line = "  听雨  ";
const borrowed = std.mem.trim(u8, line, " "); // 借：子切片
```

`trim` 返回的是原字符串掐头去尾的子切片，指针可能前移（这里剥掉两个前导空格，指针前移 2 字节），底层还是原来那块内存。同一阵营的还有 `tokenize`、`split`、`startsWith`、`indexOf`、`eql`，全是零分配的字节操作：

```zig
var it = std.mem.tokenizeScalar(u8, "a,b,,c", ',');
while (it.next()) |token| {
    std.debug.print("token: [{s}]\n", .{token});
}
```

```text
token: [a]
token: [b]
token: [c]
```

`tokenizeScalar` 会跳过空段，`splitScalar` 会保留，这是两个兄弟函数的唯一差别。

新分配的一侧要分配，要报 `OutOfMemory`，要有人负责释放：

```zig
const owned = try std.mem.concat(allocator, u8, &.{ borrowed, "，夜凉" });
defer allocator.free(owned);
```

```text
owned: [听雨，夜凉]
```

分辨的方法切片那篇给过：看函数接不接受 allocator。接受，多半意味着「我要分配新的」；不接受，多半意味着「我只借用」。`trim` 与 `concat` 是这条规则最干净的一对例子。借用者便宜，但寿命受制于原件；复制者自立门户，但要把分配和释放写进你的代码。

## 标准库没有的事：大小写、排序、本地化

有一类操作在别的语言里习以为常，在 Zig 标准库里找不到：`toUpper` 对整个字符串、按本地化排序、`toLocaleString` 之类。

原因还是那个：这些是文字学，不是字节操作。

标准库里的大小写只有 ASCII 一档：

```zig
std.ascii.toUpper('a')    // 'A'
std.ascii.toUpper(0xC3)   // 0xC3，非 ASCII 字节原样返回
```

`std.ascii.toUpper` 对非 ASCII 字节原样放行，不试图理解。大写「雨」是什么？没有答案，中文没有大小写。「ß」的大写是「SS」还是「ẞ」？取决于德语正字法和你说的是哪年的规则。「i」 在土耳其语里大写是「İ」。这些问题每一件都需要 Unicode 属性表和本地化数据，答案随语言、地区甚至时间变化。

一个以「小内核 + 显式依赖」为哲学的标准库，不可能把这张表内置进来。于是线画在这里：字节操作、ASCII、UTF-8 编解码验证，标准库管；字素切分、大小写映射、本地化排序，专门的库管。这在中文语境里损失不大，中文几乎用不到大小写；但排序是实打实的：`std.mem.order` 按字节比较，「听」排在所有 ASCII 之后，按拼音排序列表这种需求，标准库帮不上。

同样的取舍在时间格式化、复数规则、纸币符号这些地方反复出现。Zig 的做法始终一致：语言和标准库不替文化做决定。

## 多写的字，多担的责

没有默认，就没有意外。`{s}` 要写、比较要点名、拼接带 allocator，每一处都比「字符串魔法」多几个字。换来的是打印格式、比较语义、内存归属全都显式可见，代码评审时无一处靠猜。多写几个字是小事，长命代码里处处不靠猜才是收益所在。

字节视角性能极好，语义责任极重。`indexOf` 是裸的字节扫描，`eql` 是裸的内存比较，没有编码转换夹在中间；热路径上这是实打实的速度。代价是所有「字符」级的直觉都得自己折算成字节，切错一刀不会有任何报错。若要按文字处理，验证（`utf8ValidateSlice`）和码点遍历（`Utf8View`）必须显式出现在代码里，一步不能省。

format 的编译期检查很严，也框死了运行时格式。占位符、类型、说明符全在编译期核对，写错立刻红。但格式串也因此不能运行时构造；需要用户可配置模板的系统，得自己实现一层解析。安全性与灵活性在这里各占一半。

小工具丰富，文化问题出局。`std.mem` 里 trim、split、indexOf、startsWith 一应俱全，零分配的路径铺得很顺；过了 Unicode 码点这条线，标准库就退场了。字素、大小写、本地化排序，都要引入外部依赖，而且体量不小。中文用户对「大小写」无感，对「排序」有感，这块成本在中文项目里反而最常被低估。

---

回到开头那串问题。打印要 `{s}`，因为一串字节有多种解释，解释权在你。不能用 `==`，因为指针和内容都叫「相等」，Zig 不替你选。拼接要 allocator，因为新字符串要住进新内存。至于 `"听雨".len` 是 6，它本来就是六个字节，字才是两个。

前文谈切片，看借据与期限；谈指针，看信息如何随类型增减；谈分配器，看内存的来路如何写进签名。这一篇把这些线拧在「字符串」这根日常的轴上：所谓没有 string 类型，其实是把别的语言内置在 string 里的一堆默认决定（编码、比较、扩容、本地化）逐个拿了出来，各自写回明处。

一串字节躺在内存里，本身不是文字。是人来认领它：认领它的编码，认领它的边界，认领它的归属。Zig 只是不肯替你认领。
