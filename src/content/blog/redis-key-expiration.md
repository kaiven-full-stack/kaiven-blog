---
title: 过期的键，不会准时消失：Redis 的过期机制
description: EXPIRE 写下的是截止时间，不是一只到点删除的闹钟。本文从绝对时间戳、惰性删除与主动过期出发，继续追到持久化、复制、时钟跳变和内存释放，把“不可见”与“已消失”之间的距离一段段量出来。实验跑在官方 Redis 7.4.11 容器里。
pubDate: 2026-09-05
category: redis
tags: [Redis, 数据库]
---

23:59:00 写入 `SET session:42 "kaiven" EX 60`，00:00:00 截止时间到了。00:00:01 这一刻，那个键还占着内存吗？前两问有明确答案，第三问没有。

`EX 60` 看起来像给键上了一只一分钟后响铃的闹钟。时间一到，Redis 似乎应该立刻停下手里的工作，找到这个键，把它从字典中删除，再归还内存。可 Redis 没有为每个键各挂一只定时器。它写下的是一个截止时间，至于何时真正清理，要等一次访问，或等后台过期循环走到这里。

因此，一个键可以已经过期，读者也再拿不到它，却仍未从内部数据结构中移除。**逻辑上的不存在，与物理上的删除，不在同一个时刻发生。**

这篇以 Redis 7.4.11 的键级过期机制为主，实验在官方 7.4.11 镜像中完成，涉及 Redis 6.2 的行为另做了对照；源码名称以该版本为准。Redis 7.4 新增的 Hash 字段过期是另一套机制，留到文末划清边界。

## EXPIRE 存的不是“还剩六十秒”

先写一个最普通的会话：

```text
127.0.0.1:6379> SET session:42 kaiven EX 60
OK
127.0.0.1:6379> TTL session:42
(integer) 60
127.0.0.1:6379> PTTL session:42
(integer) 59673
```

客户端给的是相对时长，Redis 内部保存的却不是一个从 60000 往下递减的计数器，而是一个绝对 Unix 时间戳，精确到毫秒。概念上近似这样：

```text
expire_at = current_unix_time_ms + 60000
```

主键和值放在键空间中，带过期时间的键还会进入一份过期索引。Redis 7.2 及更早版本的 `redisDb.expires` 是字典；7.4 稳定版换成了按槽组织的 `kvstore`，底层仍是哈希表。网上常见的“Redis 6 用 radix tree 保存过期键”并不符合这些版本的源码：Redis 6 改的是主动过期的扫描方式，并没有把键级过期索引换成 radix tree。

绝对时间戳有一个直接后果：Redis 停机时，时间不会暂停。

假设一个键在 12:00 设置十分钟 TTL，12:03 关闭 Redis，12:08 再启动，它剩下的不是七分钟，更不会重新得到十分钟，只剩两分钟。若 12:15 才启动，加载数据时它已经过期。

这笔时间账画成线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 188" role="img" aria-label="停机与截止时间的时间线：12:00 设置十分钟 TTL，截止时间钉在 12:10；12:03 关闭 Redis 到 12:08 启动期间墙上时钟照走，剩余只有两分钟；若 12:15 才启动，加载时键已过期被直接跳过" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red2As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">截止时间钉在墙上时钟上，停机期间照走</text>
<line class="axis" x1="40" y1="100" x2="620" y2="100" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red2As1)"/>
<line class="flk" x1="80" y1="86" x2="80" y2="114" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="80" y="76" text-anchor="middle" font-size="11" fill="#6b675e">12:00 SET EX 600</text>
<line class="flk" x1="179" y1="86" x2="179" y2="114" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="179" y="132" text-anchor="middle" font-size="11" fill="#6b675e">12:03 关闭</text>
<rect class="bx-gone" x="179" y="92" width="165" height="16" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="261" y="76" text-anchor="middle" font-size="11" fill="#6b675e">停机：时间戳安静躺着，时钟照走</text>
<line class="flk" x1="344" y1="86" x2="344" y2="114" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="344" y="132" text-anchor="middle" font-size="11" fill="#6b675e">12:08 启动：剩 2 分钟</text>
<line class="flc" x1="410" y1="82" x2="410" y2="118" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="410" y="72" text-anchor="middle" font-size="11" fill="#b03a2e">12:10 expire_at</text>
<line class="fl" x1="575" y1="86" x2="575" y2="114" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="4 3"/>
<text class="ts" x="575" y="132" text-anchor="middle" font-size="11" fill="#6b675e">12:15 启动：已过期</text>
<text class="ts" x="20" y="168" font-size="12" fill="#6b675e">重启不续命也不清零：当前时钟与截止时间的差，在加载那一刻已经算好</text>
</svg>
</figure>

Redis 7.0 以后可以直接查看这张“截止日期”：

```text
127.0.0.1:6379> PEXPIRETIME session:42
(integer) 1788566460123
```

`PTTL` 是 `expire_at - now` 的结果，`PEXPIRETIME` 才接近 Redis 真正保存的那一项事实。

## 截止时间不是一只定时器

若为一百万个键各创建一个精确定时器，Redis 就得维护一百万个待触发事件。每次新增、续期和取消 TTL 都要调整定时结构；大量键在同一毫秒到期时，还会集中争抢事件循环。

Redis 选择的是另一份承诺：

```text
截止时间以前：键可以被正常读取。
截止时间以后：命令不应再把它当作有效数据返回。
物理删除时间：由惰性删除与主动过期共同决定。
```

这三行中，前两行属于可见语义，第三行属于回收策略。

源码里的 `keyIsExpired()` 负责比较当前时间与绝对截止时间，`expireIfNeeded()` 负责在访问路径上处理已经到期的键。这个检查嵌在读写键的流程里，不是一项独立运行的倒计时任务。

可以把一次 `GET` 简化成这样：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="GET 的过期检查决策树：查找键后三个分支，没有过期时间照常返回，截止时间尚未到照常返回，截止时间已过则按过期处理，向客户端表现为不存在，主库上还顺手执行删除与传播" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red2As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">每次碰键的命令都要过一遍这棵树</text>
<rect class="bx-q" x="30" y="76" width="130" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="95" y="94" text-anchor="middle" font-size="13" fill="#2b2a26">GET 某个键</text>
<text class="ts" x="95" y="112" text-anchor="middle" font-size="10" fill="#6b675e">查找键</text>
<line class="fl" x1="160" y1="86" x2="316" y2="52" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red2As2)"/>
<line class="fl" x1="160" y1="98" x2="316" y2="98" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red2As2)"/>
<line class="fl" x1="160" y1="110" x2="316" y2="144" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red2As2)"/>
<text class="ts" x="230" y="58" text-anchor="middle" font-size="11" fill="#6b675e">没有过期时间</text>
<text class="ts" x="230" y="92" text-anchor="middle" font-size="11" fill="#6b675e">截止时间尚未到</text>
<text class="tc" x="230" y="138" text-anchor="middle" font-size="11" fill="#b03a2e">截止时间已过</text>
<rect class="bx" x="320" y="36" width="220" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="430" y="56" text-anchor="middle" font-size="12" fill="#6b675e">照常返回</text>
<rect class="bx" x="320" y="82" width="220" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="430" y="102" text-anchor="middle" font-size="12" fill="#6b675e">照常返回</text>
<rect class="bx-sick" x="320" y="128" width="310" height="32" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="475" y="148" text-anchor="middle" font-size="12" fill="#b03a2e">按过期处理：表现为不存在</text>
<text class="ts" x="320" y="180" font-size="11" fill="#6b675e">第三个分支在主库上还顺手做两件事：执行删除、传播给副本与 AOF</text>
</svg>
</figure>

所以“键已过期”至少有两种含义：

- 截止时间已经越过，键在逻辑上不应再可见；
- Redis 已执行删除，键和值不再占据键空间。

把二者混成一句“TTL 到了，键就被删了”，很多后续问题都会解释错。

## 惰性删除：访问时才检查

第一条清理路径叫惰性删除。客户端访问一个键时，Redis 顺手检查它的截止时间；若已过期，就不再返回旧值，并在主库上执行删除和传播。

假设一批会话键已经过期。热门会话很快会被下一次 `GET`、`EXISTS` 或其他访问碰到，随即清理；再也无人访问的冷键，则不能指望惰性路径替它们收尾。

这是一项很划算的策略：

- 没有 TTL 的键不用承担定时器成本；
- 未到期的键只做一次时间比较；
- 已到期且正被访问的键，恰好是此刻必须对外隐藏的键。

代价也同样明确：只靠惰性删除，冷键可以无限期占着内存。于是 Redis 还需要第二条路。

有个边界值得单独记下：一条命令执行期间，Redis 会使用命令开始时取得的时间快照；Lua 脚本执行时也不会让键在脚本中途突然过期。否则同一条复合操作的前半段可能看见键存在，后半段却发现它刚刚消失。冻结的是一次命令里的观察时刻，不是整个服务器的时钟。

## 主动过期：周期性巡检

第二条路径是 `activeExpireCycle()`。它不等客户端访问，而是周期性检查过期索引，主动清理已经越过截止时间的键。

Redis 7.4 中有两种循环：

- **SLOW cycle** 由 `serverCron` 驱动。默认 `hz` 为 10，大约每 100 毫秒获得一次运行机会；
- **FAST cycle** 在事件循环休眠前尝试补做，默认单次预算约 1 毫秒，但并非每轮事件循环都必然执行。

“慢”和“快”描述的是调度方式与时间预算，与删除键的速度无关。两者都受预算约束，都不能为了清完过期键而无限占住主线程。

默认 effort 下，主动循环每轮从一个数据库的过期索引中取有限数量的键检查。若样本里过期键比例仍高，就继续一轮；若比例已经较低，或本轮时间用完，就把执行权还给正常命令。Redis 6 起，这里从早期的随机取键改成了带游标的桶式扫描；游标留到下一轮继续，不需要每次从头找起。

两条路径，一个出口：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 258" role="img" aria-label="两条清理路径汇入一个出口：左边惰性删除靠访问触发，热键下次 GET 就被收走，冷键无人访问无限期等待；右边主动过期由 SLOW 循环每 100 毫秒一轮、FAST 循环休眠前补做，带游标分桶按预算巡检；两条路都走到真正删除那一刻，才产生 expired 通知" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red2As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">谁替过期的键收尾：两条路径，一个出口</text>
<rect class="bx-q" x="20" y="44" width="300" height="146" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="68" text-anchor="middle" font-size="13" fill="#2b2a26">惰性删除 · 访问才检查</text>
<text class="ts" x="40" y="96" font-size="11" fill="#6b675e">热键：下一次 GET / EXISTS 就被收走</text>
<text class="tc" x="40" y="120" font-size="11" fill="#b03a2e">冷键：无人访问，可以无限期占着内存</text>
<text class="ts" x="40" y="144" font-size="11" fill="#6b675e">成本：每次碰键多一次时间比较</text>
<text class="ts" x="40" y="168" font-size="11" fill="#6b675e">命令内用时间快照，脚本中途键不会突变</text>
<rect class="bx" x="340" y="44" width="300" height="146" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="490" y="68" text-anchor="middle" font-size="13" fill="#2b2a26">主动过期 · 周期巡检</text>
<text class="ts" x="360" y="96" font-size="11" fill="#6b675e">SLOW：serverCron 驱动，约每 100ms 一轮</text>
<text class="ts" x="360" y="120" font-size="11" fill="#6b675e">FAST：事件循环休眠前补做，预算约 1ms</text>
<text class="ts" x="360" y="144" font-size="11" fill="#6b675e">带游标分桶扫描，比例高就再来一轮</text>
<text class="ts" x="360" y="168" font-size="11" fill="#6b675e">预算用完把执行权还给正常命令</text>
<line class="fl" x1="170" y1="190" x2="270" y2="212" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red2As3)"/>
<line class="fl" x1="490" y1="190" x2="390" y2="212" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red2As3)"/>
<rect class="bx-sick" x="190" y="216" width="280" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="330" y="237" text-anchor="middle" font-size="12" fill="#b03a2e">真正删除的那一刻，才产生 expired 通知</text>
</svg>
</figure>

默认配置大致在权衡四件事：

```text
每轮检查多少键
一轮最多占用多少 CPU 时间
允许估算中残留多少过期键
事件循环多久获得一次处理正常请求的机会
```

`active-expire-effort` 把这份权衡暴露成 1 到 10 的旋钮，默认是 1。提高它会增加每轮样本数和 CPU 时间预算，同时降低可容忍的陈旧比例。它换不来“更准时的过期”，只是用更多主线程时间换更积极的内存回收。

## 五千把同时到期的钥匙

为了看见主动过期，可以在一个隔离的测试实例中写入五千个一秒后过期、之后不再访问的键：

```sh
for i in $(seq 1 5000); do
  redis-cli SET "expiry-demo:$i" value EX 1 >/dev/null
done
```

然后只查看整体统计，不逐个读取这些键：

```text
127.0.0.1:6379> INFO keyspace
# Keyspace

127.0.0.1:6379> INFO stats
expired_keys:5000
```

最终，五千个键在没有客户端逐个访问的情况下被清完，说明主动过期循环确实在工作。

更有意思的是中途快照。测试时曾看到一部分键已经删除，另一部分仍在 keyspace 中；稍后再看才全部归零。这个中间数字每次都不同，取决于机器速度、写入耗时、`hz`、effort 和当时负载，不能写成固定结果。

实验能证明“无人访问的键也会被主动清理”，却不能证明“每个键会在第 1000 毫秒准时删除”。相反，那段短暂残留正是预算式巡检的正常结果。

如果业务要求某件事在准确时刻发生，键过期通知也不是定时任务系统。`expired` 事件在 Redis 真正执行删除时产生，而不是截止时间刚越过时凭空产生；主动循环忙、键一直没被访问，通知就可能晚到。

## TTL 为零，键也可能还活着

`TTL` 的返回值还有一个容易误读的细节。它把剩余毫秒近似到秒，而非简单向下取整；当前源码的换算近似为：

```text
(ttl_ms + 500) / 1000
```

因此，设置 900 毫秒后立刻查询，可能得到：

```text
127.0.0.1:6379> SET ttl:round value PX 900
OK
127.0.0.1:6379> TTL ttl:round
(integer) 1
```

而只剩不到半秒时，`TTL` 可能返回 0，此刻键仍可以存在。`TTL = 0` 的意思是“剩余时间折算到秒后为零”，不是“键已被删除”。需要毫秒精度时应使用 `PTTL`。

另外两个负数才是状态码：

```text
TTL = -1  键存在，但没有过期时间
TTL = -2  键不存在，或本次查询发现它已经过期
```

自 Redis 2.8 起二者才被区分。查询本身也会经过过期检查，因此对一个逻辑上已过期的键执行 `TTL`，得到的通常是 `-2`，而不是一个负的剩余秒数。

还有一个边界：过期判断使用严格的时间比较。时间刚好等于截止毫秒时，内部判定与下一毫秒可能不同；再叠加命令时间快照和 TTL 的秒级近似，更不应把 `TTL 0` 当作业务状态机中的精确瞬间。

## 改值与改期限，是两份操作

TTL 依附于键，却不是任何修改都保留，也不是任何修改都清除。

普通 `SET` 替换整个值，默认会移除原来的 TTL：

```text
127.0.0.1:6379> SET article draft EX 300
OK
127.0.0.1:6379> SET article published
OK
127.0.0.1:6379> TTL article
(integer) -1
```

若替换值时仍要保留期限，Redis 6.0 起可以明确写 `KEEPTTL`：

```text
127.0.0.1:6379> SET article draft EX 300
OK
127.0.0.1:6379> SET article published KEEPTTL
OK
127.0.0.1:6379> TTL article
(integer) 300
```

具体数字可能已经减去一两秒，关键是它不再变成 `-1`。

像 `INCR`、`LPUSH`、`HSET` 这类在原值上修改内容的操作，通常保留键的 TTL；`DEL`、普通 `SET`、`GETSET` 和各类覆盖结果的 `*STORE` 命令会让旧期限随旧值一起消失。`RENAME` 则把来源键的 TTL 一并搬到新名字上，连目标键原来的属性一起覆盖。

Redis 7.0 又为 `EXPIRE` 家族加入了条件：

- `NX`：键目前没有 TTL 时才设置；
- `XX`：键已经有 TTL 时才更新；
- `GT`：新截止时间更晚时才更新；
- `LT`：新截止时间更早时才更新。

无 TTL 的键在比较中被视为拥有无限寿命，所以 `GT` 对它失败，`LT` 对它可以成功。这份不对称不是例外：任何有限期限都不比无限更晚，却一定比无限更早。

期限已经成为数据的一部分，更新值时便要明确决定它是保留、替换还是取消。一次无意的普通 `SET`，足以把临时缓存改成永久键。

## 过去的截止时间，不等后台来收

给 `EXPIRE` 传非正数，或给 `EXPIREAT` 一个过去的时间，主库不会先把键标成“等待过期”，而是直接删除：

```text
127.0.0.1:6379> SET deadline value
OK
127.0.0.1:6379> EXPIRE deadline -1
(integer) 1
127.0.0.1:6379> EXISTS deadline
(integer) 0
```

键空间通知中，这种情况产生的是 `del`，不是 `expired`。因为执行命令的这一刻，Redis 已经知道截止时间不可能位于未来，没有必要再交给过期循环。

这也提醒了一件事：`EXPIRE` 不是向某个调度器注册回调。它改变的是键的有效期；若新期限已经失效，最合理的状态转换就是立即删除。

## RDB 保存的是日期，不是倒计时

绝对时间戳还要穿过持久化。

RDB 在键旁写下绝对过期时间。加载 RDB 时，主库会拿它和当前时钟比较，已经过期的键通常直接跳过。一个两分钟 TTL 的键经历保存与重启，可以观察到：

```text
设置后       TTL ≈ 120
BGSAVE 后    TTL < 120
重启以后     TTL 继续减少，而不是回到 120
```

AOF 也要维持同一语义。主库真正让键过期时，会合成删除操作写入 AOF 并传播给副本；AOF 重写则为仍有效的键写出类似 `PEXPIREAT` 的绝对截止时间。否则每次重放一个相对 `EXPIRE 120`，重启都会凭空替键续命两分钟。

所以“Redis 停机期间 TTL 是否继续走”不由某个后台线程决定。时间戳安静地躺在文件里，重新加载时，当前时钟与截止时间的差已经替它给出答案。

## 时钟往前拨，键会提前老去

既然保存的是 Unix 时间戳，过期语义就依赖墙上时钟，而不是单调递增、只适合计算耗时的 monotonic clock。

假设现在写入：

```text
expire_at = 12:00:00 + 1000 秒
```

随后系统时钟被直接拨快 2000 秒。下一次过期判断会发现当前时间已经越过 `expire_at`，键立即被视为过期。反过来，若时钟大幅回拨，原本只剩几分钟的键会得到一段额外寿命。

问题不出在 Redis 自己的计时上，而是绝对日期所依赖的参照物被改了。RDB 从一台时钟偏慢的机器搬到另一台时钟偏快的机器，也可能在加载时发现大量键已经“老去”。

渐进式 NTP 校时通常比人工跳变温和，但工程结论仍然明确：运行 Redis 的机器需要稳定的系统时间。单条命令内冻结时间快照，只能保证一次操作前后一致，不能替整台机器修正错误时钟。

## 副本看见过期，不等于有权删除

复制让“逻辑不可见”和“物理删除”的分离更明显。

Redis 把过期删除的决定集中在主库。主库通过惰性或主动路径确认键过期后，会合成 `DEL` 或 `UNLINK` 语义的删除，写入持久化并传播给副本。副本不靠自己的主动过期循环独立删除主库数据，否则两台机器的时钟稍有偏差，就可能各自得出不同的数据集。

但副本处理读命令时，仍会用自己的逻辑时钟判断键是否已经过期，并向客户端表现为不存在。于是短时间内可能同时成立：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="主库与副本的两层状态：主库确认过期后合成 DEL 或 UNLINK 写入 AOF 并传播；删除还在路上时，副本对普通读取已经表现为键不存在，但内部数据仍然保留着，等主库的删除命令到达才物理移除" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red2As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">删除传播在路上的那一小段时间</text>
<rect class="bx-q" x="30" y="48" width="220" height="92" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="140" y="72" text-anchor="middle" font-size="13" fill="#2b2a26">主库</text>
<text class="ts" x="140" y="94" text-anchor="middle" font-size="11" fill="#6b675e">惰性/主动确认过期</text>
<text class="ts" x="140" y="112" text-anchor="middle" font-size="11" fill="#6b675e">合成 DEL，写 AOF 并传播</text>
<line class="fl" x1="250" y1="94" x2="336" y2="94" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red2As5)"/>
<text class="ts" x="293" y="84" text-anchor="middle" font-size="10" fill="#6b675e">删除在路上</text>
<rect class="bx" x="340" y="48" width="290" height="92" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="485" y="72" text-anchor="middle" font-size="13" fill="#2b2a26">副本</text>
<text class="ts" x="485" y="94" text-anchor="middle" font-size="11" fill="#6b675e">对普通读取：已经表现为不存在</text>
<text class="tc" x="485" y="114" text-anchor="middle" font-size="11" fill="#b03a2e">内部：数据仍在，等主库的删除命令</text>
<text class="ts" x="20" y="170" font-size="12" fill="#6b675e">主库的 DEL 到达，副本才物理删除：内存曲线到那一刻才动</text>
<text class="ts" x="20" y="190" font-size="12" fill="#6b675e">观测口径：在副本上，「读不到」与「键还在」可以同时成立</text>
</svg>
</figure>

这正是全文开头那道问题的另一份答案：键还在不在，要先问“对谁、在哪一层”。

当副本被提升为主库，它已经保存了完整的过期信息，从此会自行执行主动过期。至于可写副本上的本地键，则属于历史兼容机制，有额外的过期追踪和数据库编号限制；官方也不建议把可写副本当作常规数据模型使用。

复制保证的是由主库统一推进删除，不承诺所有节点在同一毫秒释放同一块内存。

## 删除了，也不等于内存立刻还给操作系统

现在终于走到最容易被混淆的最后一层：键已经从数据库删除，内存曲线为什么仍没有按预期下降？

首先，删除对象本身可能有成本。一个很短的字符串可以很快释放；一个包含数百万元素的集合若在主线程同步析构，会制造明显停顿。`DEL` 默认同步释放，`UNLINK` 则尝试把足够重的对象交给后台 lazyfree 线程。

但 `UNLINK` 也不是“所有对象一律异步”。Redis 会估算释放工作量；当前实现的阈值为 64，工作量不够大的对象仍可能同步处理。过期删除是否采用后台释放，则由 `lazyfree-lazy-expire` 控制，默认关闭。

其次，即使对象已经释放给内存分配器，进程的 RSS 也未必立即等量下降。内存碎片、分配器保留页以及操作系统回收策略，都可能让 `used_memory`、`used_memory_rss` 和容器看到的占用呈现不同曲线。

于是“过期”到“操作系统拿回内存”之间至少有四个时刻：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="T1 到 T4 四个时刻的时间线：T1 绝对截止时间到达后键逻辑不可见；T2 某次访问或主动循环发现过期；T3 键从数据库移除、对象同步或异步释放；T4 分配器或操作系统真正回收页面，内存曲线才动；这段距离每个键不一样" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<line class="axis" x1="40" y1="90" x2="620" y2="90" stroke="#6b675e" stroke-width="1.2"/>
<line class="flc" x1="100" y1="76" x2="100" y2="104" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="100" y="44" text-anchor="middle" font-size="12" fill="#b03a2e">T1 · 截止时间到达</text>
<text class="ts" x="100" y="62" text-anchor="middle" font-size="10" fill="#6b675e">逻辑上不该再可见</text>
<line class="flk" x1="250" y1="76" x2="250" y2="104" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="250" y="44" text-anchor="middle" font-size="12" fill="#6b675e">T2 · 被发现</text>
<text class="ts" x="250" y="62" text-anchor="middle" font-size="10" fill="#6b675e">某次访问，或巡检走到</text>
<line class="flk" x1="400" y1="76" x2="400" y2="104" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="400" y="44" text-anchor="middle" font-size="12" fill="#6b675e">T3 · 移除并释放</text>
<text class="ts" x="400" y="62" text-anchor="middle" font-size="10" fill="#6b675e">同步或 lazyfree 异步</text>
<line class="flk" x1="550" y1="76" x2="550" y2="104" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="550" y="44" text-anchor="middle" font-size="12" fill="#6b675e">T4 · 页面回收</text>
<text class="ts" x="550" y="62" text-anchor="middle" font-size="10" fill="#6b675e">内存曲线到这才动</text>
<path class="fl" d="M100 116 L100 128 L550 128 L550 116" fill="none" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="325" y="148" text-anchor="middle" font-size="11" fill="#6b675e">「不可见」与「已消失」的距离：每个键不一样，从几乎为零到无限期</text>
<text class="ts" x="20" y="178" font-size="12" fill="#6b675e">看到内存没降，先分辨卡在哪一段：没被发现、排队释放中，还是分配器没还页</text>
</svg>
</figure>

Redis 对 T1 之后的读取语义负责，却没有承诺 T1、T2、T3、T4 重合。

## 缓存雪崩，不只是同一秒访问失败

大量键设置相同 TTL，风险通常被概括成“缓存雪崩”：同一时刻缓存失效，请求一起落到数据库。这个描述没错，但过期机制还会叠加另一层压力。

截止时间集中意味着：

- 客户端在相近时间一起读到 miss，回源请求上升；
- 主动过期循环连续发现高比例的过期键，占用更多事件循环预算；
- 若值是大集合，同步释放可能增加延迟尖峰；
- AOF、复制和键空间通知还要处理相应的删除传播。

给 TTL 加随机抖动，可以把截止时间错开：

```text
base_ttl + random(0, jitter)
```

它缓解的是集中到期，不解决缓存击穿所需的并发重建，也不保证每个键准点删除。热点键仍可能需要请求合并、逻辑过期、后台刷新或分层缓存。

集中与错开，两种刻度：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="缓存雪崩与抖动的刻度对照：上排五千个键同一个 TTL，截止时间挤在同一毫秒，miss 回源、巡检预算、同步释放、删除传播一起到来；下排同样的键加随机抖动后，截止时间摊开在一个区间里，峰值被削平" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">上：五千个键，同一个 TTL</text>
<line class="axis" x1="40" y1="66" x2="620" y2="66" stroke="#6b675e" stroke-width="1.2"/>
<line class="flc" x1="410" y1="50" x2="410" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="413" y1="50" x2="413" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="416" y1="50" x2="416" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="419" y1="50" x2="419" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="422" y1="50" x2="422" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="425" y1="50" x2="425" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="428" y1="50" x2="428" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="431" y1="50" x2="431" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="434" y1="50" x2="434" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<line class="flc" x1="437" y1="50" x2="437" y2="66" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="450" y="58" font-size="11" fill="#b03a2e">截止时间挤成一簇：回源、巡检、释放、传播一起到</text>
<text class="ts" x="20" y="108" font-size="12" fill="#6b675e">下：同样的键，base_ttl + random(0, jitter)</text>
<line class="axis" x1="40" y1="150" x2="620" y2="150" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="330" y1="134" x2="330" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<line class="flk" x1="368" y1="134" x2="368" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<line class="flk" x1="406" y1="134" x2="406" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<line class="flk" x1="444" y1="134" x2="444" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<line class="flk" x1="482" y1="134" x2="482" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<line class="flk" x1="520" y1="134" x2="520" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<line class="flk" x1="558" y1="134" x2="558" y2="150" stroke="#2b2a26" stroke-width="1.6"/>
<text class="ts" x="40" y="142" font-size="11" fill="#6b675e">截止时间摊开在一个区间里，四路压力被削峰</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">抖动幅度按回源系统的承受力定：把「一起到」摊成「陆续到」就够了</text>
</svg>
</figure>

监控时也不要只盯 `DBSIZE`。更有解释力的指标包括 `expired_keys`、过期循环 CPU 时间、延迟事件、内存碎片率、lazyfree 待处理对象，以及缓存命中率。看到内存未降时，先分清是尚未发现过期、正在异步释放，还是分配器没有把页面还给系统。

## 7.4 以后，字段也能有自己的期限

Redis 7.4 为 Hash 字段加入了 `HEXPIRE`、`HPEXPIRE`、`HTTL` 等命令。它们让同一个 Hash 内的字段分别到期，不必再为每个字段拆一把顶层键。

但字段级过期不是把键级 `expires` 字典简单套进 Hash。Redis 为它引入了按到期时间组织的 `ebuckets` 等结构，并设置独立的主动过期配额。键 TTL 与字段 TTL 也属于两层状态：整个键被删除时字段一起消失；只更新一个字段时，则要按字段命令的规则决定其期限是否保留。

因此，本文关于“截止时间不是逐键定时器”的核心仍成立，但不能把键级 `activeExpireCycle()` 的每个采样数字原样套到字段级过期上。版本新增了相似的命令语义，也新增了不同的数据结构与回收路径。

## 过期机制的几笔交换

准点删除要用调度成本换：为每个键维护精确定时事件，可以缩短物理残留窗口，却会放大插入、续期、取消和集中触发的成本；Redis 选择有限预算的巡检，让正常命令拥有更可控的执行机会。积极回收要用主线程时间换：提高 `active-expire-effort` 能更快清理冷键，也会把更多 CPU 预算交给过期循环，它应该按过期键比例、内存压力和尾延迟测量来调，而不是因为“10 比 1 更彻底”就直接拉满。异步释放要用暂存内存换：lazyfree 把重对象析构移出主线程，降低一次删除的阻塞，代价是对象在后台队列里继续占用一段时间，延迟更平滑，内存回落可能更晚。绝对时间便于持久化，也依赖稳定时钟：它让停机、重启、RDB 和 AOF 拥有一致的截止日期，而系统时间前跳、回拨和跨机器迁移都会直接进入过期语义。副本一致要用集中决策换：删除由主库传播，避免节点按不同本地时钟各删各的，代价是副本可能已经逻辑上拒绝读取，却仍在内部等待主库的删除命令。

最后把 TTL 放回它的位置：它只是一项有效期约束。它不做可靠的任务调度，不保证通知准点，不自动解决缓存击穿，也不保证 RSS 按秒下降。把这些责任一并压给 `EXPIRE`，得到的只是一份没有写出来的假设。

Redis 没有在截止时间那一毫秒失约。它承诺的是截止时间以后不再把键作为有效数据交给读者，查找、删除、持久化、复制、对象析构和页面回收各有自己的队列、预算与代价。过期是一条时间边界，删除是一项回收工作；把二者拆开，才看得懂冷键为什么仍占内存、通知为什么会迟到、从库为什么读不到却还没有删除，以及提高过期力度究竟把成本挪到了哪里。
