---
title: 旧的那行去哪了：undo 日志、版本链与 MVCC
description: MySQL 系列第二篇。一条 UPDATE 提交后，旧的那行去哪了？三次 UPDATE 只改动行内 5 个字节，旧值却连同事务号一起躺在 undo 表空间里。本文继续拆字节：解码 ROLL_PTR 七字节指针定位 undo 记录，把 U3→U2→U1→insert 四环版本链逐格对上 trx0rec.cc 的写入序列；再用双会话实验钉住 ReadView 的三条可见性规则（RR 一张快照用到提交、RC 每句重建、BEGIN 根本不建快照）；最后让一个长事务挂 45 秒，量出 undo 膨胀、版本链变长与 purge 冻结三笔代价。环境仍是 docker 里的 MySQL 8.4.11。
pubDate: 2026-09-11
category: mysql
tags: [MySQL, 数据库, 事务]
---

第一篇（[《一行数据落在哪里》](/posts/mysql-innodb-pages-btree/)）收尾时留了个尾巴：主键树的每片叶子上都长着两个隐藏列，DB_TRX_ID（「最后修改我的事务号」）和 DB_ROLL_PTR（「指向上一版本的回滚指针」）。这一篇顺着它们往下挖：**一条 UPDATE 提交之后，旧的那行去哪了？** 答案会依次经过 undo 表空间、版本链、ReadView 的可见性判定，最后落到 purge 的垃圾回收上，MVCC 的四个部件逐一到齐。旧版本存在哪里、怎么顺着指针挖出来，RR 和 RC 的区别为什么只是「快照什么时候建」，长事务为什么可怕，都会在路上得到答案。

实验环境不变：docker 里的 MySQL 8.4.11（`mysql84-lab` 容器）。这一篇不需要首篇那个 200 行的 .ibd 解析器，顺着指针做定点十六进制倾倒就够了，因为要走的路，指针都标好了。

## 五个字节：UPDATE 到底改了什么

建一张单行表，插一行 `READ_ME_v0`，`FLUSH TABLES ... FOR EXPORT` 把 .ibd 拷出来存档；然后跑三条各自提交的 UPDATE（v0→v1→v2→v3），再导出一次，逐字节对比：

```text
差异共 17 字节：
  页头 6 字节 + 页尾 6 字节   ← 校验和与 LSN 的例行记账，与数据无关
  行内 5 字节                 ← 真正属于这行的全部改动
```

行内那 5 个字节，一字节一个身份。对比 UPDATE 前后（`52 45 41 44 5f 4d 45 5f 76 30` 是 `READ_ME_v0` 的 ASCII）：

```text
UPDATE 前：… 80 00 00 01 | 00 00 00 01 81 13 | 82 00 00 01 1e 01 10 | …READ_ME_v0
UPDATE 后：… 80 00 00 01 | 00 00 00 01 81 1a | 02 00 00 01 ca 01 51 | …READ_ME_v3
              主键 id=1      DB_TRX_ID           DB_ROLL_PTR             val
```

主键 `80 00 00 01` 一动没动（首篇的结论在这里兑现：行的地址是主键值，不是物理位置，所以行原地更新、二级索引不用动）。变化的三个字段：

- **DB_TRX_ID**：6 字节宽，只有最低 1 字节在动，98579 变 98586。事务号是全局计数器，我的三条 UPDATE 中间还有别的会话和系统事务在领号，所以涨了 7 而不是 3。
- **DB_ROLL_PTR**：7 字节里 3 字节在动，整条指针换了指向。
- **val**：10 个字符只改了最后 1 个（`0`→`3`）。

**UPDATE 不覆盖旧值：它把旧值抄走存好，再就地写新值。** 抄去哪，就是本篇的主线。

## 旧的那行去哪了：顺着 ROLL_PTR 走

先把那 7 个字节的指针解剖了（位序按 MySQL 8.4 源码 `trx0undo.h`）：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 194" role="img" aria-label="DB_ROLL_PTR 七字节解剖：字节 0 的最高位是 insert 标志、低 7 位是回滚段号（共 128 段），字节 1 到 4 是 undo 表空间内的绝对页号，字节 5 到 6 是页内偏移；示例指针 02 00 00 01 ca 01 51 解出段 2、页 458、偏移 337" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">DB_ROLL_PTR：7 个大端字节，三段身份</text>
<rect class="bx-sick" x="40" y="44" width="90" height="44" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="85" y="62" text-anchor="middle" font-size="10" fill="#6b675e">字节 0</text>
<text class="ts" x="85" y="78" text-anchor="middle" font-size="9" fill="#6b675e">insert 位 + 段号</text>
<rect class="bx-q" x="140" y="44" width="250" height="44" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="265" y="62" text-anchor="middle" font-size="10" fill="#6b675e">字节 1–4</text>
<text class="ts" x="265" y="78" text-anchor="middle" font-size="9" fill="#6b675e">undo 页号（undo 表空间内绝对页号）</text>
<rect class="bx-q" x="400" y="44" width="140" height="44" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="470" y="62" text-anchor="middle" font-size="10" fill="#6b675e">字节 5–6</text>
<text class="ts" x="470" y="78" text-anchor="middle" font-size="9" fill="#6b675e">页内偏移</text>
<rect class="bx" x="40" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="64" y="120" text-anchor="middle" font-size="10" fill="#6b675e">02</text>
<rect class="bx" x="94" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="118" y="120" text-anchor="middle" font-size="10" fill="#6b675e">00</text>
<rect class="bx" x="148" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="172" y="120" text-anchor="middle" font-size="10" fill="#6b675e">00</text>
<rect class="bx" x="202" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="226" y="120" text-anchor="middle" font-size="10" fill="#6b675e">01</text>
<rect class="bx" x="256" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="280" y="120" text-anchor="middle" font-size="10" fill="#6b675e">ca</text>
<rect class="bx" x="310" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="334" y="120" text-anchor="middle" font-size="10" fill="#6b675e">01</text>
<rect class="bx" x="364" y="104" width="48" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="388" y="120" text-anchor="middle" font-size="10" fill="#6b675e">51</text>
<text class="tc" x="40" y="150" font-size="11" fill="#b03a2e">最高位 0 = 更新的 undo · 段 2</text>
<text class="ts" x="256" y="150" font-size="11" fill="#6b675e">页 458</text>
<text class="ts" x="330" y="150" font-size="11" fill="#6b675e">偏移 337（0x0151）</text>
<text class="ts" x="20" y="178" font-size="12" fill="#6b675e">insert 标志为 1 的就是链尾那条 INSERT_REC；128 个回滚段摊在 undo_001/002 两个文件里</text>
</svg>
</figure>

UPDATE 后那行的指针 `02 00 00 01 ca 01 51`：最高位 0（更新的 undo）、回滚段 2、页 458、偏移 337。回滚段 2 的 undo 页住在 undo_002 文件里：8.4 默认两个 undo 表空间（undo_001、undo_002），128 个回滚段摊在里面；段 1 的记录实测都在 undo_001、段 2 的都在 undo_002。

**undo 表空间也是表空间。** 把 undo_002 拷出来读页类型：页 0 = FSP_HDR（8）、页 1 = 位图（5）、页 2 = 段条目页（3），首篇拆的 .ibd 开头三页原样搬了进来，页/区/段的地基通用。第 458 页的页类型是 2（FIL_PAGE_UNDO_LOG），在 337 偏移处往前 28 字节，`READ_ME_v2` 四个字符清清楚楚躺在那。指针解码落点与旧值只差 28 字节，这是整条版本链的第一处核对。

### undo 记录解剖：与源码逐格对上

把这 50 来个字节全部列出来（真实倾倒，注释是我逐格核对后标上的）：

```text
undo_002 页 458，偏移 337 起（v2→v3 这条 UPDATE 的 undo 记录，记作 U3）：
  01 79                          ← 2B：同事务下一条 undo 记录的位置
  5c                             ← 类型：低 4 位 0x0C = 更新已存在行（0x0B = 插入）
  00                             ← 标志字节（8.4 新增）
  00                             ← undo_no（变长压缩）：0，本事务第一条
  84 3a                          ← 表 id（变长压缩）：1082 —— 与 INNODB_TABLES 查到的对上
  00                             ← 记录 info bits
  00 00 01 81 18                 ← 旧 DB_TRX_ID（压缩）：98584，写下 v2 的那个事务
  c1 00 00 01 35 04 97           ← 旧 DB_ROLL_PTR（压缩）：段 1 / undo_001 / 页 309 / 偏移 1175
  04                             ← 主键长度
  80 00 00 01                    ← 主键值：id = 1
  01                             ← 变更列数：1
  03                             ← 列位置：3 = val（id=0、DB_TRX_ID=1、DB_ROLL_PTR=2）
  0a                             ← 旧值长度：10
  52 45 41 44 5f 4d 45 5f 76 32 ← 旧值本体：READ_ME_v2
  01 51                          ← 2B 尾：本记录自身的页内偏移 337
```

字段序列与 `trx0rec.cc` 的 `trx_undo_page_report_modify` 逐格一致。两个变长格式值得多看一眼（`mach0data.ic`）：u64 写成「高 32 位压缩 + 低 32 位原样」，所以 98584 写出来是 `00` + `00 01 81 18` 共 5 字节，指针是 `c1 00 00` + `01 35 04 97` 共 7 字节，首字节 `c1`/`e0` 是长度前缀。**压缩省的是前导零，头部信息一格不少。**

最妙的两行是「旧 DB_TRX_ID」和「旧 DB_ROLL_PTR」。98584 正是写下 v2 的事务；那个 7 字节旧指针解出来是段 1、页 309、偏移 1175。去 undo_001 的第 309 页找，1175 偏移处真有一条记录，尾巴上写着自身偏移 `04 97` = 1175，旧值是 `READ_ME_v1`。这是 U2。U2 里又嵌着一个旧指针 `c1 00 00 01 19 0c 85`：段 1、页 281、偏移 3205。去翻，是 U1，旧值 `READ_ME_v0`。

### 链的尽头是插入

U1 里嵌的旧指针是 `e0` 前缀的另一种编码，解码：**insert 标志 1**、段 2、页 286、偏移 272，正是 v0 那行最初 INSERT 时写下的 ROLL_PTR 原值，一字不差。去 undo_002 第 286 页，13 个字节的小记录：

```text
undo_002 页 286，偏移 272 起（INSERT 的 undo，链的尽头）：
  0b                ← 类型 0x0B = TRX_UNDO_INSERT_REC
  00                ← undo_no：0
  84 3a             ← 表 id：1082
  04 80 00 00 01    ← 主键长度 4，主键 id = 1
  01 10             ← 尾：自身偏移 272
```

没有旧值：插入之前这行不存在，回滚它就是按主键删掉。整条链至此四环全部落地：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 332" role="img" aria-label="四环版本链：聚簇叶子页上的当前行 v3 经 ROLL_PTR 指向 undo_002 页 458 的 U3（旧值 v2、旧事务号 98584），U3 的旧指针指向 undo_001 页 309 的 U2（旧值 v1），U2 再指向 undo_001 页 281 的 U1（旧值 v0），U1 指向 undo_002 页 286 的 13 字节 INSERT_REC，链到此为止" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my2Ac2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一行数据的完整家谱：叶子上的「现在」+ undo 里的三朝旧值</text>
<rect class="bx-q" x="150" y="36" width="330" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="315" y="56" text-anchor="middle" font-size="12" fill="#2b2a26">聚簇叶子页（表空间 16 · 页 4）</text>
<text class="ts" x="315" y="76" text-anchor="middle" font-size="11" fill="#6b675e">id=1 · val=READ_ME_v3 · TRX_ID=98586</text>
<line class="flc" x1="315" y1="88" x2="315" y2="106" stroke="#b03a2e" stroke-width="1.8" marker-end="url(#my2Ac2)"/>
<text class="tc" x="325" y="102" font-size="10" fill="#b03a2e">ROLL_PTR：段2 · undo_002 · 页458 · 偏移337</text>
<rect class="bx" x="180" y="110" width="270" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="315" y="127" text-anchor="middle" font-size="11" fill="#2b2a26">U3 · 旧值 READ_ME_v2</text>
<text class="ts" x="315" y="143" text-anchor="middle" font-size="10" fill="#6b675e">旧 TRX_ID=98584</text>
<line class="flc" x1="315" y1="150" x2="315" y2="162" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#my2Ac2)"/>
<text class="ts" x="460" y="160" font-size="10" fill="#6b675e">段1 · undo_001 · 页309 · 偏移1175</text>
<rect class="bx" x="180" y="166" width="270" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="315" y="183" text-anchor="middle" font-size="11" fill="#2b2a26">U2 · 旧值 READ_ME_v1</text>
<text class="ts" x="315" y="199" text-anchor="middle" font-size="10" fill="#6b675e">旧 TRX_ID=98580</text>
<line class="flc" x1="315" y1="206" x2="315" y2="218" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#my2Ac2)"/>
<text class="ts" x="460" y="216" font-size="10" fill="#6b675e">段1 · undo_001 · 页281 · 偏移3205</text>
<rect class="bx" x="180" y="222" width="270" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="315" y="239" text-anchor="middle" font-size="11" fill="#2b2a26">U1 · 旧值 READ_ME_v0</text>
<text class="ts" x="315" y="255" text-anchor="middle" font-size="10" fill="#6b675e">旧 TRX_ID=98579</text>
<line class="flc" x1="315" y1="262" x2="315" y2="274" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#my2Ac2)"/>
<text class="ts" x="460" y="272" font-size="10" fill="#6b675e">段2 · undo_002 · 页286 · 偏移272</text>
<rect class="bx-gone" x="180" y="278" width="270" height="36" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="315" y="293" text-anchor="middle" font-size="10" fill="#6b675e">INSERT_REC · 13 字节 · insert 标志 = 1</text>
<text class="ts" x="315" y="308" text-anchor="middle" font-size="10" fill="#6b675e">没有旧值：再往前，这行不存在</text>
<text class="ts" x="20" y="128" font-size="11" fill="#6b675e">undo</text>
<text class="ts" x="20" y="144" font-size="11" fill="#6b675e">表空间</text>
<text class="ts" x="20" y="330" font-size="12" fill="#6b675e">回滚就是沿链逆向抄回去：实测 ROLLBACK 后行与改前逐字节相同，连 TRX_ID 都还原</text>
</svg>
</figure>

**版本链是倒着走的时间：叶子上的行是「现在」，ROLL_PTR 一环环往回。** 每环自带三样东西（旧值、旧 TRX_ID、指向更旧的指针），所以链不仅能「看」，还能「还原」。

（这批实验里的小彩蛋：变更列位置写的是 `03`。主键树的字段编号里 id=0、DB_TRX_ID=1、DB_ROLL_PTR=2、val=3。首篇 `N_FIELDS=6` 埋的「隐藏列占座」在这里兑了现：连 undo 记录都得给两个隐藏列让位。）

### 回滚：沿链逆向抄回去

ROLLBACK 不做「删掉新值」这种事，它照着 undo 记录把旧值抄回行里，**连同隐藏列一起**。实测：开事务把 v8 改成 v9 再 ROLLBACK，导出对比，回滚后的行与改之前**逐字节相同**：val 回到 v8、TRX_ID 回到 98602、ROLL_PTR 仍指原处。

**UPDATE 是「先抄旧值进 undo，再改行」；ROLLBACK 是「照着 undo 把行抄回去」。提交和回滚都不产生第二次就地改写，要么留链，要么还原。** 崩溃恢复同理：未提交事务的 undo 在重启时被重放成回滚，这是第四篇（日志与崩溃恢复）的入口。

## 谁能看见哪个版本：ReadView 的三条规则

链挖出来了，现在换问题：一个刚开始的读事务，面对同一条链上 v0 到 v3 四个版本，看哪个？MVCC 的答案是 ReadView，快照建立时刻拍下的一份名单：

```text
ReadView（快照建立时刻拍下的名单）
  m_ids        当时还活跃（未提交）的事务号列表
  min_trx_id   m_ids 里最小的号
  max_trx_id   下一个将发放的事务号（低水位）
```

对链上任意版本的 DB_TRX_ID，三条规则：

1. **小于 min_trx_id**：快照之前就已提交 → 可见；
2. **不小于 max_trx_id**：快照之后才开的事务 → 不可见；
3. **夹在中间**：查名单。在 m_ids 里（当时还活着）→ 不可见；不在（已提交）→ 可见。

规则说不可见，就顺着 ROLL_PTR 走旧一环再判；一路走到链尾还是不可见，这行对快照不存在。自己改的行当然看得见。**规则就这么多，隔离级别的全部差别，都藏在「快照什么时候建」里。**

三条规则就是一根数轴：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 214" role="img" aria-label="ReadView 可见性数轴：横轴是版本的 DB_TRX_ID，小于 min_trx_id 的在快照前已提交可见；不小于 max_trx_id 的是快照后才开的事务不可见；夹在中间的查 m_ids 名单，在名单里（当时未提交）不可见，不在（已提交）可见" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my2As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">拿链上任意版本的 DB_TRX_ID，在这根轴上落点</text>
<rect class="bx-q" x="60" y="80" width="180" height="16" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-sick" x="240" y="80" width="190" height="16" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx" x="430" y="80" width="170" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<line class="axis" x1="40" y1="88" x2="620" y2="88" stroke="#6b675e" stroke-width="1.2" marker-end="url(#my2As3)"/>
<line class="flc" x1="240" y1="70" x2="240" y2="106" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="240" y="62" text-anchor="middle" font-size="11" fill="#b03a2e">min_trx_id</text>
<line class="flc" x1="430" y1="70" x2="430" y2="106" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="430" y="62" text-anchor="middle" font-size="11" fill="#b03a2e">max_trx_id</text>
<text class="ts" x="150" y="126" text-anchor="middle" font-size="11" fill="#6b675e">快照前已提交</text>
<text class="tc" x="150" y="142" text-anchor="middle" font-size="11" fill="#b03a2e">可见 ✓</text>
<text class="ts" x="335" y="126" text-anchor="middle" font-size="11" fill="#6b675e">查 m_ids 名单</text>
<text class="ts" x="335" y="142" text-anchor="middle" font-size="11" fill="#6b675e">在名单（当时未提交）→ 不可见</text>
<text class="ts" x="335" y="158" text-anchor="middle" font-size="11" fill="#6b675e">不在（已提交）→ 可见</text>
<text class="ts" x="515" y="126" text-anchor="middle" font-size="11" fill="#6b675e">快照后才开的事务</text>
<text class="tc" x="515" y="142" text-anchor="middle" font-size="11" fill="#b03a2e">不可见 ✕</text>
<text class="ts" x="20" y="188" font-size="12" fill="#6b675e">判不可见就顺 ROLL_PTR 走旧一环再判；走到链尾仍不可见，这行对该快照不存在</text>
<text class="ts" x="20" y="206" font-size="12" fill="#6b675e">例外：自己事务改的行永远看得见</text>
</svg>
</figure>

双会话实验，A 开事务读两次、中间 B 改了再提交：

| # | 场景 | A 读到的 | B 的动作 | A 再读 |
| --- | --- | --- | --- | --- |
| 1 | REPEATABLE-READ | v3 | 改成 v4，提交 | **v3** |
| 2 | READ-COMMITTED | v4 | 改成 v5，提交 | **v5** |
| 3a | RR + BEGIN 后干等 6 秒才读 | — | 改成 v6，提交 | **v6** |
| 3b | RR + WITH CONSISTENT SNAPSHOT | — | 改成 v7，提交 | **v6** |

**RR：一张快照用到提交。** 第一条一致性读时建 ReadView，此后整复用。B 提交得再快，A 的世界停在快照那一刻。

**RC：每条语句换一张快照。** 同样的姿势，A 第二次读之前重建了 ReadView，于是看见 v5。「读已提交」的语义在 ReadView 层面就是这一行差别。

**BEGIN 的陷阱：快照根本不在 BEGIN 时建。** 3a 是最容易反直觉的一格：A 先 BEGIN、干等 6 秒、才发第一条 SELECT，看到的居然是 B 刚提交的 v6。因为 RR 的 ReadView 挂在**第一条一致性读**上，BEGIN 只开事务不发快照。想要「BEGIN 那一刻」的快照，得用 3b 的 `START TRANSACTION WITH CONSISTENT SNAPSHOT`：它显式地立刻建快照，所以 B 之后改的 v7 它看不见。

**隔离级别 RR 与 RC 的全部区别，浓缩成一句话：ReadView 建几次、什么时候建。** 面试题里那些「不可重复读」「幻读」的名词，落地无非是这张表里的四行结果。

三条时间线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="快照时机三条时间线：RR 在第一条一致性读时建 ReadView 并一直复用到提交，B 中途提交 v4 也看不见；RC 每条语句前重建 ReadView，第二次读看见 v5；RR 下先 BEGIN 干等六秒再读，快照建在第一条 SELECT 上，看见的是 B 刚提交的 v6" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">ReadView 建几次、什么时候建：三条时间线</text>
<text class="t" x="20" y="46" font-size="12" fill="#2b2a26">① RR</text>
<rect class="bx-sick" x="200" y="54" width="340" height="12" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<line class="axis" x1="40" y1="60" x2="620" y2="60" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="80" y1="52" x2="80" y2="68" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="80" y="44" text-anchor="middle" font-size="10" fill="#6b675e">BEGIN</text>
<line class="flc" x1="200" y1="50" x2="200" y2="70" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="200" y="88" text-anchor="middle" font-size="10" fill="#b03a2e">SELECT① · 建快照</text>
<line class="flk" x1="340" y1="52" x2="340" y2="68" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="340" y="44" text-anchor="middle" font-size="10" fill="#6b675e">B：改 v4 提交</text>
<line class="flk" x1="480" y1="52" x2="480" y2="68" stroke="#2b2a26" stroke-width="2"/>
<text class="tc" x="480" y="88" text-anchor="middle" font-size="10" fill="#b03a2e">SELECT② 仍读 v3</text>
<text class="ts" x="560" y="44" text-anchor="middle" font-size="10" fill="#6b675e">一张快照用到提交</text>
<text class="t" x="20" y="126" font-size="12" fill="#2b2a26">② RC</text>
<line class="axis" x1="40" y1="140" x2="620" y2="140" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="80" y1="132" x2="80" y2="148" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="80" y="124" text-anchor="middle" font-size="10" fill="#6b675e">BEGIN</text>
<line class="flc" x1="200" y1="130" x2="200" y2="150" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="200" y="168" text-anchor="middle" font-size="10" fill="#b03a2e">SELECT① · 建快照</text>
<line class="flk" x1="340" y1="132" x2="340" y2="148" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="340" y="124" text-anchor="middle" font-size="10" fill="#6b675e">B：改 v5 提交</text>
<line class="flc" x1="480" y1="130" x2="480" y2="150" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="480" y="168" text-anchor="middle" font-size="10" fill="#b03a2e">SELECT② 重建快照 · 读 v5</text>
<text class="t" x="20" y="206" font-size="12" fill="#2b2a26">③ RR + BEGIN 干等 6s</text>
<line class="axis" x1="40" y1="220" x2="620" y2="220" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="80" y1="212" x2="80" y2="228" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="80" y="204" text-anchor="middle" font-size="10" fill="#6b675e">BEGIN</text>
<line class="flk" x1="300" y1="212" x2="300" y2="228" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="300" y="204" text-anchor="middle" font-size="10" fill="#6b675e">B：改 v6 提交</text>
<line class="flc" x1="460" y1="210" x2="460" y2="230" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="460" y="248" text-anchor="middle" font-size="10" fill="#b03a2e">SELECT① 此刻才建快照 · 读到 v6</text>
<text class="ts" x="20" y="262" font-size="12" fill="#6b675e">想冻结在 BEGIN 那一刻：START TRANSACTION WITH CONSISTENT SNAPSHOT</text>
</svg>
</figure>

## 快照读与当前读：同一事务，两个答案

MVCC 只管「一致性读」，也就是普通 SELECT。还有一类读不走快照：`SELECT ... FOR UPDATE`、`LOCK IN SHARE MODE`、以及 UPDATE / DELETE 里定位目标行的那次读。它们是**当前读**：读最新已提交版本，并加锁。

实测，A 先在 RR 事务里读了一次（快照 v7），随后 A `SELECT ... FOR UPDATE` 与 B 的 `UPDATE` 几乎同时发出。`performance_schema.data_locks` 抓到的现场：

```text
事务 98602   X,REC_NOT_GAP   GRANTED   LOCK_DATA = 1   ← B 的 UPDATE 先拿到主键 1
事务 98603   X,REC_NOT_GAP   WAITING   LOCK_DATA = 1   ← A 的 FOR UPDATE 在等
```

两把锁钉在同一行（LOCK_DATA = 1 是主键值），一把已授予一把在等，第三篇（锁体系）的整幅地图就在这张表里。等 B 提交后，A 的 FOR UPDATE 醒来，返回的是：

```text
A 的快照读：        READ_ME_v7
A 的 FOR UPDATE：   READ_ME_v8   ← B 已提交的最新版
```

**同一个事务、同一个瞬间、两个答案。** 这没什么可惊讶的，是分工：快照读靠版本链读历史，当前读绕过版本链读现在。也正因如此，MVCC 管不了「当前读的幻读」：`FOR UPDATE` 锁住的这行没变，但范围内的空隙里可能被别的事务插进新行，这要靠 next-key lock 把间隙也锁上。锁的类型学、等待与死锁，全是下一篇的主角，这篇只到这里。

两种读的分界：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 168" role="img" aria-label="快照读与当前读对照：普通 SELECT 是快照读，走版本链按 ReadView 判定，A 读到 v7；FOR UPDATE 和 DML 是当前读，绕过版本链读最新已提交并加锁，同一瞬间读到 B 已提交的 v8" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一事务、同一瞬间、两个答案</text>
<rect class="bx-q" x="30" y="40" width="280" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">快照读 · 普通 SELECT</text>
<text class="ts" x="170" y="82" text-anchor="middle" font-size="11" fill="#6b675e">走版本链，按 ReadView 判可见性</text>
<text class="tc" x="170" y="102" text-anchor="middle" font-size="11" fill="#b03a2e">A 读到：READ_ME_v7</text>
<rect class="bx-sick" x="350" y="40" width="280" height="76" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="490" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">当前读 · FOR UPDATE / DML</text>
<text class="ts" x="490" y="82" text-anchor="middle" font-size="11" fill="#6b675e">绕过版本链：最新已提交 + 加锁</text>
<text class="tc" x="490" y="102" text-anchor="middle" font-size="11" fill="#b03a2e">A 读到：READ_ME_v8</text>
<text class="ts" x="20" y="142" font-size="12" fill="#6b675e">MVCC 只管左边这一半；当前读的世界要靠锁，data_locks 里两把 X 锁钉在同一行</text>
<text class="ts" x="20" y="160" font-size="12" fill="#6b675e">一把 GRANTED（B 的 UPDATE 先到）、一把 WAITING（A 的 FOR UPDATE 在等）</text>
</svg>
</figure>

## purge：版本链的垃圾回收

旧版本不能永远留着，但也不能马上删，可能还有两个客户要用：**未提交的事务**（回滚要照链抄）和**未关闭的快照**（ReadView 还要判可见性）。这两个约束收紧成同一个数：**最老的活跃 ReadView**。比它更旧的版本，回滚的事务早已提交、快照早已关闭，谁也用不上了。purge 线程自己持有一张 ReadView，推进到最老活跃快照的位置，沿着 history list（挂在回滚段上的、已提交事务的 update undo 链表）逐事务清理。

实验：A 开一个事务读一下然后挂着不动 45 秒；B 对一张 5000 行、每行 200 字节的表连打 60 个整表 UPDATE 事务（每事务把 5000 个旧值抄进 undo，共 30 万个行版本）。每 5 秒采一次样：

| 时刻 | history list | read views | undo 表空间合计 |
| --- | --- | --- | --- |
| 基线 | 2 | 0 | 256MiB |
| B 打完 60 个事务，A 仍挂着 | 63 | 1 | 304MiB |
| A 提交后第 10 秒 | 63 | 0 | 304MiB |
| A 提交后约 12 秒 | **0** | 0 | **304MiB** |

（量具：`SHOW ENGINE INNODB STATUS` 里的 History list length 与 read views open，`INNODB_TABLESPACES` 的 ALLOCATED_SIZE。）

**history list 数的是事务，不是行。** 60 个事务制造了 30 万个行版本，history 只从 2 涨到 63：一个提交的写事务在链上是一个节点，节点里装多少行版本它不管。所以看到 history 巨大，只有两种病因：写入事务多到清不过来，或者有老快照压着清不动。

**A 挂着的 45 秒里，purge 全程冻结。** history 一动不动、`read views = 1` 明晃晃挂在监视输出里；A 一提交，read views 归零，约 12 秒后 history 也清空（purge 协调线程是懒的，没有持续负载时会打瞌睡，本实例 `innodb_purge_threads = 1`）。

**undo 只涨不缩。** 清完之后 304MiB 一字节不还：purge 把页还回 undo 表空间内部的空闲链，文件不缩小；只有超过 `innodb_max_undo_log_size`（默认 1GiB）才触发独立表空间的 truncate 回收。所以 undo 的尺寸曲线是「涨台阶、走平路」，永远不下来。

长事务的代价至此可以数清，三笔：**undo 膨胀**，45 秒 +48MiB，生产负载按比例放大；**版本链变长**，实验表每行链深 60，老快照的每次读都要顺链多走 60 环；**purge 全局停摆**，你一个人的老快照压住全实例的 history list，所有人提交的 undo 都清不掉。「不要在生产开长事务」不是运维玄学，是这三个数。

这场实验的曲线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 252" role="img" aria-label="purge 冻结实验曲线：基线 history list 为 2；B 连打 60 个整表 UPDATE 事务后涨到 63；A 的老快照挂着 45 秒期间 history 纹丝不动、purge 冻结；A 提交后约 12 秒 history 归零；undo 表空间从 256MiB 涨到 304MiB 后一字节不还" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">A 挂 45 秒、B 打 60 个事务：history list 的形状</text>
<text class="ts" x="20" y="42" font-size="11" fill="#6b675e">history list（事务数）</text>
<rect class="msg" x="250" y="48" width="180" height="152" fill="#a29d90" opacity="0.18"/>
<line class="grid" x1="70" y1="130" x2="610" y2="130" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="60" x2="610" y2="60" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="200" x2="70" y2="50" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="200" x2="620" y2="200" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="134" text-anchor="end" font-size="10" fill="#6b675e">30</text>
<text class="ts" x="62" y="64" text-anchor="end" font-size="10" fill="#6b675e">63</text>
<polyline class="curve-k" points="70,195 150,195 250,60 430,60 470,60 500,196 610,196" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="250" cy="60" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="430" cy="60" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="500" cy="196" r="3" fill="#b03a2e"/>
<text class="tc" x="256" y="90" font-size="11" fill="#b03a2e">A 的老快照挂着：</text>
<text class="tc" x="256" y="106" font-size="11" fill="#b03a2e">45 秒里 purge 全程冻结，</text>
<text class="tc" x="256" y="122" font-size="11" fill="#b03a2e">history 一动不动</text>
<line class="flc" x1="430" y1="52" x2="430" y2="206" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3"/>
<text class="ts" x="436" y="160" font-size="10" fill="#6b675e">A 提交</text>
<text class="ts" x="500" y="176" text-anchor="middle" font-size="10" fill="#6b675e">约 12 秒后归零</text>
<text class="ts" x="100" y="218" text-anchor="middle" font-size="10" fill="#6b675e">基线 2</text>
<text class="ts" x="200" y="218" text-anchor="middle" font-size="10" fill="#6b675e">B 打完 60 事务 → 63</text>
<text class="ts" x="560" y="218" text-anchor="middle" font-size="10" fill="#6b675e">清空</text>
<text class="ts" x="20" y="240" font-size="12" fill="#6b675e">undo 表空间 256 → 304MiB 后一字节不还：页还进内部空闲链，文件只涨不缩</text>
</svg>
</figure>

## 版本链走完之后

旧版本住在你从没打开过的文件里：undo_001/undo_002 是表空间，与数据 .ibd 同构（前 3 页 FSP_HDR、位图、段条目）；旧值按「一事务一条 undo 记录」躺在里面，7 字节的 ROLL_PTR 就能指到它，段号、页号、偏移，一格不少。

版本链是倒着走的时间：叶子上的行是现在，ROLL_PTR 一环环往回，U3→U2→U1→insert。每环自带旧值、旧 TRX_ID、指向更旧的指针；回滚就是照链抄回去，实测连 TRX_ID 都一起还原，逐字节回到从前。

可见性只是三条规则：小于 min_trx_id 可见、不小于 max_trx_id 不可见、中间查名单。RR 与 RC 的区别只是快照建一次还是每句重建，而 BEGIN 根本不建快照，快照在第一条一致性读时才落地。

快照读不是读的全部：FOR UPDATE 与 DML 走当前读，最新已提交、加锁、绕过版本链。同一事务里快照说 v7、当前读说 v8；MVCC 管不了的那一半，要靠下一篇的锁。

purge 是全局水位线：比最老 ReadView 更旧的版本才是垃圾；一个挂着的快照压住整条 history list，undo 膨胀、链变长、清停摆，三笔成本都从这一张快照记起。提交之后 12 秒归零，304MiB 不还，是垃圾回收的诚实价格。

下一篇拆锁体系：记录锁、间隙锁、next-key lock，从「FOR UPDATE 到底等了谁」接着讲。
