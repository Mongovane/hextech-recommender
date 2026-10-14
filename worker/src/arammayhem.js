import { ccFetch } from './builds.js';
import { getItemDict } from './items.js';
import { fetchArammetaDetail, arammetaBuilds } from './arammeta.js';
// 第 4 数据源：arammayhem.com（668+ 编辑精选英雄+海克斯组合、机制联动口诀、陷阱避坑与出装加点兜底）
// 数据遵循 CC BY 4.0（Data: arammayhem.com）
const AM_BUILTIN = {"Volibear": [{"aug": "物法皆修", "pair": "物法皆修", "augs": ["物法皆修"], "tier": "S", "tag": "", "isTrap": false, "desc": "q和w都算作攻击特效，可以叠物法皆修，被动可以把法强转化为攻速，叠的飞快，越打越强。锻体：物穿>移速>抗性>生命值"}, {"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S", "tag": "", "isTrap": false, "desc": "秘术冲拳可以大幅减少技能cd，配合迅刃，直接开启无限火力"}, {"aug": "古式佳酿", "pair": "古式佳酿", "augs": ["古式佳酿"], "tier": "S", "tag": "", "isTrap": false, "desc": "秘术加迅刃无限qwer；爽！"}, {"aug": "灵巧", "pair": "灵巧", "augs": ["灵巧"], "tier": "A", "tag": "", "isTrap": false, "desc": "雪球进去秒人"}], "MonkeyKing": [{"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "强力黑科技", "isTrap": false, "desc": "华尔兹大招流猴子，控一片！"}, {"aug": "邦！", "pair": "邦！", "augs": ["邦！"], "tier": "S+", "tag": "专属", "isTrap": false, "desc": "Q粉碎打击附带范围溅射伤害，主Q配合三相/青龙刀团战AOE拉满"}, {"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "普攻与Q大幅缩减全技能冷却，配合青龙刀可高频隐身连续击飞"}], "Jax": [{"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S+", "tag": "", "isTrap": false, "desc": "秘术冲拳配合黄昏与黎明可以快速减少技能冷却，全程开启E技能实现无限格挡"}, {"aug": "升级：耀光", "pair": "升级：耀光", "augs": ["升级：耀光"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "有升级耀光记得出黄昏与黎明，可双倍触发升级耀光伤害及回血，其他英雄同理"}, {"aug": "砍伤", "pair": "砍伤 + 升级：耀光", "augs": ["砍伤", "升级：耀光"], "tier": "S", "tag": "", "isTrap": false, "desc": "又肉伤害又高，配合黄昏与黎明双倍触发耀光伤害与回血"}, {"aug": "吞噬灵魂", "pair": "吞噬灵魂 + 无限循环往复", "augs": ["吞噬灵魂", "无限循环往复"], "tier": "S", "tag": "", "isTrap": false, "desc": "在叠角龙加持下成长型海克斯收益翻倍，配合吞噬灵魂加生命上限、无限循环往复加急速打造数值怪"}, {"aug": "物理转魔法", "pair": "升级：耀光 + 物理转魔法", "augs": ["升级：耀光", "物理转魔法"], "tier": "S", "tag": "", "isTrap": false, "desc": "利用黄昏与黎明配合贾克斯E和R的高额法强加成，跳斩进场开启大招瞬间爆发清场"}], "Varus": [{"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "W挂三层被动造成最大生命值魔伤，虚幻武器+黄昏放技能可挂两层被动；R后开W满蓄力Q引爆三层秒前排"}, {"aug": "物理转魔法", "pair": "物理转魔法 + 物法皆修", "augs": ["物理转魔法", "物法皆修", "神射法师"], "tier": "S", "tag": "", "isTrap": false, "desc": "物法皆修+物理转魔法W法强加成极高可秒杀大肉，出飓风叠层极快，搭配神射法师与穿针引线双穿收益拉满"}, {"aug": "连拨击锤", "pair": "连拨击锤", "augs": ["连拨击锤"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "单发平A触发5次特效直接叠满W三环，走特效攻速流伤害爆炸"}], "Darius": [{"aug": "回归基本功", "pair": "回归基本功", "augs": ["回归基本功"], "tier": "S", "tag": "", "isTrap": false, "desc": "利用回归基本功提供的高额攻击力加成，直接做穿甲暴击装，一个W秒脆皮"}, {"aug": "珠光护手", "pair": "珠光护手", "augs": ["珠光护手"], "tier": "S", "tag": "", "isTrap": false, "desc": "技能暴击流诺手，W与外圈Q爆发极高（注：诺手的虚幻武器和利刃华尔兹不能叠血怒）"}, {"aug": "台风", "pair": "台风", "augs": ["台风"], "tier": "B", "tag": "黑科技", "isTrap": false, "desc": "台风分裂箭可以给周围敌方英雄快速叠加出血被动"}, {"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "无法叠加出血效果，切勿拿"}, {"aug": "连拨击锤", "pair": "连拨击锤", "augs": ["连拨击锤"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "无法叠加出血效果，切勿拿"}], "Sylas": [{"aug": "神射法师", "pair": "神射法师", "augs": ["神射法师"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "在被动范围内的单位越多，主目标受到的额外伤害越高"}, {"aug": "全凭身法", "pair": "全凭身法", "augs": ["全凭身法"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "WE可吃加成，若能偷到一个位移类大招再选符文，R后续也可吃到加成"}, {"aug": "终极唤醒", "pair": "终极唤醒", "augs": ["终极唤醒"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "R偷可触发，再施放偷来的R可再次触发"}, {"aug": "纯粹主义者- 术师", "pair": "纯粹主义者- 术师", "augs": ["纯粹主义者- 术师", "纯粹主义者 - 术师"], "tier": "S", "tag": "", "isTrap": false, "desc": "施放技能后的强化平A附带125%攻速转化为81点技能急速，控制平A节奏可常驻200+急速"}, {"aug": "注魔", "pair": "注魔", "augs": ["注魔"], "tier": "S", "tag": "", "isTrap": false, "desc": "塞拉斯被动平A是范围伤害，可以多次触发注魔"}], "Sett": [{"aug": "回归基本功", "pair": "回归基本功", "augs": ["回归基本功"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "钢局必拿，W豪意一拳增幅恐怖"}, {"aug": "小丑学院", "pair": "小丑学院", "augs": ["小丑学院"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "隐身进场蓄满W一拳一个脆皮"}, {"aug": "珠光护手", "pair": "珠光护手", "augs": ["珠光护手"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "穿甲大招流与W真伤暴击必备，对面肉坦就是你最强的武器"}, {"aug": "歌利亚巨人", "pair": "歌利亚巨人 + 科学狂人", "augs": ["歌利亚巨人", "科学狂人"], "tier": "S", "tag": "", "isTrap": false, "desc": "不断堆高生命值和攻击力放大W豪意上限（35%生命值），满豪意EW必中一拳秒人"}, {"aug": "飞身踢", "pair": "飞身踢 + 坦克引擎", "augs": ["飞身踢", "坦克引擎"], "tier": "S", "tag": "", "isTrap": false, "desc": "飞身踢YYDS，远距离突进开团配合心之钢与霸王血铠"}, {"aug": "量子计算", "pair": "量子计算", "augs": ["量子计算"], "tier": "A", "tag": "黑科技Bug", "isTrap": false, "desc": "大招期间触发量子计算可使该目标吃到4倍内圈伤害"}], "Ezreal": [{"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "Q可触发两次攻击特效，配合耀光/魔宗爆发翻倍"}, {"aug": "注魔", "pair": "注魔 + 珠光护手", "augs": ["注魔", "珠光护手"], "tier": "S", "tag": "", "isTrap": false, "desc": "吸蓝刀+魔宗+Q本身攻击特效可同时触发三层注魔伤害，配合暴击装一发Q附加数百魔伤"}, {"aug": "亮出你的剑", "pair": "亮出你的剑 + 双刀流", "augs": ["亮出你的剑", "双刀流", "有始有终"], "tier": "S", "tag": "", "isTrap": false, "desc": "手感最好流，开局就有高额伤害，守护者之刃+女神泪出门"}, {"aug": "纯粹主义者- 术师", "pair": "纯粹主义者- 术师 + 秘术冲拳", "augs": ["纯粹主义者- 术师", "秘术冲拳"], "tier": "S", "tag": "", "isTrap": false, "desc": "被动叠满50%攻速转常驻200+急速，加Q命中减CD实现后期Q零冷却、10秒一个全屏R"}], "Ryze": [{"aug": "物理转魔法", "pair": "物理转魔法 + 由心及物", "augs": ["物理转魔法", "由心及物"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "瑞天帝登神长阶：被动法强与法力互相加成，配合由心及物+物转法将法力/生命/攻击循环转化实现数值无限飞升"}, {"aug": "由心及物", "pair": "由心及物 + 溢流", "augs": ["由心及物", "溢流"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "登神长阶核心：高额蓝量同时转生命与法强，100+急速配合溢流伤害爆炸无限Q"}, {"aug": "歌利亚巨人", "pair": "歌利亚巨人 + 科学狂人", "augs": ["歌利亚巨人", "科学狂人", "坦克引擎"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "登神长阶（体型与属性巨幅放大），配合由心及物又肉伤害又夸张"}, {"aug": "终极刷新", "pair": "终极刷新", "augs": ["终极刷新"], "tier": "C", "tag": "娱乐", "isTrap": false, "desc": "连放两个R能够实现瞬间传送"}], "Graves": [{"aug": "回归基本功", "pair": "回归基本功", "augs": ["回归基本功"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "男枪普通攻击可吃到回归基本功巨额加成，平A伤害爆炸"}, {"aug": "亮出你的剑", "pair": "亮出你的剑 + 更万用的瞄准镜", "augs": ["亮出你的剑", "更万用的瞄准镜"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "拿到就是爽局，配合狂妄叠攻击力后期两枪秒脆皮"}, {"aug": "一板一眼", "pair": "一板一眼 + 唯快不破", "augs": ["一板一眼", "唯快不破"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "攻速转高额攻击力，男枪连续攻击同一目标每次普攻都带盈能特效，配火炮拉满距离"}, {"aug": "牙仙子", "pair": "牙仙子 + 珠光护手", "augs": ["牙仙子", "珠光护手"], "tier": "A", "tag": "强力", "isTrap": false, "desc": "爆发触发牙仙子拾取牙齿永久叠穿甲与法穿，再让珠光护手与暴击飞弹联动"}, {"aug": "神射法师", "pair": "神射法师 + 物理转魔法", "augs": ["神射法师", "物理转魔法"], "tier": "S", "tag": "黑科技", "isTrap": false, "desc": "男枪普攻4枚弹丸每颗独立触发神射法师，1发平A附加300%法强物理爆发（仅第一个拿神射法师时玩）"}], "TwistedFate": [{"aug": "珠光护手", "pair": "珠光护手 + 巨人杀手", "augs": ["珠光护手", "巨人杀手"], "tier": "S", "tag": "", "isTrap": false, "desc": "高额法强配合技能暴击，远处Q消耗、贴脸秒切黄牌定人爆发"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "W选牌后无法被Q触发，属于陷阱切勿拿"}], "Sivir": [{"aug": "老练狙神", "pair": "老练狙神", "augs": ["老练狙神"], "tier": "A", "tag": "强力", "isTrap": false, "desc": "W弹射可以远距离触发老练狙神缩减冷却"}, {"aug": "侵蚀", "pair": "侵蚀 + 火上浇油", "augs": ["侵蚀", "火上浇油"], "tier": "A", "tag": "", "isTrap": false, "desc": "利用QW弹射快速大范围叠满侵蚀减抗，R提供群体移速"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "只有Q能触发，W弹射不触发攻击特效，切勿拿"}, {"aug": "易损", "pair": "易损", "augs": ["易损"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "W弹射不触发易损暴击，切勿拿"}], "Katarina": [{"aug": "一板一眼", "pair": "一板一眼 + 蛋白粉奶昔", "augs": ["一板一眼", "蛋白粉奶昔"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "锁攻速不影响R的攻速收益！还能白吃攻速转化的巨额攻击力加成"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "R正常只吃25/30/35%特效伤害，拿到虚幻武器后直接翻倍变50/60/70%"}, {"aug": "虚空裂隙", "pair": "虚空裂隙", "augs": ["虚空裂隙"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "大招每把匕首都能触发虚空裂隙（最高70+次）并附带99%减速，对手跑都跑不掉"}, {"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S", "tag": "", "isTrap": false, "desc": "大招附带攻击特效触发秘术冲拳，造成伤害同时大幅刷新自身冷却实现无限旋转"}, {"aug": "扳机炼狱", "pair": "扳机炼狱", "augs": ["扳机炼狱"], "tier": "S", "tag": "", "isTrap": false, "desc": "R同时命中多人直接叠满S级评分，触发双重旋转范围伤害"}, {"aug": "闪电打击", "pair": "闪电打击", "augs": ["闪电打击"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "闪电打击提供的攻速不影响R大招伤害，切勿拿"}], "Samira": [{"aug": "亮出你的剑", "pair": "亮出你的剑", "augs": ["亮出你的剑"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "强度爆炸完全不缺伤害，早出饮血剑和死亡之舞增加进场容错"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "技能附带普攻判定，QEA瞬间打满S级被动直接开大"}, {"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "开启大招期间可同时施放利刃华尔兹，不可选取状态下打满全额AOE"}, {"aug": "小丑学院", "pair": "小丑学院", "augs": ["小丑学院"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "开大后隐身进场安全打满全额大招伤害"}, {"aug": "易损", "pair": "易损", "augs": ["易损"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "大招R天生可暴击但不触发易损增伤，属于陷阱切勿拿"}], "Teemo": [{"aug": "尤里卡", "pair": "尤里卡", "augs": ["尤里卡"], "tier": "S", "tag": "", "isTrap": false, "desc": "法强转化为高额技能急速，全图无限种蘑菇"}, {"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S", "tag": "", "isTrap": false, "desc": "配合卢安娜的飓风，一发平A减少3.75秒全技能冷却，实现无限Q致盲"}, {"aug": "神射法师", "pair": "神射法师", "augs": ["神射法师"], "tier": "A", "tag": "强力", "isTrap": false, "desc": "AP提莫点神射法师性价比极高，普攻与持续毒伤消耗更扎实"}], "Aatrox": [{"aug": "珠光护手", "pair": "珠光护手", "augs": ["珠光护手"], "tier": "S", "tag": "", "isTrap": false, "desc": "珠光护手血魔流，三段Q暴击刀刀烈火又能回血，能抗又能打"}, {"aug": "蛋白粉奶昔", "pair": "蛋白粉奶昔", "augs": ["蛋白粉奶昔"], "tier": "S", "tag": "", "isTrap": false, "desc": "半肉双抗配合蛋白粉奶昔与振奋盔甲使回血护盾翻3.5倍，焚天+死舞收益极其夸张"}, {"aug": "扇巴掌", "pair": "扇巴掌", "augs": ["扇巴掌"], "tier": "A", "tag": "强力", "isTrap": false, "desc": "三段Q外圈击飞均可高效叠层"}], "Malphite": [{"aug": "终极刷新", "pair": "终极刷新", "augs": ["终极刷新"], "tier": "S", "tag": "强力", "isTrap": false, "desc": "双核弹大招连撞两次，后排无人能活"}, {"aug": "尤里卡", "pair": "尤里卡", "augs": ["尤里卡"], "tier": "S", "tag": "", "isTrap": false, "desc": "法强转高额技能急速大幅缩减大招CD，配合终极刷新效果更佳"}], "LeeSin": [{"aug": "砸开那颗蛋", "pair": "砸开那颗蛋", "augs": ["砸开那颗蛋"], "tier": "S", "tag": "", "isTrap": false, "desc": "砸开那颗蛋W贴膜护盾流，保护与生存拉满"}], "Mel": [{"aug": "老练狙神", "pair": "老练狙神", "augs": ["老练狙神"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "QW远距离命中无限返还CD，尤其是W可无限反弹控制"}, {"aug": "易损", "pair": "易损", "augs": ["易损"], "tier": "S", "tag": "", "isTrap": false, "desc": "Q的多段伤害全部可以吃到易损法爆增伤，爆发极其恐怖"}, {"aug": "虚空裂隙", "pair": "虚空裂隙", "augs": ["虚空裂隙"], "tier": "S", "tag": "", "isTrap": false, "desc": "高法穿AP绝配，推推棒与多段技能可高频触发裂隙魔法伤害"}, {"aug": "炼狱导管", "pair": "炼狱导管", "augs": ["炼狱导管"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "QE命中仅叠加一层炼狱导管，缩减CD极少，切勿拿"}], "Bard": [{"aug": "轨道镭射", "pair": "轨道镭射", "augs": ["轨道镭射"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "大招金身定人后接轨道镭射+救赎，落地瞬秒一片"}, {"aug": "卡皮巴拉空投", "pair": "卡皮巴拉空投", "augs": ["卡皮巴拉空投"], "tier": "S", "tag": "", "isTrap": false, "desc": "大招定住人后直接放卡皮巴拉空投，金身结束时刚好落地吃满伤害"}, {"aug": "虚空裂隙", "pair": "虚空裂隙", "augs": ["虚空裂隙"], "tier": "S", "tag": "", "isTrap": false, "desc": "木灵被动AOE普攻可以直接触发虚空裂隙"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "C", "tag": "陷阱", "isTrap": true, "desc": "Q技能不附带木灵被动，属于陷阱切勿拿"}], "AurelionSol": [{"aug": "缩小引擎", "pair": "缩小引擎", "augs": ["缩小引擎"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "参与击杀不断叠被动提高E斩杀线，高层数下E黑洞可达成满血斩杀"}], "Aurora": [{"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "被动三环造成高额最大生命百分比魔伤，配合虚幻武器多次触发三环瞬融纯肉"}], "Blitzcrank": [{"aug": "虚幻武器", "pair": "虚幻武器 + 双生火焰", "augs": ["虚幻武器", "双生火焰"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "必出黄昏与黎明！大招被动电击与虚幻武器无限循环触发E无限击飞（禁忌：千万别主动放R）"}], "Brand": [{"aug": "炼狱导管", "pair": "炼狱导管", "augs": ["炼狱导管"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "技能灼烧不断缩减全技能冷却，配合兰德里+火炬在5v5团战实现无限火力"}], "FiddleSticks": [{"aug": "物理转魔法", "pair": "物理转魔法", "augs": ["物理转魔法"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "吸天帝：堆攻击转高额法强，草丛恐惧Q翻倍最大生命百分比魔伤，高法强下一发Q满血斩杀"}, {"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "", "isTrap": false, "desc": "开大招群鸦风暴后接利刃华尔兹无敌进场把所有人烫满"}], "Fiora": [{"aug": "任务：钢化你心", "pair": "任务：钢化你心 + 坦克引擎", "augs": ["任务：钢化你心", "坦克引擎"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "心之钢+坦克引擎叠血，霸王血铠将生命转攻击力，成型后一个破绽接近100%最大生命真伤"}, {"aug": "秘术冲拳", "pair": "秘术冲拳 + 一板一眼", "augs": ["秘术冲拳", "一板一眼"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "秘术冲拳减Q冷却直接开启利刃华尔兹，配合一板一眼全程开E无限Q吃满攻击加成"}], "Galio": [{"aug": "吞噬灵魂", "pair": "吞噬灵魂", "augs": ["吞噬灵魂"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "堆法强、魔抗、生命值与300+技能急速，W嘲讽延长双减伤可达成团战全程接近100%免伤"}], "Garen": [{"aug": "一板一眼", "pair": "一板一眼", "augs": ["一板一眼"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "攻速转巨额攻击力，E审判旋转伤害爆炸"}, {"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "", "isTrap": false, "desc": "开E后接利刃华尔兹无敌进场打满全额旋转伤害，锻体选攻击力和暴击"}, {"aug": "究极九头蛇", "pair": "究极九头蛇", "augs": ["究极九头蛇"], "tier": "B", "tag": "黑科技", "isTrap": false, "desc": "完成三件九头蛇任务，搭配更万用的瞄准镜和暴击律动安全距离打出高额顺劈"}], "Gangplank": [{"aug": "回归基本功", "pair": "回归基本功", "augs": ["回归基本功"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "巨幅提高E火药桶伤害（桶子自带40%穿甲），实现一桶秒脆皮"}, {"aug": "唯快不破", "pair": "唯快不破", "augs": ["唯快不破"], "tier": "S", "tag": "神级", "isTrap": false, "desc": "高频移速与火刀被动拉扯，连桶手感拉满"}], "Gnar": [{"aug": "连拨击锤", "pair": "连拨击锤 + 双刀流", "augs": ["连拨击锤", "双刀流"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "小纳尔W享100%AP加成与14%最大生命魔伤，一发平A施加5次特效触发双三环瞬秒对手"}], "Gragas": [{"aug": "物理转魔法", "pair": "物理转魔法", "augs": ["物理转魔法"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "W享法强加成百分比减伤，物转法堆高法强后W期间获得2.5秒接近100%减伤无敌效果"}], "Hecarim": [{"aug": "虚幻武器", "pair": "虚幻武器 + 秘术冲拳", "augs": ["虚幻武器", "秘术冲拳"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "经典幻影武器+秘术冲拳组合，Q技能触发普攻特效快速刷新全技能实现无限Q"}], "Jayce": [{"aug": "一板一眼", "pair": "一板一眼", "augs": ["一板一眼"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "炮形态W直接提供满额2.5攻速，被一板一眼瞬间转化为巨额攻击力！务必先开炮形态W再放QE"}], "Lucian": [{"aug": "珠光护手", "pair": "珠光护手 + 易损", "augs": ["珠光护手", "易损"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "大招圣枪洗礼产生暴击，配合易损与无尽之刃乘算叠加，开启R造成清屏级爆发"}], "MasterYi": [{"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "配合190点技能急速使Q技能达到零冷却，实现无限Q无法选中（必出夺萃之镰回蓝）"}], "MissFortune": [{"aug": "由心及物", "pair": "由心及物", "augs": ["由心及物"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "堆200+技能急速配合大法师羁绊，W减E冷却、E减W冷却，实现全屏无限E枪林弹雨"}], "Mordekaiser": [{"aug": "死亡之环", "pair": "死亡之环 + 蛋白粉奶昔", "augs": ["死亡之环", "蛋白粉奶昔", "裁决使"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "W护盾回血70%转化为魔法伤害秒脆皮！禁忌：禁出峡谷制造者等全能吸血装（会吞掉伤害），需出法穿"}], "Pantheon": [{"aug": "任务：钢化你心", "pair": "任务：钢化你心", "augs": ["任务：钢化你心"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "W有额外生命值加成，心之钢叠高血量后红怒W可造成接近敌方100%生命值的物理伤害"}], "Rell": [{"aug": "残忍", "pair": "残忍 + 坦克引擎", "augs": ["残忍", "坦克引擎"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "坦克引擎与残忍联动，在极强控制同时拥有惊人持续伤害，达成1v5战神"}], "Tryndamere": [{"aug": "死亡之环", "pair": "死亡之环", "augs": ["死亡之环"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "治疗量转魔法伤害，蛮王Q享高额AP加成，堆法强法穿叠满怒气靠近1000码内一发Q秒脆皮"}], "Udyr": [{"aug": "最万用的瞄准镜", "pair": "最万用的瞄准镜", "augs": ["最万用的瞄准镜"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "弥补手短硬伤，利用觉醒Q的6次闪电打击造成高额最大生命值伤害瞬间秒杀落单敌人"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "觉醒R风暴造成最大生命值魔伤，堆法强在人堆里放觉醒R配合虚幻武器瞬间融化敌方"}], "Vayne": [{"aug": "连拨击锤", "pair": "连拨击锤 + 双刀流", "augs": ["连拨击锤", "双刀流", "接二连三"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "一发平A施加5次攻击特效直接触发2次W三环真伤，配合羊刀一发平A蒸发大半管血"}], "Vladimir": [{"aug": "炼狱导管", "pair": "炼狱导管", "augs": ["炼狱导管"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "堆160点以上技能急速后，W血池命中两名敌人即可实现无缝刷新无限W"}], "Yasuo": [{"aug": "秘术冲拳", "pair": "秘术冲拳", "augs": ["秘术冲拳"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "普攻减1.25秒全技能CD，亚索Q视为普攻，Q冷却达1.33秒时可无限Q，配合毁坏仪式无限刷盾"}], "Ziggs": [{"aug": "炼狱导管", "pair": "炼狱导管", "augs": ["炼狱导管"], "tier": "S+", "tag": "神级", "isTrap": false, "desc": "技能灼烧大幅返还冷却，必出兰德里+黯炎火炬实现无限甩技能轰炸"}], "Kennen": [{"aug": "小丑学院", "pair": "小丑学院", "augs": ["小丑学院"], "tier": "A", "tag": "强力", "isTrap": false, "desc": "开大招后隐身进场电满全场"}, {"aug": "物理转魔法", "pair": "物理转魔法", "augs": ["物理转魔法"], "tier": "A", "tag": "", "isTrap": false, "desc": "有物转法时出攻击装转化为高额法强，技能与平A双修"}], "Vi": [{"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "", "isTrap": false, "desc": "大招锁头+利刃华尔兹全员起飞"}], "Ekko": [{"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹", "连拨击锤", "虚幻武器"], "tier": "S", "tag": "", "isTrap": false, "desc": "W被动附带高额已损失生命百分比伤害，利刃华尔兹/连拨击锤每次都能触发W被动打出爆炸伤害"}], "Illaoi": [{"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "", "isTrap": false, "desc": "开启W后再施放利刃华尔兹，无敌期间可连续触发8次W触手拍击"}, {"aug": "虚幻武器", "pair": "虚幻武器", "augs": ["虚幻武器"], "tier": "S", "tag": "黑科技", "isTrap": false, "desc": "激活W不要A出去，Q中敌人后触手会无限自动拍击（开R后挥舞加快50%，W千万别A掉）"}], "Naafiri": [{"aug": "利刃华尔兹", "pair": "利刃华尔兹 + 扳机炼狱", "augs": ["利刃华尔兹", "扳机炼狱"], "tier": "S", "tag": "", "isTrap": false, "desc": "小狗判定为多技能，R冲上去贴脸EQ瞬间叠满S评分，配合W无敌与攻击加成伤害拉满"}], "Urgot": [{"aug": "利刃华尔兹", "pair": "利刃华尔兹", "augs": ["利刃华尔兹"], "tier": "S", "tag": "", "isTrap": false, "desc": "利刃华尔兹环绕突进一键打满全身六个方向的被动膝盖散弹，伤害爆炸"}]};

function htmlToLinesAm(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:div|p|h[1-6]|li|ul|ol|article|section|header|footer|main|nav|aside|tr|table|blockquote|dd|dt|dl|figure|figcaption|form|fieldset|hr|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isMeaningfulAmDesc(s) {
  const clean = String(s || '').replace(/[\/।，。、！？：；\s\d—\-↑.+<>()（）【】\[\]'"a-zA-Z]/g, '');
  return clean.length >= 3;
}

function parseArammayhemLines(lines, heroTitle) {
  const byPair = new Map();
  const tierScore = { 'S+': 6, 'S': 5, 'A': 4, 'B': 3, 'C': 2, 'D': 1 };
  const addCombo = (pairRaw, tier, tagRaw, descRaw) => {
    const pair = String(pairRaw || '').replace(/\s*\+\s*/g, ' + ').trim();
    const augs = pair.split('+').map((s) => s.trim()).filter(Boolean);
    if (!augs.length) return;
    let desc = String(descRaw || '')
      .replace(/\s*\/\s*/g, '；')
      .replace(/([。！!？?；;])\s*[；;]+/g, '$1')
      .replace(/[；;]{2,}/g, '；')
      .replace(/^[\s；;，,。]+|[\s；;，,]+$/g, '')
      .trim();
    const prevList = [...byPair.values()];
    if (desc === '同理' && prevList.length) desc = prevList[prevList.length - 1].desc;
    if (!isMeaningfulAmDesc(desc)) return;
    const tag = String(tagRaw || '').replace(/\s+/g, '').trim();
    const isTrap = tag.includes('陷阱') || (tier === 'C' && /无法|不能|不触发|无效|别拿|仅一层/.test(desc));
    const normKey = augs.slice().sort().join('+') + (isTrap ? '|trap' : '');
    const t = tier || 'S';
    const existing = byPair.get(normKey);
    if (existing) {
      if ((tierScore[t] || 0) > (tierScore[existing.tier] || 0)) existing.tier = t;
      if (!existing.tag && tag) existing.tag = tag;
      if (desc.length > existing.desc.length && !existing.desc.includes(desc)) {
        existing.desc = desc;
      }
      return;
    }
    byPair.set(normKey, { aug: augs[0], pair, augs, tier: t, tag, isTrap, desc });
  };

  // A. 解析 /zh-cn/build/{slug}/ 强化组合段落（含双海克斯组合名）
  const buildStart = lines.findIndex((l) => l.endsWith('强化组合') || (l.includes('查看') && l.includes('全部组合')));
  if (buildStart >= 0) {
    const endIdx = lines.findIndex((l, idx) => idx > buildStart && (l === '提交组合' || l.includes('技能主升顺序') || l.includes('海克斯大乱斗出装与强化')));
    const slice = lines.slice(buildStart, endIdx > buildStart ? endIdx : buildStart + 140);
    for (let i = 0; i < slice.length; i++) {
      const m = slice[i].match(/^(.+?)\s*组合\s*(S\+|S|A|B|C|D)\s*((?:(?:神级|强力|黑科技|娱乐|陷阱|Bug)\s*)*)$/i);
      if (m) {
        const pairRaw = m[1].trim();
        if (pairRaw.includes('查看') || pairRaw.includes('个组合') || pairRaw.includes('提交')) continue;
        const tier = m[2].toUpperCase();
        const tag = m[3] || '';
        const descLines = [];
        for (let j = i + 1; j < Math.min(slice.length, i + 5); j++) {
          if (/^↑\s*(?:\d+|—|-)/.test(slice[j])) { i = j; break; }
          if (/^(.+?)\s*组合\s*(S\+|S|A|B|C|D)/i.test(slice[j])) { i = j - 1; break; }
          if (slice[j] === '提交组合' || slice[j].startsWith('< 上一页')) { i = j; break; }
          descLines.push(slice[j]);
        }
        if (descLines.length > 1 && descLines[descLines.length - 1].length <= 12 && !/[。！!？?；/]/.test(descLines[descLines.length - 1])) {
          if (slice[i + 1] && /组合(S\+|S|A|B|C|D)/.test(slice[i + 1])) descLines.pop();
        }
        addCombo(pairRaw, tier, tag, descLines.join(' '));
      }
    }
  }

  // B. 解析 /zh-cn/combo/champion/{slug}/ 段落（"<英雄称号>+<海克斯><Tier><Tag>"）
  const comboEnd = lines.findIndex((l) => l === '快速链接' || l === '继续探索' || l.includes('的相似英雄'));
  const comboSlice = comboEnd > 0 ? lines.slice(0, comboEnd) : lines;
  for (let i = 0; i < comboSlice.length; i++) {
    const l = comboSlice[i];
    if (!l.includes('+')) continue;
    const m = l.match(/^([^\+]{1,12})\+\s*(.+?)\s*(?:Curated\s*)?(S\+|S|A|B|C|D)\s*((?:(?:神级|强力|黑科技|娱乐|陷阱|Bug)\s*)*)$/i);
    if (!m) continue;
    const hName = m[1].trim(), augName = m[2].trim(), tier = m[3].toUpperCase(), tag = m[4] || '';
    if (heroTitle && hName !== heroTitle) continue;
    if (!heroTitle && i > 0 && comboSlice[i - 1] !== augName) continue;
    const desc = comboSlice[i + 1] || '';
    if (desc && !desc.includes('快速链接') && !desc.includes('相关海克斯')) {
      addCombo(augName, tier, tag, desc);
    }
  }

  // C. 解析技能加点与核心出装/鞋子（作为第 4 源兜底）
  let skills = [];
  for (const l of lines) {
    const sm = l.match(/^([QWE])\s*>\s*([QWE])\s*>\s*([QWE])\s*登场率/);
    if (sm) { skills = [sm[1], sm[2]]; break; }
  }
  const coreNames = [], bootNames = [];
  const coreIdx = lines.indexOf('核心出装'), bootIdx = lines.indexOf('鞋子');
  if (coreIdx >= 0) {
    for (let i = coreIdx + 1; i < Math.min(lines.length, coreIdx + 18); i++) {
      if (lines[i] === '其他成装' || lines[i] === '后期出装' || lines[i].includes('最佳英雄搭档')) break;
      if (lines[i].includes('›')) {
        const items = lines[i].split('›').map((x) => x.trim()).filter(Boolean);
        const wrM = (lines[i + 1] || '').match(/胜率\s*([\d.]+)%/);
        coreNames.push({ items, wr: wrM ? parseFloat(wrM[1]) / 100 : null });
      }
    }
  }
  if (bootIdx >= 0) {
    for (let i = bootIdx + 1; i < Math.min(lines.length, bootIdx + 12); i++) {
      if (lines[i] === '核心出装') break;
      if (!lines[i].includes('登场率') && lines[i].length <= 8) {
        const wrM = (lines[i + 1] || '').match(/胜率\s*([\d.]+)%/);
        bootNames.push({ name: lines[i], wr: wrM ? parseFloat(wrM[1]) / 100 : null });
      }
    }
  }
  return { combos: [...byPair.values()], skills, coreNames, bootNames };
}

async function fetchArammayhem(alias, heroTitle, ctx) {
  const builtin = (alias && AM_BUILTIN[alias]) ? AM_BUILTIN[alias].slice() : [];
  const slug = String(alias || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) return { combos: builtin, skills: [], coreNames: [], bootNames: [] };

  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const cacheKey = new Request(`https://am-mayhem-cache.local/v2/${slug}`);
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      try { return await hit.json(); } catch {}
    }
  }

  let parsed = { combos: [], skills: [], coreNames: [], bootNames: [] };
  try {
    const fetchPage = async (u) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3200);
      try {
        const r = await fetch(u, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hextech-recommender/0.4)', 'Accept-Language': 'zh-CN,zh;q=0.9' },
          cf: { cacheEverything: true, cacheTtl: 21600 },
          signal: ctrl.signal,
        });
        if (!r.ok) return '';
        return await r.text();
      } finally { clearTimeout(t); }
    };
    const [comboHtml, buildHtml] = await Promise.all([
      fetchPage(`https://arammayhem.com/zh-cn/combo/champion/${slug}/`).catch(() => ''),
      fetchPage(`https://arammayhem.com/zh-cn/build/${slug}/`).catch(() => ''),
    ]);
    const lines = [
      ...(buildHtml ? htmlToLinesAm(buildHtml) : []),
      ...(comboHtml ? htmlToLinesAm(comboHtml) : []),
    ];
    if (lines.length) parsed = parseArammayhemLines(lines, heroTitle);
  } catch {}

  // 合并实时抓取结果与内置精选库（实时优先，内置补齐）
  const merged = parsed.combos.slice();
  for (const b of builtin) {
    if (!merged.some((x) => x.aug === b.aug)) merged.push(b);
  }
  const out = { combos: merged, skills: parsed.skills || [], coreNames: parsed.coreNames || [], bootNames: parsed.bootNames || [] };
  if (cache && parsed.combos.length) {
    const put = cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return out;
}

async function numericIdFor(query, ctx) {
  // RESG 数字 id → arammeta 同 id；RESG 不可用时用 arammeta 自查
  try {
    const v = await latestVersion();
    const { items } = await resgFetch(`/versions/${v}/champions.js`);
    const ent = findByQuery(items, query, ['name', 'title', 'alias']);
    if (ent?.id != null) return { id: ent.id, name: ent.name, title: ent.title || ent.name, alias: ent.alias };
  } catch { /* fall through */ }
  try {
    const am = await fetchArammeta(ctx);
    const q = String(query).trim().toLowerCase();
    const hit = Object.entries(am.champs || {}).find(([, c]) =>
      [c.name_zh, c.name_en, c.alias].some((x) => String(x || '').toLowerCase() === q));
    if (hit) return { id: +hit[0], name: hit[1].name_zh, title: hit[1].name_zh, alias: hit[1].alias };
  } catch { /* ignore */ }
  return null;
}

function mergeAmTraps(traps, amCombos) {
  const out = (traps || []).slice();
  const seen = new Set(out.map((t) => t.name));
  for (const c of (amCombos || [])) {
    if (c.isTrap && c.aug && !seen.has(c.aug)) {
      seen.add(c.aug);
      out.push({ id: null, name: c.aug, desc: c.desc });
    }
  }
  return out;
}

export async function fetchBuilds(query, ctx) {
  const who = await numericIdFor(query, ctx);
  if (!who) return null;
  const [dict, amData] = await Promise.all([
    getItemDict(ctx).catch(() => null),
    fetchArammayhem(who.alias, who.title || who.name, ctx).catch(() => ({ combos: [], skills: [] })),
  ]);
  const amCombos = amData?.combos || [];

  // 主源：arammeta 胜率出装 + cchappy 加点/避坑 + arammayhem 精选组合
  try {
    const detail = await fetchArammetaDetail(who.id, ctx);
    const b = arammetaBuilds(detail, dict);
    let traps = [], skills = [], guide = null, notes = null;
    try {
      const { data: d } = await ccFetch(`/heroes/${encodeURIComponent(who.alias || '')}`, ctx);
      const bg = d?.data?.config?.buildGuides?.[0];
      if (bg) {
        traps = (bg.trapAugments || []).map((t) => ({ id: t.id, name: t.name })).filter((t) => t.name);
        skills = [bg.primarySkill, bg.secondarySkill].filter(Boolean);
        guide = bg.name || null;
        notes = String(bg.notes || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      }
    } catch { /* 补充失败不影响主数据 */ }
    if (!skills.length && amData?.skills?.length) skills = amData.skills;
    traps = mergeAmTraps(traps, amCombos);
    return { source: 'arammeta', champion: who.name, title: who.title, alias: who.alias, guide, notes, traps, skills, amCombos, ...b };
  } catch (e) { /* 降级走 cchappy 或 arammayhem 兜底 */ }

  // 二级兜底：cchappy 攻略 + arammayhem 精选组合
  try {
    const { data: d, stale } = await ccFetch(`/heroes/${encodeURIComponent(who.alias || '')}`, ctx);
    const bg = d?.data?.config?.buildGuides?.[0];
    if (bg) {
      let skills = [bg.primarySkill, bg.secondarySkill].filter(Boolean);
      if (!skills.length && amData?.skills?.length) skills = amData.skills;
      const traps = mergeAmTraps((bg.trapAugments || []).map((t) => ({ id: t.id, name: t.name })).filter((t) => t.name), amCombos);
      return {
        source: 'cchappy', fallback: true,
        champion: who.name, title: who.title, alias: who.alias,
        stale: !!stale,
        guide: bg.name || null,
        skills,
        notes: String(bg.notes || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
        starting: enrichWithOfficial(slimList(bg.startingItems), dict),
        core: enrichWithOfficial(slimList(bg.coreItems), dict),
        optional: enrichWithOfficial(slimList(bg.optionalItems), dict),
        traps,
        amCombos,
        spells: (bg.summonerSpells || []).map((s) => ({
          name: s.name,
          icon: `${DD}/img/spell/${s.imageFull || s.key + '.png'}`,
        })),
      };
    }
  } catch {}

  // 三级兜底：纯 arammayhem 数据兜底
  if (amCombos.length || amData?.coreNames?.length) {
    const nameToItem = new Map();
    if (dict) {
      for (const [id, it] of Object.entries(dict)) if (it.name) nameToItem.set(it.name, { id: +id, ...it });
    }
    const combos = (amData.coreNames || []).slice(0, 3).map((c) => ({
      name: c.items.join(' + '),
      items: c.items.map((nm) => nameToItem.get(nm) || { id: 0, name: nm, icon: '' }).filter((x) => x.icon),
      wr: c.wr, games: 0, lift: null,
    })).filter((c) => c.items.length);
    const boots = (amData.bootNames || []).slice(0, 3).map((b0) => {
      const hit = nameToItem.get(b0.name);
      return hit ? { ...hit, wr: b0.wr, games: 0 } : null;
    }).filter(Boolean);
    return {
      source: 'arammeta', fallback: true,
      champion: who.name, title: who.title, alias: who.alias,
      guide: 'ARAM Mayhem 推荐', notes: null,
      traps: mergeAmTraps([], amCombos),
      skills: amData.skills || [],
      amCombos, combos, badCombos: [], singles: [], boots, spells: [],
    };
  }
  return null;
}
