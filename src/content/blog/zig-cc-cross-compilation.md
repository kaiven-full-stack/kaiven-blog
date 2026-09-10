---
title: 用 Zig 送 C 上路：zig cc 与一条命令的交叉编译
description: 同一个 hello.c，一条命令编出 aarch64 静态 ELF、Windows PE、musl 极简二进制——工具链一行没装。本文拆开 zig cc 的三层结构（clang 前端、LLVM 后端、随包携带的 libc 源码树），实测三目标交叉、musl 与 glibc 的体积账单、glibc 版本钉死的语法，以及它与 c-interop 的方向之别。实验在 Zig 0.16.0 上复核。
pubDate: 2026-09-10
category: zig
tags: [Zig, C, 工具链]
---

```text
zig cc -target aarch64-linux-musl hello.c -o hello-aarch64
zig cc -target x86_64-windows-gnu hello.c -o hello.exe
zig cc -target x86_64-linux-musl  hello.c -o hello-x64

三条命令，三个平台，零安装，零配置。
第一条产出静态链接的 ARM aarch64 ELF，
第二条是真正的 Windows PE 可执行文件，
第三条在你脚下的 x86_64 上直接跑了起来。
```

c-interop 篇讲过一个方向：C 代码进 Zig 项目，`@cImport` 把头文件翻译成 Zig 能用的声明。这一篇是它的镜像——**Zig 的工具链出去编译 C 项目**。`zig cc` 长得像 gcc、名字念起来也像 gcc，但它能在一条命令里把同一个 hello.c 送到几十个目标平台，不装任何额外的工具链。

这不是小把戏。交叉编译在 C 的世界里历来是「配置密集型劳动」：为目标平台装交叉 gcc、为目标平台装 libc、对付 sysroot 和搜索路径、祈祷版本对得上。zig cc 把这套流程折叠进了一个参数。本文拆开它凭什么：三层结构、一次实测、以及体积与版本钉死的两笔账单。实验在 Zig 0.16.0 上复核（本机 Arch 的 zig 0.16.0-1 包），产物验证以 `file(1)` 与 `objdump` 为准。

## 先看身份：zig cc 是谁

```text
$ zig cc --version
clang version 21.1.8
```

`zig cc` 的前端就是 **clang**——命令行接口、警告体系、语言扩展全部继承。实测 `-Wall -Wextra -Werror` 原样可用；clang 的每一个编译开关、每一条诊断，在 zig cc 上行为一致。网上现有的 C 项目不需要改 Makefile 里的编译器参数，把 `CC=zig cc` 就能过一遍。

但 zig cc 不是 clang 的换皮。它的真实结构是三层：

```text
clang 前端     解析 C/C++（zig c++ 同理）
LLVM 后端     生成目标机器码——LLVM 支持的所有架构
zig 的 libc    随包携带的整套 C 库源码，按目标即时编译
```

前两层是复用行业的现成成果；真正的魔法在第三层——**zig 的安装包里带着完整的 libc 源码树**。看一眼本机的安装：

```text
/usr/lib/zig/libc/
  musl/     9.4 MB     轻量 libc 完整源码
  glibc/    2.1 MB     GNU libc 的头文件与符号表
  mingw/   18   MB     Windows 目标的 CRT 与导入库
  darwin/ freebsd/ netbsd/ openbsd/ wasi/ ...
```

这就是「零安装交叉」的物质基础：目标平台的标准库不在目标平台上找，**直接从源码为你现编**。交叉工具链最疼的一环（目标 libc 从哪来）被源码分发消解了。

## 三段式目标：一个参数说清平台

交叉的全部接口只有一个 `-target`，语法是三段（或四段）式：

```text
-target <arch>-<os>-<abi>[.<version>]
              aarch64-linux-musl
              x86_64-windows-gnu
              x86_64-linux-gnu.2.17
```

实测三个方向，全部一次成功：

```text
-target aarch64-linux-musl    →  ELF 64-bit, ARM aarch64, statically linked
-target x86_64-windows-gnu    →  PE32+ executable for MS Windows (console)
-target x86_64-linux-musl     →  静态 ELF，本机直接运行输出 hello
```

对照一下传统路线的成本。本机的 gcc 为交叉目的**零**准备：想编 aarch64 得先装 `aarch64-linux-gnu-gcc` 加配套的 `aarch64-linux-gnu-glibc` 两三个包，每个目标平台重复一遍；而 zig 的目标清单（`zig targets`）覆盖几十种架构 × 一打操作系统 × musl/gnu 两系 libc——**全部装完就是装了个 zig**。

第四段版本钉死是交叉发布场景的杀器，值得单独看。

## musl 与 glibc：两种 libc，两种哲学

同一个 hello.c，两种链接形态的实测账单：

```text
-target x86_64-linux-gnu      动态链接 glibc      7,216 字节
-target x86_64-linux-musl     静态链接 musl   1,611,600 字节
-target x86_64-linux-musl -O2 -s               5,208 字节
```

三个数字背后是两条路线。**glibc 动态链接**：产物小，运行时依赖目标机的 libc——容器时代如鱼得水，但「拷到老机器上」要赌对方的 glibc 版本。**musl 静态链接**：libc 全部编进二进制，`readelf -d` 显示没有动态段——不依赖任何目标机环境，扔进 busybox 容器、scratch 镜像、旧内核都能跑。1.6MB 是 debug 信息没剥的毛坯，`-O2 -s` 之后 5KB 出头。

musl 静态产物是「发布单文件」的黄金组合：Go 社区繁荣的 CGO 交叉编译困局，一整套静态 musl 工具链就是被 `zig cc` 解决的（Go 官方 wiki 至今推荐用它给 CGO 做交叉）。

版本钉死的语法落在三段式第四段：

```text
-target x86_64-linux-gnu.2.17
```

意思是「链接 glibc，但符号版本最高只用到 2.17」——产物能在 CentOS 7 这类老系统上跑。实测 `objdump -p` 里依赖的最高符号版本立即降为 `GLIBC_2.2.5`。传统做法要在新系统上装老 glibc 的 sysroot 一顿折腾；zig 带着符号表（glibc 目录里的 `abilists`）按你的上限裁剪，**「在最新机器上编译、在最老机器上运行」从祈祷变成了参数**。

## 三层结构的必然推论

把结构拆开后，几个 zig cc 的特有行为就都是推论了：

**编译即重建 libc。** 第一次交叉到新目标会慢一拍（在编 musl），之后命中缓存飞快。代价是编译时间，换来的是「目标环境永远原生匹配」——不存在目标机 libc 与工具链 libc 版本错位的经典事故。

**编译器运行时也在包里。** compiler_rt、libunwind 随 zig 分发，`-rtlib=compiler-rt -unwindlib=libunwind` 是 zig cc 的默认——不依赖目标的 libgcc。纯 C 项目感知不到，C++ 项目的异常栈展开因此在哪个目标上都成立。

**`zig ar`、`zig c++`、`zig ranlib` 一并存在。** 实测 `zig cc -c` 产出目标文件、`ar rcs` 打包静态库——一整套 C 构建的低层工具，一个二进制全齐。CI 镜像从「gcc + 交叉 gcc × N + 各平台 libc」缩成一个 zig 的下载体积。

**build.zig 的目标是一等公民。** `zig build -Dtarget=aarch64-linux-musl` 实测产出静态 aarch64 产物——build 系统篇讲过的 standardTargetOptions，底层走的就是这套机制；C 代码作为构建的一部分参与时（addCSourceFiles），交叉能力自动继承。

顺带一个 0.16 的新变化：**translate-c 的 C 前端已从 clang 换成了自研的 Aro**——实测 `zig translate-c` 输出里带着 `__VERSION__ = "Aro aro-zig"`。头文件翻译这条 c-interop 的老路换了引擎，但 `zig cc` 本体仍是 clang 前端，两件事别混为一谈。

## 方向之别：与 c-interop 篇的对照

两篇并排放，Zig 与 C 的关系就完整了：

```text
c-interop 篇（C 进 Zig）     @cImport / translate-c 把 C 声明翻译成 Zig
                             Zig 调 C，C 的世界适配 Zig 的规则

本篇（Zig 送 C 上路）        zig cc 把 Zig 的工具链借给 C
                             C 还是 C，只是编译它的机器变了
```

同一个 border，两个通关方向。前者解决「新项目想用存量 C 库」，后者解决「存量 C 项目想要现代工具链」——zig cc 的真实用户大多一个 Zig 文件都不写：他们只是想要一个 5MB 的、能交叉编译一切的单文件工具链。

## 账单，按层再算一遍

**zig cc = clang 前端 + LLVM 后端 + 随包 libc。** 前端照抄 clang（-Wall/-Werror 全兼容），后端继承 LLVM 的全架构，第三层是魔法本体——musl 9.4MB、glibc 2.1MB、mingw 18MB 的源码树随包分发，按目标即时编译。

**交叉的完整接口是 -target 三段式。** arch-os-abi（-version）一个参数说清平台；实测三目标零配置成功，对照传统路线每平台两三个包的安装成本。

**musl 静态与 glibc 动态各有账本。** 静态 1.6MB 毛坯 / 5KB 精修，无动态段、无目标依赖；动态 7KB 但赌目标环境。CGO 交叉的事实标准就是它。

**第四段钉死 glibc 版本。** `x86_64-linux-gnu.2.17` 让新机器的编译产物跑在老机器上，符号版本按 abilists 裁剪——从 sysroot 折腾降维成一个数字。

**一套工具链，多种身份。** cc/c++/ar/ranlib 与 build.zig 的 -Dtarget 同源；CI 镜像的体积从工具链矩阵缩成一个二进制。

---

```text
gcc 交叉 aarch64：装两个包，配 sysroot，对版本，试运行。
zig cc 交叉 aarch64：-target aarch64-linux-musl，回车。
慢的那一拍，是它在替你现编一个 aarch64 的 libc。

你等的不是编译器，是那间为你新盖的厨房。
```

交叉编译的难，从来不在编译器——LLVM 早就能生成任何架构的机器码。难在目标平台的世界：它的 libc、它的启动文件、它的符号版本。zig cc 的贡献是把整个目标世界装进了源码里随身携带，需要时现场编译。「工具链」这个词的字面意思被它还原了：一条链，从一个包通向所有平台。

---

本文是 Zig 系列的第二十篇，与《两国共用一座桥：Zig 与 C 的互操作边界》互为镜像——那边是 C 代码进 Zig，这边是 Zig 工具链送 C 出门。构建系统的目标机制见《构建脚本也是程序》；musl 静态产物的「无依赖」哲学，与《一串字节，各自认领》的显式所有权一脉相承。
