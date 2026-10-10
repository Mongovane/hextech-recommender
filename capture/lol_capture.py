"""LoL 海克斯大乱斗 · 本地截屏识别（全局热键，不用切出游戏）
安装：pip install mss pillow requests keyboard      （Windows 下 keyboard 需以管理员身份运行）
热键：F8 截屏识别 | F9 把上次推荐项记为"已选" | F10 重新设置英雄
游戏建议用「无边框」模式；独占全屏可能抓到黑屏。"""
import base64, io, os, requests, mss, keyboard, urllib3
from PIL import Image
urllib3.disable_warnings()

WORKER = os.environ.get("HEXTECH_WORKER", "https://你的worker域名")
TOKEN = ""                       # 只有 Worker 设置了 ACCESS_TOKEN 才需要
MODE = "auto"                    # auto = 智能(jev，未配置会自动降档)；wr = 纯胜率
CROP = (0.0, 0.18, 1.0, 0.64)    # x, y, 宽, 高（占整屏比例），按你的界面微调
HEADERS = {"X-Token": TOKEN} if TOKEN else {}
picked, last_pick, champion = [], None, None

def live_champion():
    """尽力从客户端本地 API 读当前英雄，失败返回 None（再手动输入）"""
    try:
        base = "https://127.0.0.1:2999/liveclientdata"
        me = requests.get(base + "/activeplayername", verify=False, timeout=1).json()
        for p in requests.get(base + "/playerlist", verify=False, timeout=1).json():
            if me in (p.get("riotId"), p.get("summonerName"), p.get("riotIdGameName")):
                return p["championName"]
    except Exception:
        pass

def grab_b64():
    with mss.mss() as s:
        m = s.monitors[1]
        x, y, w, h = CROP
        shot = s.grab({"left": m["left"] + int(m["width"] * x), "top": m["top"] + int(m["height"] * y),
                       "width": int(m["width"] * w), "height": int(m["height"] * h)})
    im = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    if im.width > 1280:
        im = im.resize((1280, int(im.height * 1280 / im.width)))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=82)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

def set_champion():
    global champion
    champion = live_champion() or input("英雄名（如 瑞兹）：").strip()
    print("当前英雄：", champion)

def run():
    global last_pick
    if not champion:
        return print("先设置英雄（F10）")
    r = requests.post(WORKER + "/api/ocr-recommend", headers=HEADERS, timeout=60,
                      json={"champion": champion, "image": grab_b64(), "picked": picked, "mode": MODE})
    d = r.json()
    if not r.ok:
        return print("失败：", d.get("error"), [c.get("ocr") for c in d.get("cards", [])])
    rec = d["recommend"]; last_pick = rec["pick"]
    if rec.get("degraded"):
        print("[已降档为纯胜率]", rec.get("jevError") or rec["degraded"])
    for i, x in enumerate(rec["ranking"], 1):
        wr = x.get("eff") if x.get("eff") is not None else (x["champWr"] if x["champWr"] is not None else x["globalWr"])
        print(f"{'>>' if x['name'] == rec['pick'] else '  '} {i}. {x['name']}  {wr * 100:.1f}%")

def mark_picked():
    if last_pick and last_pick not in picked:
        picked.append(last_pick); print("已记录：", picked)

set_champion()
keyboard.add_hotkey("f8", run); keyboard.add_hotkey("f9", mark_picked); keyboard.add_hotkey("f10", set_champion)
print("就绪：F8 识别 / F9 记已选 / F10 换英雄")
keyboard.wait()
