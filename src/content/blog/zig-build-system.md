---
title: 构建脚本也是程序：为什么 build.zig 长这样
description: 没有 Makefile 的隐式规则，没有 CMake 的专属语言，Zig 把构建写成一段普通代码，把依赖写成一份带哈希的清单，把交叉编译做成了默认能力。命令与输出取自 Zig 0.16.0 本机实测。
pubDate: 2026-09-09
category: zig
tags: [Zig, 编程语言]
---

写 Zig 的头几天，语言本身未必劝退人，工具链先给了下马威：装完 Zig 发现没有 `zig install`，教程说构建要写 `build.zig`，打开一看是个 Zig 源文件，长得跟业务代码一模一样；想装个依赖，发现没有 `zig install some-package`，要拿 URL 去换哈希。

这篇把这套路子看个明白。我的结论是：它不是没做完的工具链，是一套想清楚了的主张。构建逻辑不该有专属语言，依赖不该有中央仓库，交叉编译不该是稀罕事。命令与输出都来自 Zig 0.16.0 的本机实跑。

## 一条命令，两个世界

先把最小的那条路走通。单个文件，不需要任何构建系统：

```console
$ zig run single.zig
单文件，直接跑
```

`zig run` 编译、缓存、执行一步到位。`zig test unit.zig` 同理，文件里的 `test` 块直接跑。写实验、写脚本、学习语言本身，这个世界够用了，连 `build.zig` 都不需要。

另一条世界从项目开始。`zig init` 给你三个文件：

```console
$ zig init
info: created build.zig
info: created build.zig.zon
info: created src/main.zig
info: created src/root.zig
```

然后就是那个著名的口令：

```console
$ zig build run
All your codebase are belong to us.
```

从 `zig init` 到程序跑起来，本机实测 2.5 秒，其中还包含把构建脚本本身编译一遍的时间。两个世界的分界线很清楚：单文件走命令，项目走 `build.zig`，没有中间形态。

而 `zig build` 这个命令本身，值得先看清它是什么。它不带内置规则，不知道 C 文件该怎么编，也不知道头文件去哪儿找。它只做一件事：在项目根目录找到 `build.zig`，把它当作普通 Zig 程序编译执行，然后照着它搭出来的依赖图干活。用 `--verbose` 看，能看到底下真正执行的编译命令：

```text
/usr/bin/zig build-exe -ODebug --dep config
  -Mroot=/tmp/zig-build-verify/src/main.zig
  -Mconfig=.zig-cache/c/94d269.../options.zig ...
```

构建系统完全在用户态实现，不碰编译器私有接口。这句话的含义后面会反复出现。

## build.zig 是代码，不是配置

`zig init` 生成的 `build.zig` 去掉注释，骨架是这样：

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "tingyu",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);

    const run_step = b.step("run", "Run the app");
    const run_cmd = b.addRunArtifact(exe);
    run_step.dependOn(&run_cmd.step);
}
```

逐行看它有多普通：`@import` 是平常的导入，`b.addExecutable` 是平常的函数调用，`.name = "tingyu"` 是平常的结构体字面量。没有 `add_executable()` 这样的全大写指令，没有 `if(WIN32)` 这样的专属条件语法，没有字符串拼出来的路径。

要条件判断，直接写 `if`；要循环生成十个目标，直接写 `for`；要算个版本号、读个环境变量、解析个 JSON 配置，标准库就在手边。这是构建脚本与 DSL 的根本区别：DSL 的表达能力是设计者枚举出来的，脚本的表达能力是图灵完备的，因为它们根本就是同一种代码。

证据是报错。构建脚本写错了类型，得到的就是普通 Zig 编译错误：

```zig
pub fn build(b: *std.Build) void {
    const wrong: u32 = "字符串";
}
```

```text
build.zig:3:24: error: expected type 'u32', found '*const [9:0]u8'
```

文件名、行列号、类型信息，跟你写业务代码时一模一样。写 CMake 报错时那种「错误发生在 200 行之外的生成代码里」的体验，这里没有，因为没有生成代码。

但有一个反直觉的地方必须说透：`build` 函数看着是命令式的，实际却不执行构建。它做的是「搭图」：创建节点（`addExecutable`、`addRunArtifact`），连边（`dependOn`），然后返回。真正编译、链接、运行的是外部的 runner，它按图调度，能并行的并行，能跳过的跳过。`zig init` 生成的注释里专门强调了这一点。

这也是为什么构建脚本里不该有副作用：它每次都会被完整执行（改了构建脚本，就得重新搭一遍图），你的 `print` 会出现在每次构建里，而文件操作会做一遍又一遍。想「做事」，把它挂成图上的一个节点。

## 依赖：URL 换哈希

加第三方库是另一处「不适应」的重灾区，因为找不到 `zig install`。Zig 的包管理没有中央仓库，不发布到 npm 或 crates.io，流程是反过来的。

第一步，拿 URL 换哈希：

```console
$ zig fetch --save https://github.com/mitchellh/libxev/archive/master.tar.gz
libxev-0.0.0-86vtcwIRFADbH4hk-EjROXxlrKIRPQdA41XiTSytYO-F
```

这条命令做三件事：下载、算哈希、写进 `build.zig.zon`。它是包管理的全部命令行界面。

`build.zig.zon` 是包的清单，刚才那条命令之后多了这些：

```zig
.dependencies = .{
    .libxev = .{
        .url = "https://github.com/mitchellh/libxev/archive/master.tar.gz",
        .hash = "libxev-0.0.0-86vtcwIRFADbH4hk-EjROXxlrKIRPQdA41XiTSytYO-F",
    },
},
```

注意 `zon` 的格式：它不是 JSON，是 Zig 自己的匿名结构体字面量。读文件和读代码用同一套语法。

第二步，在 `build.zig` 里接线：

```zig
const exe = b.addExecutable(.{
    .name = "tingyu",
    .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "libxev",
              .module = b.dependency("libxev", .{}).module("xev") },
        },
    }),
});
```

第三步，源码里直接 import：

```zig
const xev = @import("libxev");
```

三步走完，编译通过。

这套设计里最重要的是那个哈希。Zon 注释里写着一句关键的话：包不来自 URL，包来自哈希；URL 只是获取这个哈希对应内容的镜像之一。哈希是从包目录内容算出来的（由 `paths` 字段圈定哪些文件算数），所以 URL 挂了可以换镜像，内容变了就是另一个包。防投毒靠它，可复现构建也靠它。把故意改错的哈希放回去，报错很干脆：

```text
build.zig.zon:37:21: error: hash mismatch: manifest declares
libxev-0.0.0-86vtcwIRFADbH4hk-EjROXxlrKIRPQdA41XiTSytYO-0
but the fetched package has ...-EjROXxlrKIRPQdA41XiTSytYO-F
```

没有中央仓库的代价也直说：找包没有统一入口，得靠 GitHub 上的 awesome-zig 这类清单或者 zkp 这种第三方索引；同一个库不同 fork 的身份靠 `fingerprint` 字段区分，而那个字段背后有一整套关于「敌意 fork」的立场，zon 里生成的注释原文说，不维护的上游如果还活着，fork 改 fingerprint 就是恶意的。包管理把信任问题写进文本，而不是藏在注册表后面。

## 交叉编译是默认能力

这一节是 Zig 工具链最反常识的地方：交叉编译不需要任何准备。

刚才那个项目，一条参数就能编给四个平台：

```console
$ zig build -Dtarget=aarch64-linux
$ zig build -Dtarget=x86_64-windows
$ zig build -Dtarget=aarch64-macos
$ zig build -Dtarget=x86_64-linux-musl
```

验证 `file` 的输出，四个产物各归各的格式：

```text
ELF 64-bit LSB executable, ARM aarch64, statically linked
PE32+ executable for MS Windows 6.00 (console), x86-64
Mach-O 64-bit arm64 executable
ELF 64-bit LSB executable, x86-64, statically linked (musl)
```

没有 `--host`、`--target` 配对，没有工具链文件，没有 sysroot 折腾。`zig targets` 数一数，这套工具链认识 58 种 CPU 架构、42 种操作系统。秘密在两处：一是编译器自带所有目标的代码生成后端和 libc 源码（musl、mingw-w64 随二进制发行，链接时现编）；二是交叉编译根本不是特殊路径，本机编译只是 target 恰好等于 host 的普通编译。

连 C 代码也享受同等待遇。`zig cc` 是个披着 gcc 外皮的 Zig 编译器前端：

```console
$ zig cc -target aarch64-linux-musl -o hello-aarch64 hello.c
$ file hello-aarch64
ELF 64-bit LSB executable, ARM aarch64, statically linked
```

它可以原样替换项目里的 `cc`：`CC="zig cc"` 塞进任何 Makefile，普通 C 项目立刻获得全平台交叉编译。Zig 社区流传的用法还包括拿它当日常 C 编译器，顺便白拿确定性和缓存。

对个人项目，这套能力的实际含义是：你在 Linux 上写完，顺手产出 Windows 和 macOS 的可执行文件，不用配 CI 矩阵，不用装 MinGW。

## 缓存：第二次构建 0.1 秒

```console
$ zig build          # 改动后
$ zig build          # 紧接着再跑一次
```

第二次实测 0.1 秒。缓存以内容哈希为键，按「输入没变输出就不会变」的原则复用一切可复用的东西：编译产物、构建脚本本身、fetch 下来的依赖。缓存分两层：项目内 `.zig-cache` 和全局 `~/.cache/zig`，依赖包落在全局层，所以十个项目用同一个库只存一份。

前面说的「构建系统在用户态」在这里兑现了价值：既然构建只是普通程序，它的输入输出就能被完整哈希追踪。C 时代那些「改了头文件不重编、只好 `make clean`」的祖传疑难，根源是构建系统看不见编译器的真实输入；Zig 的编译器和构建系统是一家人，输入输出都对得上。

`zig build --watch` 把这套做成了常驻模式：进程挂着，每次存盘后自动重新搭图、增量构建。实测两次改动文件，日志里多出两次 `Build Summary: 4/4 steps succeeded`，几乎无感。

## 那些 -D 选项从哪来

`zig build --help` 列出的项目选项，是构建脚本自己注册的：

```text
Project-Specific Options:
  -Dtarget=[string]            The CPU architecture, OS, and ABI to build for
  -Dcpu=[string]               Target CPU features to add or subtract
  -Doptimize=[enum]            Debug / ReleaseSafe / ReleaseFast / ReleaseSmall
```

`standardTargetOptions` 和 `standardOptimizeOption` 就是两个普通函数，把 `-Dtarget`、`-Doptimize` 注册进构建图。你看到它们出现在 `--help` 里，是因为它们被调用了；不调用，就没有这些选项。

自定义选项一样，两行：

```zig
const slogan = b.option([]const u8, "slogan", "写进二进制的口号") orelse "听雨";

const options = b.addOptions();
options.addOption([]const u8, "slogan", slogan);
exe.root_module.addOptions("config", options);
```

然后从源码里当模块导入：

```zig
const config = @import("config");

pub fn main() void {
    std.debug.print("口号: {s}\n", .{config.slogan});
}
```

```console
$ zig build run
口号: 听雨
$ zig build run -Dslogan="夜阑卧听风吹雨"
口号: 夜阑卧听风吹雨
```

构建参数变成编译期常量进二进制，类型检查全程在岗。C 时代靠 `#define` 生成头文件、CMake 时代靠 `configure_file` 模板替换的那件事，在这里是「两个函数调用加一个 import」。

顶层 step 同理。`zig build --help` 里的 Steps 清单，就是构建脚本里 `b.step(...)` 的镜像：

```zig
const greet_step = b.step("greet", "打印一句问候");
```

```text
Steps:
  install (default)            Copy build artifacts to prefix path
  greet                        打印一句问候
  run                          Run the app
```

命令行界面不是配置出来的，是代码执行出来的副产品。这也是「构建脚本是程序」最直接的体现：`--help` 的内容，取决于你的代码调用了什么。

## 这套工具链的代价

DSL 换成了编程语言，门槛换了形状。CMake 学的是语法，Zig 构建学的是 API：`std.Build` 里 93 个公开函数，加上 module、step、artifact 的概念图。对会 Zig 的人这是零额外成本；对不会的人，改一行构建配置也得先入门一门语言。团队里「只有一个人懂构建」的风险，从「那个人懂 CMake」变成「那个人懂 Zig」，并没有消失，只是换了宿主。

没有中央仓库，生态是去中心化的。好处是无审查、无下架、无单点故障，哈希锚定了内容就不怕镜像作恶；代价是发现性差，找包靠社区清单，质量靠自行甄别，供应链审计得自己拉清单。拿 npm 的便利去比，差距是真实存在的；拿 crates.io 的封禁风波去比，这边的立场也有它的道理。

交叉编译的顺滑有边界。纯 Zig、或者依赖 musl/mingw 能覆盖的 C 世界，一路绿灯；可一旦链接平台专属的闭源 SDK，比如 Windows 的 MSVC 运行库、macOS 的非自由框架，`zig cc` 就得退回宿主工具链。交叉编译免的是配置成本，免不掉平台本身的授权约束。

缓存把磁盘吃得很实在。本机这个实验项目缓存 217 MB，还只是个 hello world 量级的项目。项目缓存、全局缓存、每个 target 一份，攒得很快。省下的是时间，花掉的是磁盘，`zig build --cache-dir` 和定期清理是自己要记着的事。

脚本即代码，也意味着脚本会烂。构建逻辑获得了全部表达能力，也就获得了全部搞砸的能力：构建脚本里连数据库、发 HTTP 请求都做得到。图不追踪副作用，副作用就不受缓存约束，写出「每次构建都悄悄打一次网络请求」的 build.zig 易如反掌。

---

回头看这一路的「不适应」，每一处都有来历。没有 `zig install`，因为安装即编译、编译有缓存。构建脚本是源文件，因为 DSL 表达不了的东西不该靠语法糖硬凑。依赖靠 URL 换哈希，因为信任应该锚定在内容上而不是注册表上。交叉编译不用配置，因为它本来就不该是一条特殊路径。

前文谈语言：分配器把内存来路写进签名，错误把传播和清理拆开，comptime 把宏、模板、反射收进同一个机制。这一篇是同一套审美在工具链上的投影：别留隐式规则，别造平行宇宙。构建世界和代码世界共用一门语言、一套类型系统、一次编译验证。

它确实要多学点东西才开始顺手。但两个世界之间没有那道墙，写代码的人和写构建的人不再隔着一套专属语言相望。多学的这一点东西，在构建脚本和业务代码里是同一套。
