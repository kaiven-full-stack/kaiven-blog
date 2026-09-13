---
title: 删除只要一瞬，还房才是苦差：Redis 的 lazyfree 与 UNLINK
description: DEL 一个百万成员的 zset，主线程停了 108 毫秒；UNLINK 同样的键，回复即刻返回，析构在后台线程慢慢做。本文拆开释放为什么比写入更危险：析构不能摊、不能停、只能搬走；free effort 的估算逻辑、64 的阈值、以及为什么多数键根本轮不到异步。实测环境为官方 Redis 7.4.11 隔离容器。
pubDate: 2026-09-10
category: redis
tags: [Redis, 数据库]
---

`DEL` 一个百万成员的 zset，返回 1，慢日志记下 108 毫秒；`UNLINK` 一个同规格的键，也返回 1，回复即刻到达，析构由后台线程慢慢做。同一个 90MB、百万成员的 zset，两次删除，键都在一瞬之间从键空间消失，区别在后面那 108 毫秒里主线程在干什么。

删除一个键，从客户端看是一瞬：命令返回，`EXISTS` 变 0。但「键不可见」和「内存归还」是两件事。过期篇讲过这道缝，这一篇把缝里最宽的一段拆开：**释放一个巨大对象本身，可以比大多数命令慢两个数量级。**

这两组数字来自隔离容器：百万成员的 skiplist zset（约 90MB、含 dict 与跳表两套索引），`DEL` 的执行在慢日志里留下 108 毫秒的记录。事件循环篇的读者立刻知道这意味着什么：主线程 108 毫秒不响应，所有连接的 P99 一起抬升。而 `UNLINK` 做的是同一件事，回复却在毫秒内到达，因为释放工作被挪去了后台线程。这就是 lazyfree。

实验在官方 Redis 7.4.11 容器中完成，源码名称以该版本为准。

## 释放为什么是危险动作

写入一个大集合可以摊：灌一百万个键只要一秒多，摊成几十万次微秒级命令；渐进式 rehash 篇见过更极致的摊法，搬家一桶一桶地挪。**析构没有这些手段**：一个键一旦从键空间摘下，它的全部家当就得一口气清完，dict 逐条目释放、跳表逐节点拆链、每个 sds 一次 free。百万成员就是百万次分配器调用，天然不可分。

于是释放大对象成了长命令的一种，而且是最隐蔽的一种：它不出现在业务代码里，只在删除时冷不丁咬一口。过期删除、内存淘汰、`DEL`、`FLUSHALL`，个个都可能触发。lazyfree 的思路因此非常直接：**既然析构不可分，就把它整体搬出主线程**。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 232" role="img" aria-label="DEL 与 UNLINK 删同一个 90MB 大 zset 的泳道对照：DEL 主线程摘键后紧接着同步析构 108 毫秒，全程占用；UNLINK 主线程只做微秒级摘键立刻回复，析构作为一单任务交给 bio 后台线程慢慢做" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一个百万成员 zset（90MB），两种删法的泳道</text>
<text class="t" x="20" y="66" font-size="13" fill="#2b2a26">DEL</text>
<rect class="bar" x="110" y="50" width="6" height="20" fill="#2b2a26"/>
<rect class="bx-sick" x="116" y="50" width="216" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="342" y="64" font-size="11" fill="#b03a2e">主线程：摘键 + 析构 90MB，108ms 全程占用</text>
<text class="t" x="20" y="128" font-size="13" fill="#2b2a26">UNLINK</text>
<rect class="bar" x="110" y="112" width="4" height="20" fill="#2b2a26"/>
<text class="ts" x="122" y="126" font-size="11" fill="#6b675e">主线程：只摘键，微秒级返回，继续接单</text>
<rect class="bx" x="114" y="140" width="216" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="122" y="154" font-size="11" fill="#6b675e">bio 工人：同一份析构，慢慢做</text>
<line class="axis" x1="110" y1="182" x2="400" y2="182" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="110" y="198" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="218" y="198" text-anchor="middle" font-size="10" fill="#6b675e">54ms</text>
<text class="ts" x="332" y="198" text-anchor="middle" font-size="10" fill="#6b675e">108ms</text>
<text class="ts" x="20" y="224" font-size="12" fill="#6b675e">键都是一瞬消失的：区别在其后 108 毫秒由谁来花</text>
</svg>
</figure>

「摘键」是主线程必须自己做的一步：把 dict 里的条目删掉，键从此不可见。这一步便宜；贵的析构部分则连同对象指针一起装进任务，递给 bio 后台线程。主线程花掉的时间从 108ms 变成微秒级。

## 一个工人，一张任务单

收活的线程在事件循环篇见过：bio 后台 I/O 线程组，固定三个工人，各管一摊，关文件、AOF fsync、lazyfree。lazyfree 工人是独占的，任务队列由互斥锁保护；主线程投递任务时自增 `lazyfree_objects` 计数，工人每清完一单就递减、同时累加 `lazyfreed_objects`。

这里没有复杂的调度：一个工人、FIFO 队列、按单消费。百万成员的 zset 是**一单**（对象指针一个），清这一单要多久，队列里排在后面的任务就等多久。实测三百万成员的 zset（约 270MB）UNLINK 后，连续四十次采样 `lazyfree_pending_objects` 都保持 1：这一单占着工人很久，但主线程和客户端对此毫无知觉，键早已消失，新键的写入不受任何影响。

一个工人和它的任务单：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="lazyfree 的任务模型：主线程把对象指针装进任务单投递到互斥锁保护的 FIFO 队列，lazyfree_objects 计数加一；队列那头只有一个 bio 工人按单消费，三百万成员的大 zset 是一单，清完它后面的任务才能动" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red6As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">没有调度：FIFO 队列、一个工人、按单消费</text>
<rect class="bx-q" x="30" y="56" width="150" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="105" y="80" text-anchor="middle" font-size="12" fill="#2b2a26">主线程</text>
<text class="ts" x="105" y="100" text-anchor="middle" font-size="10" fill="#6b675e">投递任务单，计数 +1</text>
<line class="fl" x1="180" y1="86" x2="226" y2="86" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As2)"/>
<rect class="bx-sick" x="230" y="56" width="64" height="60" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="262" y="80" text-anchor="middle" font-size="10" fill="#6b675e">大 zset</text>
<text class="ts" x="262" y="96" text-anchor="middle" font-size="10" fill="#6b675e">一单</text>
<rect class="bx" x="302" y="56" width="44" height="60" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="324" y="90" text-anchor="middle" font-size="10" fill="#6b675e">单</text>
<rect class="bx" x="354" y="56" width="44" height="60" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="376" y="90" text-anchor="middle" font-size="10" fill="#6b675e">单</text>
<text class="ts" x="230" y="136" font-size="10" fill="#6b675e">互斥锁保护的 FIFO 队列</text>
<line class="fl" x1="398" y1="86" x2="444" y2="86" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As2)"/>
<rect class="bx" x="448" y="56" width="180" height="60" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="538" y="80" text-anchor="middle" font-size="12" fill="#2b2a26">bio lazyfree 工人</text>
<text class="ts" x="538" y="100" text-anchor="middle" font-size="10" fill="#6b675e">只有一个，清完一单计数 −1</text>
<text class="ts" x="20" y="168" font-size="12" fill="#6b675e">270MB 的 zset 清完前，pending_objects 一直是 1：排队时长 = 前一单的清理时长</text>
<text class="ts" x="20" y="190" font-size="12" fill="#6b675e">它是串行清单，不是并发清理池</text>
</svg>
</figure>

一个值得先记住的推论：**lazyfree 治的是主线程的停顿，不是内存的延迟回收**。对象在后台队列里排队、清到一半时，那部分内存仍然被占用。监控内存曲线时，「DEL 后 RSS 没降」又多了一种可能的解释：上一批释放还在后台没做完。

## free effort：值不值得搬去后台的估算

不可能所有删除都走后台。一个短字符串的析构就是一次 free，为它投递任务、加锁、唤醒线程，比直接释放还贵。所以主线程摘键前先估算「释放工作量」（`lazyfreeGetFreeEffort`），超过阈值才转后台：

```text
quicklist       → 节点数
hashtable 的 set/hash → 条目数
skiplist 的 zset → 跳表长度
stream          → 宏节点 + 消费组估计
其余（string、小结构）→ 1
```

阈值是 64（`LAZYFREE_THRESHOLD`），严格大于才异步。同时还有一道引用检查：对象被共享时（引用计数 > 1）不能异步，因为还有别人指着它，后台线程不能贸然释放。

这道判断的完整形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="free effort 判断流程：删除请求先估算释放工作量，quicklist 按节点数、hashtable 按条目数、skiplist 按跳表长度、stream 按宏节点加消费组、其余按 1 计；工作量严格大于 64 且引用计数为 1 才转 bio 异步，否则主线程同步析构" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red6As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">先估工作量，再决定在哪干</text>
<rect class="bx-q" x="20" y="52" width="120" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="80" y="78" text-anchor="middle" font-size="12" fill="#6b675e">删除请求</text>
<line class="fl" x1="140" y1="74" x2="176" y2="74" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As3)"/>
<rect class="bx" x="180" y="44" width="220" height="60" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="290" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">估算 free effort</text>
<text class="ts" x="290" y="82" text-anchor="middle" font-size="10" fill="#6b675e">quicklist 节点数 · hashtable 条目数 · 跳表长度</text>
<text class="ts" x="290" y="96" text-anchor="middle" font-size="10" fill="#6b675e">stream 宏节点+消费组 · string 等一律按 1</text>
<line class="fl" x1="400" y1="74" x2="416" y2="74" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As3)"/>
<rect class="bx" x="420" y="52" width="110" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="475" y="78" text-anchor="middle" font-size="12" fill="#6b675e">effort &gt; 64？</text>
<line class="fl" x1="530" y1="62" x2="554" y2="62" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As3)"/>
<text class="ts" x="542" y="50" text-anchor="middle" font-size="10" fill="#6b675e">否</text>
<rect class="bx" x="558" y="40" width="94" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="605" y="58" text-anchor="middle" font-size="10" fill="#6b675e">主线程</text>
<text class="ts" x="605" y="74" text-anchor="middle" font-size="10" fill="#6b675e">同步析构</text>
<line class="fl" x1="475" y1="96" x2="475" y2="132" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As3)"/>
<text class="ts" x="483" y="118" font-size="10" fill="#6b675e">是</text>
<rect class="bx" x="430" y="136" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="495" y="162" text-anchor="middle" font-size="12" fill="#6b675e">引用计数 &gt; 1？</text>
<line class="fl" x1="560" y1="146" x2="601" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As3)"/>
<text class="ts" x="560" y="128" font-size="10" fill="#6b675e">是：共享中，也同步</text>
<line class="fl" x1="430" y1="158" x2="356" y2="158" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As3)"/>
<text class="ts" x="392" y="148" text-anchor="middle" font-size="10" fill="#6b675e">否</text>
<rect class="bx-sick" x="180" y="136" width="172" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="266" y="154" text-anchor="middle" font-size="11" fill="#b03a2e">装进任务单，交给 bio</text>
<text class="ts" x="266" y="170" text-anchor="middle" font-size="10" fill="#6b675e">异步析构，主线程即刻返回</text>
<text class="ts" x="20" y="216" font-size="12" fill="#6b675e">UNLINK 强制走这套判断；DEL 默认跳过它直接同步，除非对应 lazy 开关打开</text>
<text class="ts" x="20" y="238" font-size="12" fill="#6b675e">string 的 effort 恒为 1：不管多长都走左边那条同步路</text>
</svg>
</figure>

这套「先估工作量再决定在哪干」的思路,和 `DEL`/`UNLINK` 的关系是：`UNLINK` 强制走这条判断路径；`DEL` 默认直接同步析构。两者由 `delGenericCommand` 的一个参数分流，参数值由四个配置开关决定：

```text
lazyfree-lazy-user-del      DEL 命令本身是否默认异步     （默认 no）
lazyfree-lazy-expire        过期删除是否异步           （默认 no）
lazyfree-lazy-eviction      内存淘汰是否异步           （默认 no）
lazyfree-lazy-server-del    服务端内部隐式删除是否异步   （默认 no）
```

四个开关全默认关闭，**异步释放默认只在 UNLINK 和 FLUSHALL ASYNC 显式要求时发生**。这是刻意的保守：后台释放让「键没了但内存还占着」的窗口变长，内存紧张时反而可能加剧淘汰压力。官方文档也提醒，开启 `lazyfree-lazy-eviction` 这类开关等于用内存峰值换主线程平滑，要按容量预算来定。

## 被编码阈值遮蔽的 64：多数键轮不到异步

阈值 64 的字面意思容易读错。它不是「64 个成员以上的键删除都走异步」：估算函数只对**已经是大结构**的对象数成员数，而紧凑结构一律按 1 计。实测里这个边角露了出来：

```text
128 成员 zset（listpack 编码）UNLINK → lazyfreed 计数不动 → 同步释放
129 成员 zset（skiplist 编码）UNLINK → lazyfreed +1     → 异步释放
```

128 个成员的 zset 还住在 listpack 里（对象编码篇的阈值），它是一次分配的连续内存，析构就是一次 free，工作量按 1 计，同步删。第 129 个成员让它换成 skiplist + dict 双索引（跳表篇的结构）后，释放才变成真正的「逐节点拆迁」，工作量按跳表长度计，129 > 64，转后台。

所以两条阈值是接力关系：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="两条阈值的接力：编码阈值 128 或 512 决定结构里有没有大量独立分配，128 成员的 listpack zset 是一次分配 effort 按 1 计；lazyfree 阈值 64 决定这些分配值不值得搬去后台，129 成员的 skiplist zset effort 为 129 大于 64 转异步" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red6As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">两道闸是接力：先问结构，再问工作量</text>
<rect class="bx" x="30" y="44" width="270" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="165" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">闸一 · 编码阈值 128 / 512</text>
<text class="ts" x="165" y="86" text-anchor="middle" font-size="11" fill="#6b675e">结构里有没有大量独立分配？</text>
<text class="ts" x="165" y="106" text-anchor="middle" font-size="11" fill="#6b675e">128 成员 zset 还在 listpack：一次分配</text>
<line class="fl" x1="300" y1="82" x2="356" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As4)"/>
<rect class="bx" x="360" y="44" width="270" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="495" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">闸二 · lazyfree 阈值 64</text>
<text class="ts" x="495" y="86" text-anchor="middle" font-size="11" fill="#6b675e">这些分配多到值得搬去后台？</text>
<text class="ts" x="495" y="106" text-anchor="middle" font-size="11" fill="#6b675e">129 成员换了 skiplist：effort=129</text>
<rect class="bx-q" x="30" y="136" width="270" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="165" y="157" text-anchor="middle" font-size="11" fill="#6b675e">闸一拦下：effort=1，同步释放就是一次 free</text>
<rect class="bx-sick" x="360" y="136" width="270" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="495" y="157" text-anchor="middle" font-size="11" fill="#b03a2e">两闸都过：129 &gt; 64，装单转 bio</text>
<text class="ts" x="20" y="194" font-size="12" fill="#6b675e">想知道某个键走哪条路：OBJECT ENCODING 比数成员数更接近真相</text>
</svg>
</figure>

推论一：**string 永远不会异步释放**，不管多长，它都是一次分配。推论二：百万成员的大键一定异步（远超两道阈值）。中间地带的键（130–500 成员的 hash 等）可能两种都遇得上。想确切知道一个键的释放会走哪条路，`OBJECT ENCODING` 看它现在住的是什么结构，比数成员数更接近真相。

## DEL 还是 UNLINK：三组实测对照

把三组对照并排放好（隔离容器，慢日志与服务端计数为证）：

```text
百万成员 zset（90MB）
  DEL       慢日志记录 108ms，主线程全程占用
  UNLINK    未入慢日志，pending 计数随后台完成归零

65 成员 zset（listpack）
  UNLINK    同步释放——小于编码阈值，谈不上工作量

FLUSHALL（十万键）
  FLUSHALL ASYNC   43ms 返回，DBSIZE 即刻为 0
```

第三行值得展开。`FLUSHALL ASYNC` 不是把十万键逐个丢进 lazyfree 队列（十万张任务单会把工人压垮），而是走 `emptyDbAsync` 的**整库换新**：主线程把旧键空间整套摘下、给数据库换上全新的空哈希表，旧的那套作为**一张**任务单交给后台。十万键的删除在主线程侧变成「换一个指针」，这是 lazyfree 里最划算的一笔，代价同样是整库内存在后台慢慢归还。

整库换新的现场：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="FLUSHALL ASYNC 的整库换新：主线程把装着十万键的旧键空间整套摘下，给数据库换上一张全新的空哈希表，DBSIZE 立刻归零、43 毫秒返回；旧键空间作为一张任务单交给 bio 后台慢慢清空" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red6As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">FLUSHALL ASYNC：换一个指针，不是排十万张单</text>
<rect class="bx" x="30" y="50" width="200" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="130" y="72" text-anchor="middle" font-size="12" fill="#2b2a26">旧键空间</text>
<rect class="msg" x="48" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="66" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="84" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="102" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="120" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="138" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="156" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="174" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="192" y="84" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="130" y="116" text-anchor="middle" font-size="10" fill="#6b675e">十万键 · 整套摘下</text>
<line class="fl" x1="230" y1="70" x2="356" y2="58" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red6As5)"/>
<text class="tc" x="290" y="48" text-anchor="middle" font-size="11" fill="#b03a2e">主线程：换上新的空表</text>
<rect class="bx-q" x="360" y="40" width="260" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="490" y="64" text-anchor="middle" font-size="11" fill="#6b675e">全新空哈希表：DBSIZE 即刻 0，43ms 返回</text>
<line class="fl" x1="230" y1="106" x2="356" y2="126" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#red6As5)"/>
<text class="ts" x="290" y="136" text-anchor="middle" font-size="11" fill="#6b675e">一张任务单</text>
<rect class="bx-sick" x="360" y="106" width="260" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="490" y="130" text-anchor="middle" font-size="11" fill="#b03a2e">bio 后台：慢慢清空整库</text>
<text class="ts" x="20" y="182" font-size="12" fill="#6b675e">任务单数量：1，不是 100,000</text>
</svg>
</figure>

选型建议由此清晰：**确定是大键的删除，用 UNLINK**（或开启对应开关）；小键和中等键用 DEL 即可，同步释放一次的成本比投递任务的成本低。批量清理用 FLUSHALL ASYNC / FLUSHDB ASYNC。而「DEL 大键导致卡顿」的事故，通常的根源是键在业务演进中悄悄长大了，对象编码篇的 `MEMORY USAGE` 巡检正是提前发现它的手段。

## 后台的边界：lazyfree 不是万灵药

把析构搬去后台，等于把一份工作从「贵且阻塞」改成「便宜但延后」。这笔交换的边界要看清：

**内存回收延迟换主线程平滑。** 释放未完成前内存仍被占用。内存吃紧的实例上，大键的异步释放可能让淘汰循环更早触发；淘汰本身若再异步（`lazyfree-lazy-eviction`），就是用内存峰值连换两层平滑。容量规划时，「删除后的内存曲线」要把后台清理的尾巴画进去。

**一个工人，串行清单。** bio 的 lazyfree 只有一个工人。连续 UNLINK 十个百万成员大键，主线程十次都即刻返回，但后台要串行清完十单，`lazyfree_pending_objects` 会一路上涨再缓慢回落。它不是并发清理池，同一时刻只有一单在处理。

**插入期间的并发安全靠「先摘后交」。** 任务递交时对象已从键空间脱离，主线程不再会碰它；引用计数检查兜住共享对象。但「键不可见」和「内存归零」之间的窗口内，`INFO memory` 读到的是尚未释放的数字，监控按内存曲线报警的系统需要认识这个形状。

## 排查删除卡顿的两个数字

```text
INFO（Persistence 之外的段）
  lazyfree_pending_objects    后台还没清完的对象数
  lazyfreed_objects           历史累计异步释放的对象数

SLOWLOG GET                  抓现行：DEL 大键的停顿就在这里
LATENCY HISTORY del-command  DEL 的延迟事件历史
CLIENT LIST 的 multi-mem     （顺带：事务队列内存，上一篇提过）
```

排查「删除大键后实例卡了一下」，先查慢日志里 DEL 的耗时，那是同步析构的现行；再看 `lazyfree_pending_objects` 是否在删除后短暂为 1 并回落，那是异步路径正常工作的样子。两个数字都干净而卡顿仍在，问题多半在别处（比如 COW，见 fork 篇）。

## 释放的经验法则

释放大对象是最隐蔽的长命令：百万成员 zset 的 DEL 实测 108 毫秒，全程占住主线程；写入可以摊、迁移可以摊，析构天然不可摊，只能整单搬走。UNLINK 与 DEL 的区别只在一道估算：工作量（free effort）按结构内分配数计，严格大于 64 且未被共享才转后台 bio 线程，否则 UNLINK 也同步删；string 永远同步，一次分配谈不上工作量。两条阈值接力决定路径：编码阈值（128/512）决定对象是不是「大量独立分配」的结构，lazyfree 阈值（64）决定这些分配值不值得搬；中间地带的键，`OBJECT ENCODING` 比成员数更能预测它的释放路径。四个 lazy 开关默认全关：异步释放用内存回收的延迟换主线程平滑，默认只留给显式的 UNLINK 和 FLUSHALL ASYNC，开启前先想清楚容量预算，特别是 `lazyfree-lazy-eviction`。FLUSHALL ASYNC 是整库换新，不是逐键排队：主线程只做一次指针级切换，旧键空间作为单张任务单交给后台，十万键的清库对主线程只是一次挥手。

写入的成本可以摊薄，告别的成本只能转交。lazyfree 承认了析构是一件无法渐进的苦差，于是给它派了一个专门的工人，让主线程的日程表上只留下「摘键」这一笔。

Redis 系列到这里收官。从线程模型、事件循环，到数据结构的每一层，再到持久化与事务的边界，十三篇走下来反复出现的是同一个母题：**单线程的柜台必须永远流畅，凡是大宗的工作，要么摊成碎片，要么搬去后台。** lazyfree 是这个母题的最后一环。

---

第十三轮，系列到此完结。bio 后台线程的分工见《一个命令没走完，所有人都在门外》；「键不可见 ≠ 内存归还」的第一道缝见《过期的键，不会准时消失》的 T1–T4；释放工作量的估算依赖对象编码与转换阈值，见《第 513 个字段，房租涨了五倍》；百万成员 zset 的双索引结构见《一套查得快，一套排得顺》。
