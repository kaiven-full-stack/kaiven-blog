---
title: 内存满了，先忘掉谁：Redis 的淘汰策略与近似 LRU/LFU
description: 同一批键，LRU 更在意谁最近沉默，LFU 更在意谁曾频繁出现。本文从 maxmemory 水位线出发，拆开候选集合、随机采样、候选池、24 位时钟和淘汰后的删除路径，并用 samples 从 1 到 25 的对照实验量出「近似」到底近似到什么程度。所有比例与时长只描述本次 7.4.11 容器实验。
pubDate: 2026-09-05
category: redis
tags: [Redis, 数据库]
---

先看一组对照实验的结果。写入 350 只 hot 键、350 只 cold 键，hot 每只再访问 60 次，cold 一次不碰，然后继续写入，直到内存水位触发淘汰。`allkeys-lfu` 连续三轮，hot 全部存活（350/350/350）；换 `allkeys-lru` 且 `samples=1`，连刚刚写入的新键也有约 85 只被淘汰。

两组结果都真实，也都不是保证。LFU 看到 hot 的访问印象明显高于新键，于是本次三轮里完整保住了它们；LRU 在样本数只有 1 时几乎退化成随机选择。换一组随机数、键数量或内存压力，具体名单会变化。本文要回答的是另一个问题：Redis 怎样在有限预算里拼出一份够用的候选名单。

实验使用官方 Redis 7.4.11 镜像，运行在无外网、无端口映射的受限容器中；关闭 RDB 与 AOF，键值以 8KB 为主，所有容器和网络都已删除。所有比例与时长只描述本次实验。

本篇回到单节点：当 `maxmemory` 水位被越过，Redis 不能无限扫描所有键，也不愿在每次访问时维护一条精确全局链表。它先确定谁有资格成为候选，再抽样、排序、删除，直到重新回到水位以下。

## 水位线看的是哪一种内存

`maxmemory` 默认是 0，在 64 位系统上表示不设置 Redis 自身内存上限；默认策略是 `noeviction`，也就是超限时拒绝部分写命令，而不是自动删除旧键。

更容易被误解的是“内存”二字。Redis 淘汰判断的基础是 `zmalloc_used_memory()` 记录的分配器已分配字节，不是进程 RSS，也不是容器看到的全部物理占用。

比较前还会扣除 `mem_not_counted_for_evict`：

- AOF 缓冲；
- Redis 7 全局复制缓冲中超过 backlog 目标容量的部分。

原因是一条反馈回路。淘汰键需要向 AOF 和副本传播删除，传播又会让这些缓冲变大；若把增长全部算进水位，Redis 可能出现“越淘汰，越超限，继续淘汰”的循环。backlog 自身仍计入，只扣除特定不可用淘汰解决的缓冲部分。

实验关闭 AOF 且没有副本，所以：

```text
mem_not_counted_for_evict:0
```

淘汰稳态中，`used_memory` 约 16.76MB，RSS 约 24.5MB，`mem_fragmentation_ratio` 约 1.46。RSS 更高并不表示 maxmemory 失效，它包含分配器保留页、碎片、线程栈和其他进程级开销。

**maxmemory 管的是 Redis 分配器已分配字节的水位，与操作系统内存表上的最后一行不是同一个数。**

同一个实例的两把尺子：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="淘汰水位与进程内存的两把尺子：used_memory 约 16.76MB 是分配器已分配字节，水位比较用它；进程 RSS 约 24.5MB 还包含分配器保留页、碎片与线程栈，两者的比值就是碎片率 1.46" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">水位看哪条线：实验稳态的两把尺子</text>
<text class="ts" x="20" y="66" font-size="12" fill="#6b675e">used_memory</text>
<rect class="bar" x="140" y="52" width="335" height="20" fill="#2b2a26"/>
<text class="onbar" x="150" y="67" font-size="11" fill="#f6f3ec">16.76MB · 分配器已分配字节</text>
<text class="ts" x="20" y="110" font-size="12" fill="#6b675e">进程 RSS</text>
<rect class="bar" x="140" y="96" width="490" height="20" fill="#6b675e"/>
<text class="onbar" x="150" y="111" font-size="11" fill="#f6f3ec">24.5MB · 再加保留页、碎片、线程栈</text>
<line class="flc" x1="475" y1="44" x2="475" y2="124" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3"/>
<text class="tc" x="481" y="140" font-size="11" fill="#b03a2e">maxmemory 只与上面那条比</text>
<text class="ts" x="20" y="166" font-size="12" fill="#6b675e">两条的比值 24.5 ÷ 16.76 ≈ 1.46，正是 mem_fragmentation_ratio</text>
<text class="ts" x="20" y="186" font-size="12" fill="#6b675e">比较前还扣掉 AOF 缓冲等不计入项，防「越淘汰越超限」的反馈回路</text>
</svg>
</figure>

## 每条命令前，重新回答一次“要不要腾空间”

Redis 7.4.11 在 `processCommand()` 的执行前检查阶段调用 `performEvictions()`：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="performEvictions 的检查流程：客户端命令到达，先过解析认证 ACL 路由检查，再进 performEvictions；四个出口分别是水位正常继续、成功腾出空间继续、预算用完安排下一批、无候选或 noeviction 记 OOM；OOM 状态下 denyoom 写命令被拒，GET DEL EXPIRE 照常" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red9As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">「内存满了」没有后台哨兵：每条命令执行前重新问一遍</text>
<rect class="bx-q" x="230" y="36" width="200" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="330" y="56" text-anchor="middle" font-size="12" fill="#6b675e">客户端命令到达</text>
<line class="fl" x1="330" y1="68" x2="330" y2="84" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red9As2)"/>
<rect class="bx" x="200" y="88" width="260" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="108" text-anchor="middle" font-size="11" fill="#6b675e">解析、认证、ACL、Cluster 路由检查</text>
<line class="fl" x1="330" y1="120" x2="330" y2="136" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red9As2)"/>
<rect class="bx-sick" x="230" y="140" width="200" height="32" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="330" y="160" text-anchor="middle" font-size="12" fill="#b03a2e">performEvictions()</text>
<line class="fl" x1="270" y1="172" x2="95" y2="190" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red9As2)"/>
<line class="fl" x1="310" y1="172" x2="250" y2="190" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red9As2)"/>
<line class="fl" x1="360" y1="172" x2="410" y2="190" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red9As2)"/>
<line class="fl" x1="400" y1="172" x2="570" y2="190" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red9As2)"/>
<rect class="bx" x="20" y="194" width="145" height="46" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="92" y="212" text-anchor="middle" font-size="10" fill="#6b675e">水位正常</text>
<text class="ts" x="92" y="230" text-anchor="middle" font-size="10" fill="#6b675e">继续执行</text>
<rect class="bx" x="175" y="194" width="145" height="46" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="247" y="212" text-anchor="middle" font-size="10" fill="#6b675e">成功腾出空间</text>
<text class="ts" x="247" y="230" text-anchor="middle" font-size="10" fill="#6b675e">继续执行</text>
<rect class="bx" x="330" y="194" width="155" height="46" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="407" y="212" text-anchor="middle" font-size="10" fill="#6b675e">单轮预算用完还差</text>
<text class="ts" x="407" y="230" text-anchor="middle" font-size="10" fill="#6b675e">安排时间事件分批续做</text>
<rect class="bx-sick" x="495" y="194" width="150" height="46" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="570" y="212" text-anchor="middle" font-size="10" fill="#b03a2e">无候选 / noeviction</text>
<text class="ts" x="570" y="230" text-anchor="middle" font-size="10" fill="#6b675e">记 OOM 状态</text>
<text class="ts" x="20" y="260" font-size="12" fill="#6b675e">OOM 状态下：denyoom 的写命令被拒，GET / DEL / EXPIRE 这些不涨内存或能缩水的照常</text>
</svg>
</figure>

所以“内存满了”这件事没有独立的后台告警，它由后续命令不断重新触发判断。默认 `maxmemory-eviction-tenacity=10` 对应约 500 微秒的单轮预算；预算用完但仍需淘汰时，Redis 会安排时间事件继续小批处理，而不是让一次水位检查无限占住主线程。把 tenacity 调到 100 则表示不限制这一轮时间，尾延迟风险也随之上升。

只有带 `denyoom` 标记的命令才会因无法腾出空间被拒绝。实验中 `SET`、`INCR`、`LPUSH`、`APPEND`、`SETEX` 都收到：

```text
OOM command not allowed when used memory > 'maxmemory'.
```

`GET`、`EXISTS`、`SCAN`、`PING` 仍正常；`DEL`、`EXPIRE`、`PERSIST` 也可以执行，因为它们能删除或收缩数据，不应被水位线挡在门外。Redis 7.4 还允许纯只读事务在 OOM 状态执行，写事务则按累积的命令标志判断。

这也是 `noeviction` 的真正含义：不是 Redis 停止服务，而是显式拒绝那些可能继续增大内存、且声明受 OOM 约束的操作。

## 八种策略，是资格与排序的组合

Redis 7.4.11 有八种淘汰策略，外加 `noeviction`。它们可以拆成两道问题：

```text
第一道：谁有资格成为候选？
  allkeys-*   -> 所有键
  volatile-*  -> 只有设置 TTL 的键

第二道：候选按什么排序？
  lru      -> 空闲最久优先
  lfu      -> 频率最低优先
  random   -> 随机
  ttl      -> 预计最早到期优先，仅 volatile-ttl
```

合在一起：

| 候选集合 | LRU | LFU | Random | 最短 TTL |
| --- | --- | --- | --- | --- |
| 全部键 | `allkeys-lru` | `allkeys-lfu` | `allkeys-random` | — |
| 仅 TTL 键 | `volatile-lru` | `volatile-lfu` | `volatile-random` | `volatile-ttl` |

当前最新版资料中可能出现 LRM 策略，但它属于更新版本；Redis 7.4.11 没有 `allkeys-lrm` 或 `volatile-lrm`。

这张表也揭开一个常见误会：`volatile-lru` 不是“先删有 TTL 的键，再考虑其他键”。它从始至终只承认 TTL 键有资格。名单空了，永久键再多也不会补位。

**策略先决定谁能上榜，再决定上榜者怎样排序。**

## volatile 候选耗尽以后

实验写入 550 个带 TTL 的键和 500 个永久键，再使用 `volatile-lru` 继续施压。结果是：

```text
TTL keys:        550 -> 0
persistent keys: 500 -> 500
```

其他 `volatile-lfu`、`volatile-random` 与 `volatile-ttl` 的抽查也保持永久键存活。区别只在 TTL 候选之间怎么选。

当最后一只 TTL 键被淘汰以后，再执行 `SET` 会收到 OOM。即使用 `SETEX` 想写一个未来带 TTL 的新键，仍会失败，因为淘汰检查发生在命令真正写入以前；此刻候选集合仍为空，那个尚未创建的新键不能提前成为自己的牺牲品。

因此，volatile 策略很适合“永久数据绝不能由缓存策略自动删除”的混合场景，却会在缓存候选耗尽时把压力转成写失败。业务必须同时接受这份失败语义，而不只是喜欢它保护永久键的一面。volatile 保护的是候选边界，不保证内存压力总能被解决。

## Redis 没有一条精确 LRU 链表

精确 LRU 的朴素做法，是维护一条所有键按最近访问排序的全局链表。每次读写都把键移动到队头，淘汰时从队尾拿最久未用的键。

这份精确有两个成本：每次访问都要修改全局结构；并发和大键空间下，指针移动、锁与缓存局部性都会进入热路径。Redis 选择把成本压到每个对象的一个 24 位字段。

LRU 模式下，这 24 位保存最近访问时的时钟读数。读取对象时更新字段，淘汰时用当前时钟估算空闲时长。`OBJECT IDLETIME` 返回的就是这份估算秒数，而且使用 `LOOKUP_NOTOUCH`，不会因为查询年龄反过来把对象变新。

时钟分辨率为 1000 毫秒，24 位大约 194 天回绕。估算函数会处理一次回绕关系，但一个键若真有半年未被访问，读数不再适合当作精确业务年龄。

还有一个与前文系列相连的边界：RDB/AOF 子进程存在时，普通访问可能不更新 LRU 字段，以减少写共享页面带来的 COW。淘汰元数据本身也要服从快照内存成本。

近似 LRU 省下的第一笔成本，是不再维护全局顺序：每只对象只记住自己的最近时刻。

## 随机抽样，候选池再排序

只有每键年龄，没有全局链表，Redis 仍不知道谁是全库最老。它在需要淘汰时随机采样，默认每轮查看 `maxmemory-samples=5` 只键。

样本被放入容量为 16 的 eviction pool。池按“最值得淘汰”程度排序，保留跨轮候选；真正删除时从最优候选一端取键。若池里的键已经不存在，就跳过并继续寻找。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="近似淘汰的循环：从候选集合随机采样默认 5 只键，放进容量 16 的 eviction pool 按最值得淘汰排序，从最优端删除一个，仍高于水位就再抽一轮，直到回到水位之下；random 策略不进池" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red9As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">候选名单从不预先存在：水位越界时临时拼出来</text>
<rect class="bx" x="20" y="48" width="170" height="86" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="105" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">候选集合</text>
<rect class="msg" x="40" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="56" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="72" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="88" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="104" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="120" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="136" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="152" y="82" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="105" y="112" text-anchor="middle" font-size="10" fill="#6b675e">allkeys：全库 · volatile：仅 TTL 键</text>
<text class="ts" x="105" y="126" text-anchor="middle" font-size="10" fill="#6b675e">随机采样 N 只（默认 5）</text>
<line class="fl" x1="190" y1="90" x2="236" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red9As3)"/>
<rect class="bx-q" x="240" y="48" width="280" height="86" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="380" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">eviction pool · 容量 16</text>
<rect class="bx" x="256" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="274" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="292" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="310" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="328" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="346" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="364" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="382" y="82" width="14" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="400" y="82" width="14" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="418" y="82" width="14" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="436" y="82" width="14" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="454" y="82" width="14" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="256" y="116" font-size="10" fill="#6b675e">较不该删</text>
<text class="ts" x="468" y="116" font-size="10" fill="#6b675e">→ 最该删</text>
<text class="ts" x="380" y="128" text-anchor="middle" font-size="10" fill="#6b675e">跨轮保留历史样本 · 键没了就跳过</text>
<line class="fl" x1="520" y1="90" x2="556" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red9As3)"/>
<rect class="bx-sick" x="560" y="66" width="90" height="48" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="605" y="86" text-anchor="middle" font-size="11" fill="#b03a2e">删除一个</text>
<text class="ts" x="605" y="104" text-anchor="middle" font-size="10" fill="#6b675e">取最优端</text>
<path class="fl" d="M605 114 L605 172 L105 172 L105 140" fill="none" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#red9As3)"/>
<text class="ts" x="355" y="166" text-anchor="middle" font-size="11" fill="#6b675e">仍高于 maxmemory：再抽一轮（单轮预算约 500μs）</text>
<text class="ts" x="355" y="196" text-anchor="middle" font-size="11" fill="#6b675e">回到水位之下：退出循环，这条命令继续执行</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">排序依据随策略换：LRU 按空闲时长，LFU 按反频率，volatile-ttl 按到期时间</text>
<text class="ts" x="20" y="248" font-size="12" fill="#6b675e">random 策略不进池：抽到即删</text>
</svg>
</figure>

LRU 用空闲时长排序，LFU 用反频率排序，`volatile-ttl` 用到期时间排序。random 策略不走候选池，抽到后直接选择。

这就是“近似”的第二层：Redis 不认识所有键，只认识本轮抽中的少数键，以及候选池残留的历史样本。样本扩大，结果通常更接近全局最优，CPU 成本也增加。

**候选名单从不预先存在，它只在水位越界时由几轮随机抽样临时拼出来。**

## samples 从 1 增加到 25，名单怎样变化

为了看见近似程度，实验把 800 个键分成三组：A 最早访问，B 稍晚，C 最近访问；组间相隔约 8 秒，然后继续写新键，触发约 302 次淘汰。每档 `maxmemory-samples` 跑三轮。

| samples | A 最老组被淘汰 | B 中间组被淘汰 | C 最新组被淘汰 | 新写键被淘汰 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 70–83 | 59–78 | 70–76 | 约 85 |
| 5 | 207–212 | 90–95 | 0 | 约 0 |
| 25 | 256–261 | 41–45 | 0 | 约 0 |

`samples=1` 基本就是随机挑一只：三组受害数量接近，连刚写入的新键也稳定出现于淘汰名单。到默认值 5，最新组在本次三轮中不再被淘汰，压力集中到 A、B；增加到 25 后，名单进一步靠近真正最老的 A 组。

受害者分布画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="三档采样下的受害者分布条形图：samples=1 时 A、B、C、新写键四组各被淘汰六七十到八十五只，接近抽签；samples=5 时 A 组约 209、B 组约 92，C 组和新键归零；samples=25 时 A 组约 258、B 组约 43，名单贴向真正最老的一组" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">800 键三组分层、约 302 次淘汰：每档取三轮的代表值</text>
<text class="ts" x="115" y="56" text-anchor="middle" font-size="12" fill="#6b675e">samples=1</text>
<rect class="bar" x="45" y="145" width="30" height="35" fill="#2b2a26"/>
<rect class="bar" x="85" y="148" width="30" height="32" fill="#6b675e"/>
<rect class="bar" x="125" y="146" width="30" height="34" fill="#a29d90"/>
<rect class="bar" x="165" y="140" width="30" height="40" fill="#b03a2e"/>
<text class="ts" x="60" y="196" text-anchor="middle" font-size="10" fill="#6b675e">76</text>
<text class="ts" x="100" y="196" text-anchor="middle" font-size="10" fill="#6b675e">68</text>
<text class="ts" x="140" y="196" text-anchor="middle" font-size="10" fill="#6b675e">73</text>
<text class="ts" x="180" y="196" text-anchor="middle" font-size="10" fill="#6b675e">85</text>
<text class="ts" x="325" y="56" text-anchor="middle" font-size="12" fill="#6b675e">samples=5（默认）</text>
<rect class="bar" x="255" y="83" width="30" height="97" fill="#2b2a26"/>
<rect class="bar" x="295" y="137" width="30" height="43" fill="#6b675e"/>
<rect class="bar" x="335" y="178" width="30" height="2" fill="#a29d90"/>
<rect class="bar" x="375" y="178" width="30" height="2" fill="#b03a2e"/>
<text class="ts" x="270" y="196" text-anchor="middle" font-size="10" fill="#6b675e">209</text>
<text class="ts" x="310" y="196" text-anchor="middle" font-size="10" fill="#6b675e">92</text>
<text class="ts" x="350" y="196" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="390" y="196" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="535" y="56" text-anchor="middle" font-size="12" fill="#6b675e">samples=25</text>
<rect class="bar" x="465" y="60" width="30" height="120" fill="#2b2a26"/>
<rect class="bar" x="505" y="160" width="30" height="20" fill="#6b675e"/>
<rect class="bar" x="545" y="178" width="30" height="2" fill="#a29d90"/>
<rect class="bar" x="585" y="178" width="30" height="2" fill="#b03a2e"/>
<text class="ts" x="480" y="196" text-anchor="middle" font-size="10" fill="#6b675e">258</text>
<text class="ts" x="520" y="196" text-anchor="middle" font-size="10" fill="#6b675e">43</text>
<text class="ts" x="560" y="196" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="600" y="196" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<line class="axis" x1="35" y1="180" x2="205" y2="180" stroke="#6b675e" stroke-width="1"/>
<line class="axis" x1="245" y1="180" x2="415" y2="180" stroke="#6b675e" stroke-width="1"/>
<line class="axis" x1="455" y1="180" x2="625" y2="180" stroke="#6b675e" stroke-width="1"/>
<rect class="bar" x="40" y="212" width="12" height="12" fill="#2b2a26"/>
<text class="ts" x="58" y="222" font-size="11" fill="#6b675e">A 最老组</text>
<rect class="bar" x="150" y="212" width="12" height="12" fill="#6b675e"/>
<text class="ts" x="168" y="222" font-size="11" fill="#6b675e">B 中间组</text>
<rect class="bar" x="260" y="212" width="12" height="12" fill="#a29d90"/>
<text class="ts" x="278" y="222" font-size="11" fill="#6b675e">C 最新组</text>
<rect class="bar" x="370" y="212" width="12" height="12" fill="#b03a2e"/>
<text class="ts" x="388" y="222" font-size="11" fill="#6b675e">新写键</text>
<text class="ts" x="20" y="246" font-size="12" fill="#6b675e">变的是分布形状，不是总量：淘汰总数由内存缺口决定，策略只决定谁中签</text>
</svg>
</figure>

这些区间只属于本次键数、访问间隔和淘汰压力。换一次随机种子，具体键名会变；换一台机器，时间层次也可能变化。可依赖的是趋势：样本越大，选中“更符合排序目标”的概率越高，但检查成本也更高。

官方建议 5 已能取得较好近似，10 更接近精确 LRU。即使把样本调得很大，每键时钟仍只有秒级和 24 位，也不能宣称得到数学意义上的严格 LRU。近似算法给出的是受害者分布，不是一份可预先写死的名单。

## 同一块 24 位，LFU 换了一种读法

LFU 没有为每个对象再增加一只完整计数器，它重新解释了同一块 24 位字段：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 192" role="img" aria-label="每个对象 24 位字段的两种读法：LRU 模式整段是最近访问时钟，秒级分辨率约 194 天回绕；LFU 模式切成 16 位分钟时钟约 45 天回绕，加 8 位频率计数，初值 5，概率式增长，255 饱和" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一块 24 位，两种切法</text>
<text class="t" x="20" y="66" font-size="12" fill="#2b2a26">LRU</text>
<rect class="bx-q" x="80" y="48" width="460" height="32" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="310" y="68" text-anchor="middle" font-size="11" fill="#6b675e">24 位最近访问时钟：秒级分辨率，约 194 天回绕</text>
<text class="t" x="20" y="126" font-size="12" fill="#2b2a26">LFU</text>
<rect class="bx" x="80" y="108" width="310" height="32" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="235" y="128" text-anchor="middle" font-size="11" fill="#6b675e">16 位分钟时钟：约 45 天回绕</text>
<rect class="bx-sick" x="390" y="108" width="150" height="32" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="465" y="128" text-anchor="middle" font-size="11" fill="#b03a2e">8 位频率计数</text>
<text class="ts" x="80" y="162" font-size="12" fill="#6b675e">计数初值 5，每次访问按概率 +1，255 饱和：是印象值，不是访问次数</text>
<text class="ts" x="80" y="182" font-size="12" fill="#6b675e">策略决定读法：同一块内存，LRU 读出「多久没来」，LFU 读出「来得多勤」</text>
</svg>
</figure>

低 8 位并不记录真实访问次数。新键初始值是 5；每次访问只以一定概率加一：

```text
p = 1 / (baseval * lfu-log-factor + 1)
baseval = max(counter - 5, 0)
```

默认 `lfu-log-factor=10`。计数越高，下一次增长概率越低，最终饱和于 255。这是一种对数式印象：早期几次访问很容易留下痕迹，越热的键越难继续增长。

实验从初值 5 开始，连续访问同一键：

| 累计访问次数 | 1 | 3 | 7 | 15 | 31 | 63 | 127 | 255 | 511 | 1023 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 本次 FREQ | 6 | 7 | 7 | 7 | 8 | 8 | 9 | 11 | 15 | 16 |

这是一条随机概率曲线，不是每次运行必须得到的固定表。官方默认参数的数量级示例也显示：约 100 次访问可能到 10，1000 次到 18，约一百万次才接近 255。

这次加热的曲线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 234" role="img" aria-label="LFU 加热曲线：横轴是累计访问次数（对数），纵轴是 OBJECT FREQ；1 次访问从初值 5 到 6，1023 次访问也只到 16，前几次最容易留下痕迹，越热越难增长" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">连续访问同一只键：1023 次只把 FREQ 从 5 推到 16</text>
<text class="ts" x="20" y="44" font-size="11" fill="#6b675e">OBJECT FREQ</text>
<line class="grid" x1="70" y1="130" x2="610" y2="130" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="70" x2="610" y2="70" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="190" x2="70" y2="50" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="190" x2="620" y2="190" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="194" text-anchor="end" font-size="11" fill="#6b675e">5</text>
<text class="ts" x="62" y="134" text-anchor="end" font-size="11" fill="#6b675e">10</text>
<text class="ts" x="62" y="74" text-anchor="end" font-size="11" fill="#6b675e">15</text>
<polyline class="curve-k" points="70,178 155,166 222,166 281,166 337,154 393,154 447,142 502,118 556,70 610,58" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="70" cy="178" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="222" cy="166" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="337" cy="154" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="447" cy="142" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="556" cy="70" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="610" cy="58" r="3" fill="#b03a2e"/>
<text class="tc" x="86" y="160" font-size="11" fill="#b03a2e">前几次最容易留下痕迹</text>
<text class="ts" x="420" y="170" font-size="11" fill="#6b675e">越热，下一次 +1 越难</text>
<text class="ts" x="70" y="210" text-anchor="middle" font-size="11" fill="#6b675e">1</text>
<text class="ts" x="178" y="210" text-anchor="middle" font-size="11" fill="#6b675e">4</text>
<text class="ts" x="286" y="210" text-anchor="middle" font-size="11" fill="#6b675e">16</text>
<text class="ts" x="394" y="210" text-anchor="middle" font-size="11" fill="#6b675e">64</text>
<text class="ts" x="502" y="210" text-anchor="middle" font-size="11" fill="#6b675e">256</text>
<text class="ts" x="610" y="210" text-anchor="middle" font-size="11" fill="#6b675e">1024</text>
<text class="ts" x="620" y="228" text-anchor="end" font-size="11" fill="#6b675e">累计访问次数（横轴对数）</text>
</svg>
</figure>

`OBJECT FREQ` 使用不触碰对象的读取路径，并计算惰性衰减，不会因为查看频率而给它增加一次访问。

**LFU 的 8 位是一枚增长越来越慢的印象值，与真实访问次数无关。**

## 热度会衰减，不会永久封存

LFU 高 16 位记录分钟时钟。默认 `lfu-decay-time=1`，对象沉寂一个衰减周期，频率就在下一次访问或采样评估时按经过周期数下降；配置 0 表示不衰减。

实验把一只键加热到 FREQ 16：

```text
空闲约 65 秒  -> OBJECT FREQ 15
空闲约 130 秒 -> OBJECT FREQ 14
```

这次结果与一分钟一级的默认设置吻合。衰减是惰性计算：Redis 不会每分钟扫描全库给所有键减一，只在需要观察该对象时按时间差补算。

16 位分钟时钟约 45 天回绕，8 位计数器在 255 饱和。因此 FREQ 与 IDLETIME 都是为淘汰服务的紧凑估计，不能当作业务计费、审计或精确热度统计。

回到开场实验。350 个 hot 键各访问约 60 次，FREQ 大致落在 8–10；350 个 cold 键保持初值 5。三轮淘汰中，hot 都是 350/350 存活，cold 约剩 220、215、218。LFU 候选池明显优先选择低频 cold。

但“曾经很热”不是永久护身符。沉寂足够久，hot 的计数会持续衰减，最终回到新键附近。LFU 保护的是仍保留热度印象的键，不是一段永不褪色的历史。

## volatile-ttl 也只是近似最早到期

`volatile-ttl` 常被描述成“删除 TTL 最短的键”。更准确的说法是：它只在带 TTL 的键中随机采样，再用绝对到期时间给候选池排序。

实验准备 600 个短 TTL 键（约 300 秒）和 600 个长 TTL 键（约 86400 秒），在相同内存压力下触发 698 次淘汰：

| 策略 | samples | short 存活 | long 存活 |
| --- | ---: | ---: | ---: |
| `volatile-ttl` | 5 | 27、38 | 474、463 |
| `volatile-ttl` | 25 | 0、0 | 501、501 |
| `volatile-random` | 5 | 242 | 259 |
| `volatile-lru` | 5 | 285 | 216 |

默认样本 5 已强烈偏向短 TTL，却仍淘汰了一部分长 TTL 键；样本 25 的两轮中，短 TTL 全部先离开。总淘汰数都由内存缺口决定，策略只改变受害者构成。

`volatile-lru` 与到期远近无关，只看访问年龄；`volatile-random` 则在 TTL 候选中近似均匀。策略名字描述评分目标，不承诺全库精确排序。

## 摘牌以后，删除还要走完整路径

被淘汰键从数据库删除，增加 `evicted_keys`，产生 `evicted` 键空间事件，并把删除传播到 AOF 与副本。复制篇里的字节流会包含这项删除，让副本保持同一数据集。

这与过期删除是两套原因和计数器：

```text
expired_keys -> 截止时间到了，由惰性/主动过期发现
 evicted_keys -> 内存超限，由淘汰策略选择
```

两条路径最终都可能传播 `DEL` 或异步释放语义，却不应把“过期”和“淘汰”混成同一件事。

`lazyfree-lazy-eviction` 默认关闭。开启以后，只有释放工作量大于阈值 64、且对象引用条件合适的重对象才会交给 bio 线程；小字符串仍同步释放。实验试了大值与大列表，但客户端启动开销、参数传输和对象编码让差异无法稳定从噪声中分离，因此本文不把那组结果作为性能证据。机制边界仍可从源码确认：开关不等于所有淘汰都异步。

删除也不保证 RSS 立即下降。淘汰降低分配器 allocated，jemalloc 可能保留页供复用，muzzy 页与内核回收又有各自节奏。`used_memory`、`allocator_active`、`allocator_resident`、`used_memory_rss` 量的是不同层面的占用。

**淘汰承诺键离开键空间，不承诺操作系统在同一毫秒收回对应页面。**

## 副本默认不自己挑受害者

`replica-ignore-maxmemory` 在 Redis 7.4.11 默认是 `yes`。副本即使越过本地 `maxmemory`，也不自行按策略删除主库数据，而是等待主库传播淘汰结果。

这是数据一致性的选择。若主副本各自随机采样并淘汰，哪怕策略与水位完全相同，也可能得到不同受害者名单。复制要求删除权集中在主库，副本应用同一条删除流。

代价是副本内存可能超过 maxmemory，特别是在同步、输出缓冲或复制延迟阶段。晋升为主库后，它才重新承担本地淘汰决策。把 `replica-ignore-maxmemory` 关闭，需要应用能够容忍副本自己删除数据造成的差异。副本继承的是删除结果，与主库抽样时看到的候选名单无关。

## 监控不止看 OOM

`INFO stats` 中最直接的是：

```text
evicted_keys
expired_keys
current_eviction_exceeded_time
total_eviction_exceeded_time
```

`evicted_keys` 是累计值，监控应看时间差和速率。实验一次完整周期里记录到 1830 次淘汰；它只说明发生过多少次，不说明每只键为何被选中。

`INFO memory` 应一起查看：

```text
used_memory
used_memory_rss
allocator_allocated
allocator_active
allocator_resident
allocator_muzzy
mem_not_counted_for_evict
mem_replication_backlog
mem_aof_buffer
lazyfree_pending_objects
```

启用非零 `latency-monitor-threshold` 后，还可以观察 `eviction-cycle`、`eviction-del`、`eviction-lazyfree`。本次 8KB 小键实验把阈值设为 5 毫秒，没有产生淘汰延迟事件，`total_eviction_exceeded_time` 也为 0。这只能说明此次对象与负载未跨过阈值，不能证明淘汰没有延迟成本。

有个意外结果值得记下：批量读取大值会扩大客户端输出缓冲，而输出缓冲计入 used_memory。实验早期用大量 `GET` 给 LFU 键加热，回复缓冲本身把实例推过水位，读取过程中发生淘汰。后来改用只返回一个字节的 `GETRANGE`，才把“触碰键”和“制造大回复”分开。`EXISTS` 又是 `LOOKUP_NOTOUCH`，不能用于加热 LRU/LFU。

内存压力不只来自数据值，观测实验本身也会改变水位。

## 选择策略以前，先回答四个问题

**所有键都可以被当作缓存丢弃吗？** 如果可以，`allkeys-lru` 或 `allkeys-lfu` 通常比 volatile 策略拥有更充足的候选集合。若永久键不能自动删除，volatile 策略要求业务接受候选耗尽后的 OOM。

**重要性更接近“最近来过”还是“经常来过”？** LRU 适合局部性强、热点快速变化的访问；LFU 适合访问频率更能代表长期价值的工作集。两者都近似，都可能误判。

**写失败是否比静默删除更安全？** Redis 不只用作缓存时，`noeviction` 往往更诚实：让调用方看到 OOM，而不是在没有业务语义参与的情况下删除一条数据。

**愿意为更准确的近似付出多少 CPU？** 调大 `maxmemory-samples` 能让候选更接近评分目标，也会增加每次淘汰选择的工作量。`maxmemory-eviction-tenacity` 则决定一轮愿意占用主线程多久。

策略没有“最先进者胜出”。它把业务的遗忘规则压缩成候选范围和近似评分，选错以后，Redis 仍会严格执行那份错误的规则。

## 近似换来了什么

这套设计里全是交换。精确换吞吐：Redis 不维护全局 LRU 链表，而用每对象 24 位字段记录时间或频率，避免每次访问移动共享结构。准确换延迟：随机采样和 16 格候选池让每轮判断有界，代价是受害者名单随样本波动。频率换空间：LFU 用 8 位概率计数器表达大范围访问量，代价是饱和、衰减与随机增长。删除权换一致性：主库统一选择并传播删除，副本默认不自行淘汰，代价是副本本地水位不受同样约束。内存回落换复用：分配器保留已释放页面可以加速后续分配，却让 RSS 不按淘汰数量同步下降。

Redis 淘汰的从来不是全局唯一、数学上最该离开的键。它在候选集合里抽取有限样本，用紧凑字段排出一份临时名单，再在时间预算内删除到够用为止。同一批数据在 LRU 与 LFU 下得到不同结果，也不是谁算错了：两种策略对“重要”下了不同定义，具体受害者由抽样决定，只有分布逐渐靠近各自的目标。
