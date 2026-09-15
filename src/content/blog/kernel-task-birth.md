---
title: clone 这扇门：进程与线程的出生
description: glibc 2.44 的 fork() 并不发 fork 系统调用——自写 ptrace 量具抓到的是 clone(0x1200011)，pthread_create 发的是 clone3(0x3d0f00)，九个 flag 与 glibc 源码逐位对上，连内核自己生内核线程的 kernel_thread 也进同一个 kernel_clone：内核没有线程专供通道，进程与线程的差别只是报关单上写「复制」还是「共享」。出生的价钱当场量出：fork+exit 中位 159.3µs、线程 34.5µs、vfork 30.0µs，第一个冷线程 115.2µs 几乎追平 fork，账单是那条 8MiB 栈的 mmap。线程随手 close 一个 fd，主线程 EBADF；线程 chdir，全进程跟着搬家——CLONE_FILES 与 CLONE_FS 的可感后果实测当场。pid 仍旧严格 +1 顺序发放，账本却从 bitmap 换成了基数树旋转游标，65535 时代的 8KB 算术按本机 pid_max=4194304 重算成 512KB。实测于本机 Linux 7.2.3、glibc 2.44、gcc 16.2.1，内核源码对照 vanilla v7.2，glibc 对照官方 glibc-2.44 tag。
pubDate: 2026-09-23
category: kernel
tags: [Linux, 内核, 进程管理]
---

内核系列的前九篇把内存的账收束了：主线七篇沿着一次访存从页表走到 OOM，番外两篇结清了内存的出身和两种栈。讲的都是空间。从这篇起开一条新线，讲内核的另一半营生：一个任务的一生——怎么出生、怎么换装、怎么排队、怎么被挑中、怎么被换下。

第一站，出生。开场两个悬案。

悬案一：C 程序里写 `fork()`，glibc 2.44 发给内核的却**不是 fork 系统调用**。本机没有 strace，我拿 ptrace 自己写了个百来行的抓取量具，抓到的是 `clone`，flags=0x1200011；旁边的 `pthread_create` 发的是 `clone3`，flags=0x3d0f00。两个名字都对不上的创建 API，进内核走的竟是同一扇门，连门牌号都是 glibc 现改的。

悬案二：主线程打开 fd 3，子线程把它 close 了，主线程再用——Bad file descriptor。子线程 `chdir("/tmp")`，主线程的工作目录跟着搬了家。进程之间相互隔离可以理解，线程不是「轻量级进程」吗，这 fd 到底是谁的家产？

两个悬案是同一个答案：内核里没有「进程」「线程」两套机构，只有一种东西叫**任务**（task），登记在 `task_struct` 上；进程与线程的差别，只是进门时那张报关单（clone flags）上写的是「复制」还是「共享」。

实验环境沿用番外：本机 Linux 7.2.3（AMD Ryzen 5 5500U，6 核 12 线程），glibc 2.44，gcc 16.2.1；内核源码对照 vanilla v7.2，glibc 对照官方 glibc-2.44 tag。本机没有 strace、perf，也没有 root，量具全部自己写，普通用户态就能跑，存档在 `~/proc-lab`。

## 内核的户口本只有一种人

操作系统教科书里，进程有 PCB，线程有 TCB，是两张证。Linux 只发一种证：`task_struct`，定义在 `include/linux/sched.h`，一千多行。挑最要紧的几组字段（行号是 v7.2 的）：

```c
// file: include/linux/sched.h（v7.2，节选）
struct task_struct {
	unsigned int			__state;	// :834  运行/睡眠状态
	int				prio;		// :875  调度优先级（还有 static/normal/rt_priority）
	struct mm_struct		*mm;		// :971  地址空间（旁边还有个 active_mm）
	pid_t				pid;		// :1071 内核发的号
	pid_t				tgid;		// :1072 线程组号 = 用户眼里的 PID
	struct task_struct __rcu	*parent;	// :1088 进程树：父
	struct list_head		children;	// :1093 进程树：子
	struct task_struct		*group_leader;	// :1095 线程组组长
	struct fs_struct		*fs;		// :1194 cwd 与根目录
	struct files_struct		*files;		// :1197 fd 表
	struct nsproxy			*nsproxy;	// :1205 命名空间（容器的基石）
	......
};
```

状态、优先级、地址空间、两个号、进程树、目录、fd 表、命名空间——一个任务的全部家当都挂在这个结构体上。后面几篇讲调度、讲 exec 换装，翻的都是这张证。

证上有两个号，这是悬案二的钥匙孔。`pid` 是内核给每个任务发的唯一编号；`tgid` 是线程组号，组内所有任务共享同一个值。用户态的 `getpid()` 返回的是哪个？v7.2 `kernel/sys.c:999`，三行：

```c
SYSCALL_DEFINE0(getpid)
{
	return task_tgid_vnr(current);
}
```

**返回的是 tgid**。所以同一进程里的一千个线程调 `getpid()` 得到同一个数，符合直觉；而内核给它们发的 `pid` 各不相同。用户看到的「PID」和内核账本上的 `pid`，压根是两个字段。写个量具当场验证（`~/proc-lab/identity.c`）：

```
[主线程] getpid()=372270  gettid()=372270
[status] Tgid:	372270
[status] Pid:	372270
[status] Threads:	1
[线程]   getpid()=372270  gettid()=372271
[线程]   thread-self/status Tgid:	372270
[线程]   thread-self/status Pid:	372271
```

主线程的 pid 和 tgid 重合（它自己就是组长）；子线程 `getpid()` 仍是 372270，`gettid()` 才是 372271。`/proc/thread-self/status` 里两个字段明明白白分家：Pid 是内核的号，Tgid 是用户的号。顺带一提，372271 正好是 372270 的下一个号——线程的 tid 和进程的 pid 从同一个号段发放，一千个线程就要吃掉一千个号，这点后面讲 pid 分配时还会回来。

那没有地址空间的任务呢？`copy_mm` 里有个分支（v7.2 `kernel/fork.c:1568`）：

```c
// file: kernel/fork.c:1568（v7.2，节选）
static int copy_mm(u64 clone_flags, struct task_struct *tsk)
{
	tsk->mm = NULL;
	tsk->active_mm = NULL;

	oldmm = current->mm;
	if (!oldmm)
		return 0;	// 爹没有地址空间，儿子也不发
	......
}
```

内核线程的 `mm` 是 NULL——它们只跑在内核地址空间里，那段地址空间人人共享，不需要自己带页表。[两种栈番外](/posts/kernel-two-stacks/)里那句「ksoftirqd 该叫内核线程而不是内核进程」的判断标准（有没有独立地址空间），源头就在这个分支。当场验证：kthreadd（pid 2，所有内核线程的祖先）的 `/proc/2/maps` 是 0 字节，`cmdline` 也是 0 字节——没有地址空间，也没有用户态命令行。这台机器上这样的任务有四百五十多个（数了两遍，466 和 455，kworker 来了又走，数目是活的），kcompactd、ksmd、khugepaged，全是干内核自己活儿的。

## 一扇门，四个入口

现在回到悬案一。先看内核侧的门：v7.2 里 fork、vfork、clone、clone3 四个系统调用，最后全进同一个 `kernel_clone()`（`kernel/fork.c:2694`）：

```c
// file: kernel/fork.c（v7.2，节选）
SYSCALL_DEFINE0(fork)			// :2828
{
	struct kernel_clone_args args = {
		.exit_signal = SIGCHLD,
	};
	return kernel_clone(&args);
}

SYSCALL_DEFINE0(vfork)			// :2844
{
	struct kernel_clone_args args = {
		.flags		= CLONE_VFORK | CLONE_VM,
		.exit_signal	= SIGCHLD,
	};
	return kernel_clone(&args);
}
```

fork 的报关单上只有一个 exit_signal；vfork 多带两个 flag，CLONE_VM（共享地址空间）加 CLONE_VFORK（挂起父进程直到子进程 exec 或 _exit）——后面量价钱时会看到这是三种出生里最便宜的。连内核自己生内核线程也走这扇门（`kernel/fork.c:2797`）：

```c
pid_t kernel_thread(int (*fn)(void *), void *arg, const char *name,
		    unsigned long flags)
{
	struct kernel_clone_args args = {
		.flags		= ((flags | CLONE_VM | CLONE_UNTRACED) & ~CSIGNAL),
		.fn		= fn,
		.kthread	= 1,
		......
	};
	return kernel_clone(&args);
}
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 320" role="img" aria-label="四个入口一扇门：fork() 被 glibc 换成 clone(0x1200011)，vfork() 直进 SYS_vfork，pthread_create 被 glibc 换成 clone3(0x3d0f00)，内核的 kernel_thread() 也进同一个 kernel_clone，再到 copy_process 流水线和 wake_up_new_task" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernTBAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">四个入口，一扇门：flags 是进门时递进去的报关单</text>
<rect class="bx" x="20" y="40" width="145" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="92" y="60" text-anchor="middle" font-size="12.5" fill="#2b2a26">fork()</text>
<text class="ts" x="92" y="78" text-anchor="middle" font-size="10.5" fill="#6b675e">glibc 换成 clone</text>
<text class="tc" x="92" y="95" text-anchor="middle" font-size="10.5" fill="#b03a2e">实测 0x1200011</text>
<rect class="bx" x="177" y="40" width="145" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="249" y="60" text-anchor="middle" font-size="12.5" fill="#2b2a26">vfork()</text>
<text class="ts" x="249" y="78" text-anchor="middle" font-size="10.5" fill="#6b675e">直进 SYS_vfork</text>
<text class="ts" x="249" y="95" text-anchor="middle" font-size="10.5" fill="#6b675e">VFORK|VM+SIGCHLD</text>
<rect class="bx" x="334" y="40" width="145" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="406" y="60" text-anchor="middle" font-size="12.5" fill="#2b2a26">pthread_create</text>
<text class="ts" x="406" y="78" text-anchor="middle" font-size="10.5" fill="#6b675e">glibc 换成 clone3</text>
<text class="tc" x="406" y="95" text-anchor="middle" font-size="10.5" fill="#b03a2e">实测 0x3d0f00</text>
<rect class="bx" x="491" y="40" width="149" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="565" y="60" text-anchor="middle" font-size="12.5" fill="#2b2a26">kernel_thread()</text>
<text class="ts" x="565" y="78" text-anchor="middle" font-size="10.5" fill="#6b675e">内核内部生娃</text>
<text class="ts" x="565" y="95" text-anchor="middle" font-size="10.5" fill="#6b675e">VM|UNTRACED, kthread=1</text>
<line class="fl" x1="92" y1="104" x2="205" y2="146" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernTBAs1)"/>
<line class="fl" x1="249" y1="104" x2="275" y2="146" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernTBAs1)"/>
<line class="fl" x1="406" y1="104" x2="385" y2="146" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernTBAs1)"/>
<line class="fl" x1="565" y1="104" x2="455" y2="146" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernTBAs1)"/>
<rect class="bx-q" x="140" y="150" width="380" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="173" text-anchor="middle" font-size="13.5" fill="#2b2a26">kernel_clone()　kernel/fork.c:2694</text>
<text class="ts" x="330" y="193" text-anchor="middle" font-size="11" fill="#6b675e">唯一的门：用户进程、线程、内核线程都从这进</text>
<line class="fl" x1="330" y1="206" x2="330" y2="236" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernTBAs1)"/>
<rect class="bx" x="140" y="240" width="380" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="263" text-anchor="middle" font-size="13" fill="#2b2a26">copy_process 流水线 → wake_up_new_task</text>
<text class="ts" x="330" y="283" text-anchor="middle" font-size="11" fill="#6b675e">新任务挂上某个 CPU 的运行队列，等着被调度</text>
</svg>
</figure>

内核侧的门一直开着，可 glibc 偏偏不用 fork 那扇。为什么？抓包量具已经给出了线索：fork() 发的 clone 带着 0x1200011。拆开看，低字节 0x11 = 17 = SIGCHLD，和内核 fork 系统调用自带的 exit_signal 一样；高位的两个 flag 是内核 fork 入口**没有**的：

```c
// file: sysdeps/unix/sysv/linux/arch-fork.h（glibc 2.44）
static inline pid_t
arch_fork (void *ctid)
{
  const int flags = CLONE_CHILD_SETTID | CLONE_CHILD_CLEARTID | SIGCHLD;
  ......
  ret = INLINE_SYSCALL_CALL (clone, flags, 0, NULL, 0, ctid);
  ......
}
```

调用点在 `sysdeps/nptl/_Fork.c:33`：`arch_fork (&THREAD_SELF->tid)`——ctid 传的是 pthread 描述符里 tid 字段的地址。这两个 flag 的作用写在 arch-fork.h 的注释里：CHILD_SETTID 让内核在**子进程那份内存里**把子进程自己的 tid 写进这个地址；CHILD_CLEARTID 让内核在子进程退出时把这个地址清零、并对它做一次 futex 唤醒。

为什么 fork 需要这个？因为 fork 出来的子进程继承的是父进程全部内存，包括 pthread 库自己的数据结构——描述符里存的还是**父进程**的 tid。子进程从此是个独立的单线程进程，它的 libc 得知道自己的真实 tid（futex、robust list 都靠它）。glibc 选择让内核在 clone 时顺手改写，而不是 fork 完再补一次系统调用。CLEARTID 那半则是给「等这个任务死」的人一个 futex 位点—— pthread_join 等线程、vfork 的父进程等子进程，用的是同一套机制。

再看线程那扇。glibc 2.44 的 `nptl/pthread_create.c:280`：

```c
// file: nptl/pthread_create.c（glibc 2.44，节选）
  const int clone_flags = (CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SYSVSEM
			   | CLONE_SIGHAND | CLONE_THREAD
			   | CLONE_SETTLS | CLONE_PARENT_SETTID
			   | CLONE_CHILD_CLEARTID
			   | 0);
  struct clone_args args =
    {
      .flags = clone_flags,
      .parent_tid = (uintptr_t) &pd->tid,
      .child_tid = (uintptr_t) &pd->joinstate,
      .stack = (uintptr_t) stackaddr,
      .stack_size = stacksize,
      ......
    };
```

九个 flag，加上 clone_args 里把线程栈的地址和大小直接递给内核。我用抓取量具对着 `pthread_create` 抓到的 0x3d0f00，逐位展开正好是这九个：

```
$ ./clonetrace ./tracedemo
clone  flags=0x1200011  [CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID]  exit_signal=17 (SIGCHLD)
vfork  (无 flags 参数)
clone3 flags=0x3d0f00  [CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID]
```

量具读数与两边源码完全咬合。注意线程的报关单上没有 exit_signal——glibc 源码里那行注释写着 "The termination signal is chosen to be zero which means no signal is sent"：线程死不给父发信号，pthread_join 靠的是 CHILD_CLEARTID 那个 futex 位点（child_tid 指向 `pd->joinstate`）。

把两张报关单并排放：

| flag | fork()（glibc 代发） | pthread_create（clone3） | 一句话含义 |
|---|---|---|---|
| exit_signal=SIGCHLD | ✓ | —（为 0） | 子进程死后怎么通知爹 |
| CLONE_CHILD_SETTID | ✓ | — | 出生时把 tid 写进**子**方内存 |
| CLONE_CHILD_CLEARTID | ✓ | ✓ | 退出时清零 tid 并 futex 唤醒 |
| CLONE_PARENT_SETTID | — | ✓ | 出生时把 tid 写进**父**方内存（pd->tid） |
| CLONE_VM | — | ✓ | 共享地址空间 |
| CLONE_FS | — | ✓ | 共享 cwd / 根目录 |
| CLONE_FILES | — | ✓ | 共享 fd 表 |
| CLONE_SIGHAND | — | ✓ | 共享信号处理表 |
| CLONE_THREAD | — | ✓ | 进同一个线程组（tgid 不变） |
| CLONE_SYSVSEM | — | ✓ | 共享 SysV 信号量 undo 表 |
| CLONE_SETTLS | — | ✓ | 给新线程装 TLS |

进程和线程的全部区别，就是右列比左列多出来的那几个勾。下面看内核拿到报关单后怎么干活。

## copy_process 流水线

`kernel_clone` 的核心是 `copy_process`：把 `current`（当前任务）当模板，复制出一个新任务。v7.2 的流水线（行号为 `kernel/fork.c`）：

```
:2115  dup_task_struct()    slab 里取一块 task_struct，整体拷贝，再配一条新内核栈
:2277  copy_files()         fd 表：CLONE_FILES ? 共享 : 复制
:2280  copy_fs()            cwd/root：CLONE_FS ? 共享 : 复制
:2283  copy_sighand()       信号处理表
:2286  copy_signal()        信号队列与统计
:2289  copy_mm()            地址空间：CLONE_VM ? 共享 : dup_mm 复制页表
:2292  copy_namespaces()    命名空间：CLONE_NEW* ? 新建 : 共享
:2305  alloc_pid()          从基数树里领号
:2367  p->tgid = (flags & CLONE_THREAD) ? current->tgid : p->pid
:2779  wake_up_new_task(p)  挂上运行队列
```

每一步都是同一个句式：**查报关单，决定复制还是共享**。挑三步看细节。

第一步 `dup_task_struct`，v7.2 `kernel/fork.c:184`：`task_struct` 从专用 slab 缓存 `task_struct_cachep` 里取——这就是 [slab 篇](/posts/kernel-slab-slub/)讲的「内核的 pymalloc」：高频对象预备好货架，随取随还。取出来 `*dst = *src` 整体赋值，注意这一步复制的只是结构体本身，里面的 `mm`、`files` 都还是指针，指向和父进程相同的对象——真正决定分家还是共享的，是后面那串 copy_xxx。每个任务还会配一条**新的内核栈**（`alloc_thread_stack_node`，本机 CONFIG_VMAP_STACK=y，16KB，vmalloc 空间映射）——[两种栈番外](/posts/kernel-two-stacks/)讲的是用户栈，内核栈是另一本账，任务人手一条，谁也不共享。

第二步 `copy_mm`，前面引过：CLONE_VM 就 `mmget(oldmm)` 引用计数加一，否则 `dup_mm` 新建地址空间。`dup_mm` 复制的是 **VMA 清单和页表，不复制数据页**——页表项全部标记只读，谁先写谁触发缺页再复制那一页，这就是[写时复制篇](/posts/kernel-copy-on-write/)的全部内容；Redis 的 BGSAVE 敢对几个 GB 的内存 `fork()`，赌的就是「子进程只读不写」（[Redis fork 篇](/posts/redis-fork-cow/)）。

第三步 tgid 赋值（`:2367`）：带了 CLONE_THREAD 就加入父亲的线程组（tgid 继承），否则自任组长（tgid = 自己的 pid）。「进程是线程组组长」不是比喻，是这一行代码。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 372" role="img" aria-label="同一样家产两种命运：左侧 fork 不带共享 flag，子任务得到自己的 mm、fs、files 各一份新副本；右侧 pthread_create 带 CLONE_VM、FS、FILES，两个任务指向同一份 mm、fs、files，只是引用计数加一" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernTBAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一样家产，两种命运：报关单决定复制还是共享</text>
<text class="t" x="30" y="52" font-size="12.5" fill="#2b2a26">fork()：无共享 flag</text>
<rect class="bx" x="30" y="66" width="100" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="80" y="86" text-anchor="middle" font-size="12" fill="#2b2a26">父任务</text>
<text class="ts" x="80" y="102" text-anchor="middle" font-size="10" fill="#6b675e">task_struct</text>
<rect class="bx" x="170" y="56" width="128" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="234" y="72" text-anchor="middle" font-size="10.5" fill="#2b2a26">mm（页表新抄）</text>
<rect class="bx" x="170" y="84" width="128" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="234" y="100" text-anchor="middle" font-size="10.5" fill="#2b2a26">fs（cwd/root）</text>
<rect class="bx" x="170" y="112" width="128" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="234" y="128" text-anchor="middle" font-size="10.5" fill="#2b2a26">files（fd 表）</text>
<line class="fl" x1="130" y1="82" x2="166" y2="68" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="130" y1="88" x2="166" y2="96" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="130" y1="98" x2="166" y2="122" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<rect class="bx" x="30" y="196" width="100" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="80" y="216" text-anchor="middle" font-size="12" fill="#2b2a26">子任务</text>
<text class="ts" x="80" y="232" text-anchor="middle" font-size="10" fill="#6b675e">task_struct</text>
<rect class="bx" x="170" y="186" width="128" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="234" y="202" text-anchor="middle" font-size="10.5" fill="#2b2a26">mm（新的一份）</text>
<rect class="bx" x="170" y="214" width="128" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="234" y="230" text-anchor="middle" font-size="10.5" fill="#2b2a26">fs（新的一份）</text>
<rect class="bx" x="170" y="242" width="128" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="234" y="258" text-anchor="middle" font-size="10.5" fill="#2b2a26">files（新的一份）</text>
<line class="fl" x1="130" y1="212" x2="166" y2="198" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="130" y1="218" x2="166" y2="226" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="130" y1="228" x2="166" y2="252" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<text class="ts" x="30" y="300" font-size="11" fill="#6b675e">复制：页表逐页抄、fd 表逐格抄</text>
<text class="ts" x="30" y="318" font-size="11" fill="#6b675e">数据页不抄（COW），信号、命名空间同理</text>
<line class="axis" x1="335" y1="44" x2="335" y2="340" stroke="#a8a29a" stroke-width="1" stroke-dasharray="3 3"/>
<text class="t" x="365" y="52" font-size="12.5" fill="#2b2a26">pthread_create()：带 VM|FS|FILES</text>
<rect class="bx" x="365" y="66" width="100" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="415" y="86" text-anchor="middle" font-size="12" fill="#2b2a26">主线程</text>
<text class="ts" x="415" y="102" text-anchor="middle" font-size="10" fill="#6b675e">task_struct</text>
<rect class="bx" x="365" y="196" width="100" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="415" y="216" text-anchor="middle" font-size="12" fill="#2b2a26">子线程</text>
<text class="ts" x="415" y="232" text-anchor="middle" font-size="10" fill="#6b675e">task_struct</text>
<rect class="bx-q" x="510" y="116" width="128" height="24" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="574" y="132" text-anchor="middle" font-size="10.5" fill="#2b2a26">mm（同一份）</text>
<rect class="bx-q" x="510" y="148" width="128" height="24" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="574" y="164" text-anchor="middle" font-size="10.5" fill="#2b2a26">fs（同一份）</text>
<rect class="bx-q" x="510" y="180" width="128" height="24" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="574" y="196" text-anchor="middle" font-size="10.5" fill="#2b2a26">files（同一份）</text>
<line class="fl" x1="465" y1="88" x2="506" y2="126" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="465" y1="94" x2="506" y2="158" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="465" y1="100" x2="506" y2="190" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="465" y1="212" x2="506" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="465" y1="218" x2="506" y2="162" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<line class="fl" x1="465" y1="224" x2="506" y2="194" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernTBAs2)"/>
<text class="ts" x="365" y="300" font-size="11" fill="#6b675e">共享：三大件引用计数 +1</text>
<text class="ts" x="365" y="318" font-size="11" fill="#6b675e">新的只有 task_struct、内核栈、用户栈和 TLS</text>
<text class="ts" x="20" y="356" font-size="11" fill="#6b675e">「轻量级进程」轻在哪，这张图就是全部答案</text>
</svg>
</figure>

## 报关单的可感后果

「共享 files」四个字太抽象，量具把它变成两件能摸到的事（`identity.c` 后半段）：主线程打开 `/etc/hostname` 得到 fd 3，交给子线程 close；子线程再 `chdir("/tmp")`。对照组是 fork 出的子进程做同样的两件事。输出：

```
[主线程] 线程 join 后: fd 3 fcntl -> -1 (errno=Bad file descriptor)
[主线程] cwd: /home/kaiven/proc-lab -> /tmp
[主线程] 子进程退出后: cwd 仍是 /tmp（没被子进程的 chdir 带走）
```

悬案二结案：fd 3 是**进程**的家产，不是主线程的。CLONE_FILES 让线程组共用一张 fd 表，任何一个线程 close，全组的表里那格就没了；CLONE_FS 让全组共用一份 cwd，任何一个线程 chdir，全组跟着搬家。对照组里 fork 的子进程干同样的事，父进程毫发无伤——因为报关单上没有那两个 flag，fd 表和 fs_struct 都是新的。

这不是冷知识，是线上事故清单上的常客：多线程程序里一个线程擅自 close 了「自己的」fd，另一个线程的读写莫名其妙 EBADF；一个线程改了工作目录，全进程的相对路径集体漂移。规则只有一条：**线程之间没有「你的」「我的」，只有「组的」**。CLONE_VM 是同一逻辑的最大号——地址空间整个共享，线程写全局变量另一个线程立刻看见，这也正是锁存在的理由。

## 出生的价钱

报关单上少勾几个 flag，流水线就少跑几道工序。省下的时间量出来是多少？量具 `birthcost.c`：每个样本 = 创建 + 回收（fork 是 fork+_exit+waitpid，线程是 pthread_create+join，vfork 是 vfork+_exit），200 轮，三种方式轮次交错以抵消漂移，父进程保持轻量（fork 的页表复制成本随父进程体量涨，这里量的是底价口径）。

```
fork+exit    n=200  min=   121.8 us  median=   159.3 us  p90=   212.5 us
thread       n=200  min=    27.0 us  median=    34.5 us  p90=    48.1 us
vfork+exit   n=200  min=    23.5 us  median=    30.0 us  p90=    40.6 us
首个线程（冷，含 mmap 8MiB 栈）: 115.2 us
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="出生单价条形图：fork+exit 中位 159.3 微秒，首个冷线程 115.2 微秒，热线程 34.5 微秒，vfork+exit 30.0 微秒；200 轮交错，轻量父进程，含回收" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">出生单价（中位数，含回收；括号内为 min）</text>
<line class="grid" x1="180" y1="44" x2="180" y2="208" stroke="#a8a29a" stroke-width="1"/>
<line class="grid" x1="288" y1="44" x2="288" y2="208" stroke="#a8a29a" stroke-width="1"/>
<line class="grid" x1="396" y1="44" x2="396" y2="208" stroke="#a8a29a" stroke-width="1"/>
<line class="grid" x1="504" y1="44" x2="504" y2="208" stroke="#a8a29a" stroke-width="1"/>
<line class="grid" x1="612" y1="44" x2="612" y2="208" stroke="#a8a29a" stroke-width="1"/>
<text class="ts" x="180" y="226" text-anchor="middle" font-size="10.5" fill="#6b675e">0</text>
<text class="ts" x="288" y="226" text-anchor="middle" font-size="10.5" fill="#6b675e">40µs</text>
<text class="ts" x="396" y="226" text-anchor="middle" font-size="10.5" fill="#6b675e">80µs</text>
<text class="ts" x="504" y="226" text-anchor="middle" font-size="10.5" fill="#6b675e">120µs</text>
<text class="ts" x="612" y="226" text-anchor="middle" font-size="10.5" fill="#6b675e">160µs</text>
<text class="t" x="170" y="68" text-anchor="end" font-size="12" fill="#2b2a26">fork+exit</text>
<rect class="bx-sick" x="180" y="52" width="430" height="26" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="186" y="69" font-size="11" fill="#2b2a26">159.3 µs（min 121.8）——多付页表与四份复制</text>
<text class="t" x="170" y="106" text-anchor="end" font-size="12" fill="#2b2a26">首个线程（冷）</text>
<rect class="bx" x="180" y="90" width="311" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="186" y="107" font-size="11" fill="#2b2a26">115.2 µs——8MiB 栈 mmap 的开机账单</text>
<text class="t" x="170" y="144" text-anchor="end" font-size="12" fill="#2b2a26">线程（热）</text>
<rect class="bx" x="180" y="128" width="93" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="279" y="145" font-size="11" fill="#2b2a26">34.5 µs（min 27.0）——栈从 glibc 缓存借</text>
<text class="t" x="170" y="182" text-anchor="end" font-size="12" fill="#2b2a26">vfork+exit</text>
<rect class="bx-q" x="180" y="166" width="81" height="26" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="267" y="183" font-size="11" fill="#2b2a26">30.0 µs（min 23.5）——连栈都不给</text>
<text class="ts" x="180" y="252" font-size="11" fill="#6b675e">200 轮交错 · 轻量父进程 · Ryzen 5 5500U · 样本 = 创建 + 回收（wait/join）</text>
</svg>
</figure>

四个数，四句话。

fork 中位 159.3µs，是线程的 4.6 倍。多付的钱都在报关单的空白处：`dup_mm` 要把父进程的 VMA 清单走一遍、页表逐级抄一遍（数据页不抄，COW 记账为 0 成本，但页表本身是真金白银），files、fs、sighand、signal 四样各来一次「slab 取货 + 逐项拷贝」。轻量父进程尚且如此——父进程的地址空间越大、VMA 越多，fork 越贵，这就是大内存进程 fork 时那一顿的来源。

线程热路径 34.5µs。三大件全是引用计数 +1，新增的开销只有 task_struct、一条 16KB 内核栈和少量簿记。但**第一个线程要 115.2µs，几乎追平 fork**——贵的不是 clone，是那条 8MiB 用户栈的 mmap：VMA 登记、和邻居保持 guard gap、账户记账，[两种栈番外](/posts/kernel-two-stacks/)把这笔账拆到过 KB 级。从第二个线程起，栈从 glibc 那个 40MB 的缓存仓库里现借，价钱才掉回 34.5µs。冷热线程差 3.3 倍，比进程线程之差还陡——「线程比进程轻」这句话，得看你生的是第几个。

vfork 30.0µs，三种出生里的地板价。CLONE_VM 共享地址空间，且子进程直接用父进程的栈跑（连 8MiB 都不置办），父进程被 CLONE_VFORK 挂起原地等。便宜有便宜的代价：子进程踩的就是父进程的栈，所以规矩是只许 _exit 或 exec，多走一步都是事故。老式 shell 靠 vfork 省拷贝，这个最便宜的出生方式到今天还是最便宜。

## pid：号还是顺序发，账本换了

流水线倒数第二步 `alloc_pid` 领号。量具 `pidgrow.c` 连发 8 个子进程：

```
pid_max=4194304  ns_last_pid(启动时读数)=365922
bitmap 口径: 4194304 bit = 512 KiB（pid_max=65535 的时代只要 8 KiB）
连发 8 个子进程: 365923 365924 365925 365926 365927 365928 365929 365930
ns_last_pid(结束时读数)=365930
```

严格 +1，顺序发放。而且这 8 个号接在 365922 后面——此前 birthcost 刚烧掉六百多个号，游标接着上次的位置走，不回头捡刚释放的号。

这个「不回头」是有来历的。老内核（3.10 时代）用 bitmap 管号：每个 pid 一个 bit，65535 个号只要 8KB，省内存的极致；代价是分配要双层循环逐 bit 扫，进程越多扫得越久。按本机 pid_max=4194304 重算这笔账，bitmap 要 512KB——到了 2017 年，内存早不金贵，要省的反而是 CPU，内核把账本换成了 IDR 基数树：32 位的号按 6 bit 一段分层，树的深度固定，分配复杂度与在册进程数无关。v7.2 的实现更进一步，`kernel/pid.c:262` 用的是 `idr_alloc_cyclic`——旋转游标，发号从上次的位置继续，绕到 pid_max 才回卷到 RESERVED_PIDS（300）重新来。不回捡刚死的号，防的是 pid 复用攻击：恶意进程抢注刚释放的 pid，冒充死者收它的信号、接管它的 /proc 身份。长运行的机器上号会转圈，「这个 pid 还是不是原来那个进程」在生产上从来不是废话。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 270" role="img" aria-label="pid 账本换代：左侧 bitmap 每号一个 bit，65535 个号 8KB、本机 4194304 个号 512KB，找空位双层循环逐 bit 扫；右侧 IDR 基数树按 6bit 分段固定层数定位，v7.2 用 idr_alloc_cyclic 旋转游标防 pid 复用" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernTBAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="t" x="30" y="30" font-size="12.5" fill="#2b2a26">2017 年前：bitmap</text>
<g fill="#2b2a26">
<rect x="30" y="46" width="14" height="14"/><rect x="48" y="46" width="14" height="14"/><rect x="66" y="46" width="14" height="14"/><rect x="84" y="46" width="14" height="14"/><rect x="102" y="46" width="14" height="14"/><rect x="120" y="46" width="14" height="14"/><rect x="138" y="46" width="14" height="14"/><rect x="156" y="46" width="14" height="14"/><rect x="174" y="46" width="14" height="14"/><rect x="192" y="46" width="14" height="14"/><rect x="210" y="46" width="14" height="14"/>
</g>
<g fill="none" stroke="#6b675e" stroke-width="1">
<rect x="30" y="46" width="14" height="14"/><rect x="48" y="46" width="14" height="14"/><rect x="66" y="46" width="14" height="14"/><rect x="84" y="46" width="14" height="14"/><rect x="102" y="46" width="14" height="14"/><rect x="120" y="46" width="14" height="14"/><rect x="138" y="46" width="14" height="14"/><rect x="156" y="46" width="14" height="14"/><rect x="174" y="46" width="14" height="14"/><rect x="192" y="46" width="14" height="14"/><rect x="210" y="46" width="14" height="14"/><rect x="228" y="46" width="14" height="14"/><rect x="246" y="46" width="14" height="14"/><rect x="264" y="46" width="14" height="14"/>
<rect x="30" y="64" width="14" height="14"/><rect x="48" y="64" width="14" height="14"/><rect x="66" y="64" width="14" height="14"/><rect x="84" y="64" width="14" height="14"/><rect x="102" y="64" width="14" height="14"/><rect x="120" y="64" width="14" height="14"/>
</g>
<g fill="#2b2a26">
<rect x="138" y="64" width="14" height="14"/><rect x="156" y="64" width="14" height="14"/>
</g>
<g fill="none" stroke="#6b675e" stroke-width="1">
<rect x="138" y="64" width="14" height="14"/><rect x="156" y="64" width="14" height="14"/><rect x="174" y="64" width="14" height="14"/><rect x="192" y="64" width="14" height="14"/><rect x="210" y="64" width="14" height="14"/><rect x="228" y="64" width="14" height="14"/><rect x="246" y="64" width="14" height="14"/><rect x="264" y="64" width="14" height="14"/>
</g>
<text class="ts" x="30" y="104" font-size="11" fill="#6b675e">实心 = 已占用，1 bit 一个号</text>
<text class="ts" x="30" y="124" font-size="11" fill="#6b675e">65535 个号 → 8KB；4194304 个号 → 512KB</text>
<text class="ts" x="30" y="152" font-size="11" fill="#6b675e">找空位：双层循环逐 bit 扫</text>
<text class="ts" x="30" y="172" font-size="11" fill="#6b675e">在册进程越多，扫得越久</text>
<line class="fl" x1="300" y1="100" x2="366" y2="100" stroke="#6b675e" stroke-width="1.8" marker-end="url(#kernTBAs3)"/>
<text class="tc" x="333" y="88" text-anchor="middle" font-size="11.5" fill="#b03a2e">2017：省内存 → 省 CPU</text>
<text class="t" x="396" y="30" font-size="12.5" fill="#2b2a26">v7.2：IDR 基数树 + 旋转游标</text>
<rect class="bx-q" x="480" y="44" width="84" height="24" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="522" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">bit 31..24</text>
<rect class="bx" x="420" y="88" width="76" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="458" y="104" text-anchor="middle" font-size="10.5" fill="#2b2a26">bit 23..18</text>
<rect class="bx" x="548" y="88" width="76" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="586" y="104" text-anchor="middle" font-size="10.5" fill="#2b2a26">bit 23..18</text>
<rect class="bx" x="396" y="132" width="66" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="429" y="148" text-anchor="middle" font-size="10.5" fill="#2b2a26">bit 17..12</text>
<rect class="bx" x="478" y="132" width="66" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="511" y="148" text-anchor="middle" font-size="10.5" fill="#2b2a26">bit 17..12</text>
<line class="fl" x1="500" y1="68" x2="462" y2="86" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="545" y1="68" x2="582" y2="86" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="440" y1="112" x2="429" y2="130" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="476" y1="112" x2="505" y2="130" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="396" y="184" font-size="11" fill="#6b675e">每层管 6 bit，32 位的号固定几层走到头</text>
<text class="ts" x="396" y="204" font-size="11" fill="#6b675e">分配快慢与在册进程数无关</text>
<text class="ts" x="396" y="232" font-size="11" fill="#6b675e">idr_alloc_cyclic：游标只进不退（到顶回卷 300）</text>
<text class="ts" x="30" y="256" font-size="11" fill="#6b675e">实测：连发 8 个子进程，号严格 +1；birthcost 烧掉 600 个号后，游标从 365922 接着走</text>
</svg>
</figure>

还有一件事在这里合拢：identity 实验里子线程的 tid 是 372271，正是主线程 372270 的下一个号。线程的 tid 和进程的 pid 从**同一个 idr、同一个号段**发放——在内核的账本上它们本来就是同一种号，只是用户态把组长的号叫 PID、组员的号叫 TID。番外里一千个线程的实验，顺手就吃掉了一千个 pid；号段转圈的速度，多线程程序比多进程程序快得多。

## 我踩的坑

**system() 里的 /proc/self 不是我的。** 第一版 identity 用 `system("ls /proc/self/task/")` 列线程目录，输出里孤零零一个陌生号码——那是 system  fork 出的 shell 自己的 pid：/proc/self 跟着调用进程走，shell 看到的是它自己。改 opendir/readdir 才算数。用 /proc/self 的实验，中间隔了一层进程就全错。

**量具的解码表也会漏。** clonetrace 第一版把 0x1200011 解出 CLONE_CHILD_CLEARTID + SIGCHLD，还剩个 bit24 没着落。对 glibc 的 arch-fork.h 才发现是 CLONE_CHILD_SETTID（0x01000000），我的 flag 表漏了它。原始读数（hex）是硬的，解码表是人抄的——读数与源码对不上时，先怀疑自己的表。

**ptrace 量具不能拿来计时。** 抓取量具每步系统调用都要停两次（进入/退出），birthcost 若在它眼皮下跑，读数会虚高一个量级。看 flags 用带 ptrace 的量具，量价钱用干净的进程——一件量具只干一件事。

**第一个线程的样本要单记。** glibc 的栈缓存让冷、热线程差 3.3 倍（115.2 vs 34.5µs）。若不把首个样本拎出来，混进 200 轮取中位，mmap 那张账单就被平均没了，你只会得到一个「线程很便宜」的糊涂结论。

**vfork 的子进程要守规矩。** 它跑在父进程的栈上，我克制住了在子进程里 printf 一句的好奇心——那不是调试输出，是往父进程的栈上写字。量具里它只干一件事：_exit(0)。

**内核线程的数目是活的。** 两遍数出 466 和 455，kworker 随负载来了又走。文中只能写「四百五十多个」，写死一个数才是错的。

## 一扇门

两个悬案结案。fork 系统调用在 v7.2 里仍然注册着（fork.c:2828），但 glibc 不用它——CHILD_SETTID 那一步要把真实 tid 写进子进程的 pthread 描述符，CLEARTID 那一步给退出留一个 futex 位点，内核的 fork 入口给不了这两样，所以绕道 clone。pthread_create 走 clone3，九个 flag 里 VM/FS/FILES 三个决定了「轻量级进程」轻在哪：地址空间、目录、fd 表全部共享，线程私有的只有 task_struct、一条内核栈、一条用户栈，外加 TLS 和信号掩码几样小件。fd 3 是进程的家产，从来不是哪个线程的。

价钱也量清了：fork 中位 159.3µs，线程 34.5µs，vfork 30.0µs，冷线程 115.2µs。差价没有玄学，就是「复制」与「引用计数 +1」的工序差，逐项都写在报关单上。

出生的最后一站是 `wake_up_new_task`：新任务被挂上某个 CPU 的运行队列。挂哪个队列、什么时候轮到它、能跑多久，是调度器的事，后面再讲。眼下还有一件更急的：fork 出的子进程，代码和数据还是父进程的复制品，shell 的子进程注定要变成 ls 或者 vim。下一篇讲换装——execve 不换任务，pid 原地不动，整个地址空间推倒重建，从 ELF 文件到 `_start` 再到 main 的整条路；换装时栈的第一页怎么出生，番外已经讲过，正好接上。
