# ==============================================================
# ファイル: advent/img_src/make_advent2026_images.py
# 役割: 防災アドカレ 2026 の 2 記事（20261201_main.md・20261202_sub.md）の図とグラフを作る。
#   見た目はサイトの運用構成の図（site/infre/img/aws_new.png・draw.io）に合わせる：
#   白地・細い黒枠・自宅鯖／AWS の枠・東京／大阪の水色の点線枠・緑／青／赤の矢印・利用者の人形。
#   SVG を HTML に入れて、Edge（画面なし）で PNG に書き出す（2 倍の解像度）。
# 使い方: py -3.11 advent/img_src/make_advent2026_images.py [名前 ...]   → img/advent2026_*.png
# ==============================================================
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "img"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
FONT = "Meiryo, 'Yu Gothic', 'Noto Sans JP', sans-serif"

GREEN, BLUE, RED, TEAL, NAVY = "#5a9e2f", "#6c8ebf", "#c00000", "#00a4a6", "#232f3e"
LAMP = {"赤": "#e53935", "黄": "#ffc107", "緑": "#43a047", "青": "#1e88e5", "白": "#f5f5f5"}
MARK = {GREEN: "g", BLUE: "b", RED: "r"}


# ---------- 部品 ----------
def text(x, y, s, fs=13, bold=False, anchor="middle", color="#000"):
    lines = str(s).split("\n")
    top = y - (len(lines) - 1) * fs * 0.62
    spans = "".join(f'<tspan x="{x}" y="{top + i * fs * 1.25:.1f}">{escape(l)}</tspan>' for i, l in enumerate(lines))
    w = "bold" if bold else "normal"
    return (f'<text font-size="{fs}" font-weight="{w}" text-anchor="{anchor}" dominant-baseline="middle" '
            f'fill="{color}">{spans}</text>')


def box(x, y, w, h, s="", fs=13, bold=False, fill="#fff", stroke="#000", dash=None, rx=0, color="#000"):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}"{d}/>'
            + (text(x + w / 2, y + h / 2, s, fs, bold, color=color) if s else ""))


def group(x, y, w, h, title):
    """draw.io の「自宅鯖」の枠（上に見出しの帯）"""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#fff" stroke="#000"/>'
            f'<line x1="{x}" y1="{y + 22}" x2="{x + w}" y2="{y + 22}" stroke="#000"/>'
            + text(x + 4, y + 11, title, 12, True, anchor="start"))


def aws_group(x, y, w, h):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="{NAVY}"/>'
            f'<rect x="{x}" y="{y}" width="26" height="26" fill="{NAVY}"/>'
            + text(x + 13, y + 10, "aws", 10, True, color="#fff")
            + f'<path d="M{x + 6} {y + 18} q7 4 14 0" stroke="#ff9900" stroke-width="1.6" fill="none"/>'
            + text(x + 32, y + 13, "AWS", 12, anchor="start"))


def region(x, y, w, h, label):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="{TEAL}" stroke-dasharray="4 3"/>'
            f'<rect x="{x}" y="{y}" width="24" height="24" fill="{TEAL}"/>'
            f'<path d="M{x + 8} {y + 19} V{y + 5} h9 l-2 3 l2 3 h-9" stroke="#fff" stroke-width="1.4" fill="none"/>'
            + text(x + 30, y + 12, label, 12, anchor="start", color="#147eba"))


def arrow(points, color=GREEN, dash=None, width=1.3):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    pts = " ".join(f"{px},{py}" for px, py in points)
    return (f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="{width}"{d} '
            f'marker-end="url(#a{MARK.get(color, "k")})"/>')


def curve(p0, c1, c2, p1, color=RED, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="M{p0[0]} {p0[1]} C{c1[0]} {c1[1]} {c2[0]} {c2[1]} {p1[0]} {p1[1]}" fill="none" '
            f'stroke="{color}" stroke-width="1.2"{d} marker-end="url(#a{MARK.get(color, "k")})"/>')


def person(cx, y, label="利用者"):
    return (f'<circle cx="{cx}" cy="{y + 9}" r="9" fill="#fff" stroke="#000"/>'
            f'<path d="M{cx} {y + 18} V{y + 48} M{cx - 20} {y + 28} H{cx + 20} M{cx} {y + 48} L{cx - 18} {y + 72} '
            f'M{cx} {y + 48} L{cx + 18} {y + 72}" stroke="#000" fill="none"/>' + text(cx, y + 86, label, 12))


def legend(x, y, items):
    out = []
    for i, (color, label, dash) in enumerate(items):
        yy = y + i * 22
        out.append(arrow([(x, yy), (x + 46, yy)], color, dash))
        out.append(text(x + 56, yy, label, 12, anchor="start"))
    return "".join(out)


def lambda_stack(x, y, w, h, title, last):
    """元の図の「津波配信／配信1…配信10」の枠"""
    cx = x + w / 2
    return (group(x, y, w, h, "")
            + text(cx, y + 11, title, 12, True)
            + box(cx - 36, y + 36, 72, 30, "配信1", 12)
            + f'<line x1="{cx}" y1="{y + 70}" x2="{cx}" y2="{y + h - 50}" stroke="#000" stroke-width="2" stroke-dasharray="2 5"/>'
            + box(cx - 36, y + h - 44, 72, 30, last, 12))


def tower(cx, y, on: dict, scale=1.0, order=("赤", "黄", "緑", "青", "白")):
    """積層灯。on = {色: "on" | "flash"}。点滅は点線の枠で表す。"""
    w, h = 46 * scale, 26 * scale
    out = []
    for i, name in enumerate(order):
        yy = y + i * (h + 2 * scale)
        mode = on.get(name)
        fill = LAMP[name] if mode else "#d9d9d9"
        if mode == "flash":   # 点滅：左右に光の線（隣のランプにかぶらない）
            ray = LAMP[name] if name != "白" else "#9e9e9e"
            my = yy + h / 2
            for side in (-1, 1):
                x1 = cx + side * (w / 2 + 5 * scale)
                x2 = cx + side * (w / 2 + 15 * scale)
                for dy in (-9, 0, 9):
                    out.append(f'<line x1="{x1}" y1="{my + dy * scale * 0.5}" x2="{x2}" y2="{my + dy * scale}" '
                               f'stroke="{ray}" stroke-width="{2.4 * scale}" stroke-linecap="round"/>')
        op = "1" if mode else "0.55"
        out.append(f'<rect x="{cx - w / 2}" y="{yy}" width="{w}" height="{h}" rx="{4 * scale}" fill="{fill}" '
                   f'stroke="#555" opacity="{op}"/>')
    base_y = y + len(order) * (h + 2 * scale)
    out.append(f'<rect x="{cx - w / 2 - 3 * scale}" y="{base_y}" width="{w + 6 * scale}" height="{12 * scale}" fill="#9e9e9e" stroke="#555"/>')
    out.append(f'<rect x="{cx - 4 * scale}" y="{base_y + 12 * scale}" width="{8 * scale}" height="{22 * scale}" fill="#bdbdbd" stroke="#555"/>')
    return "".join(out)


def svg(w, h, body):
    marks = "".join(
        f'<marker id="a{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        f'<path d="M0 0 L10 5 L0 10 z" fill="{c}"/></marker>'
        for k, c in (("g", GREEN), ("b", BLUE), ("r", RED), ("k", "#000")))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'font-family="{FONT}"><defs>{marks}</defs><rect width="{w}" height="{h}" fill="#fff"/>{body}</svg>')


# ---------- 1 枠目（高速配信と冗長性） ----------
def main_architecture():
    b = [box(100, 30, 1000, 54, "DM-D.S.S様　または　気象庁XML（上流の防災情報）", 18)]
    b.append(group(100, 120, 1000, 140, "自宅鯖"))
    b += [box(160, 175, 200, 56, "受信・XML解析", 13), box(500, 175, 200, 56, "Discord用データの生成", 13),
          box(850, 175, 180, 56, "配信監視", 13)]
    b.append(aws_group(100, 300, 1000, 560))
    for rx, name, title, last in ((120, "東京（主に地震・津波）", "地震・津波配信", "配信16"),
                                  (620, "大阪（主に気象・火山）", "気象・火山配信", "配信10")):
        b.append(region(rx, 340, 460, 480, name))
        b += [box(rx + 20, 380, 160, 50, "予備の受信\n（EC2）", 12), box(rx + 250, 380, 180, 50, "受付API", 13),
              box(rx + 20, 480, 180, 50, "受付データの保存\n（バックアップ用）", 12),
              box(rx + 250, 480, 180, 56, "配信する系統を\n1つに決める", 12)]
        b.append(lambda_stack(rx + 60, 600, 150, 190, title, last))
        b.append(lambda_stack(rx + 250, 600, 150, 190, "バックアップ用", "配信10"))
        # 通常（緑）：受付 → 決める → 配信
        b.append(arrow([(rx + 340, 430), (rx + 340, 480)]))
        b.append(arrow([(rx + 300, 536), (rx + 300, 565), (rx + 135, 565), (rx + 135, 600)]))
        # バックアップ（青）：予備の受信 → 受付、受付 → 保存、保存 → 決める、決める → バックアップ用
        b.append(arrow([(rx + 180, 405), (rx + 250, 405)], BLUE))
        b.append(arrow([(rx + 100, 430), (rx + 100, 480)], BLUE, "5 3"))
        b.append(arrow([(rx + 200, 508), (rx + 250, 508)], BLUE, "5 3"))
        b.append(arrow([(rx + 380, 536), (rx + 380, 580), (rx + 325, 580), (rx + 325, 600)], BLUE))
        # 配信 → 利用者（緑）
        b.append(curve((rx + 135, 790), (rx + 135, 850), (590, 830), (595, 885), GREEN))
        b.append(curve((rx + 325, 790), (rx + 325, 840), (600, 845), (603, 885), GREEN))
    # 状態の報告（赤）：配信 → 配信監視
    b.append(arrow([(520, 700), (600, 700), (600, 268), (900, 268), (900, 231)], RED))
    b.append(arrow([(1020, 700), (1062, 700), (1062, 268), (985, 268), (985, 231)], RED))
    # 上流 → 自宅（緑）・予備（青）
    b.append(arrow([(260, 84), (260, 175)]))
    b.append(arrow([(940, 84), (940, 175)]))
    b.append(arrow([(360, 203), (500, 203)]))
    b.append(arrow([(700, 203), (850, 203)], RED))
    b.append(arrow([(560, 231), (560, 285), (460, 285), (460, 380)]))
    b.append(arrow([(640, 231), (640, 285), (960, 285), (960, 380)]))
    b.append(arrow([(120, 84), (120, 100), (88, 100), (88, 370), (220, 370), (220, 380)], BLUE))
    b.append(arrow([(1080, 84), (1080, 100), (1112, 100), (1112, 370), (720, 370), (720, 380)], BLUE))
    # 東京と大阪の相互バックアップ
    b.append(f'<polyline points="530,538 530,553 890,553 890,538" fill="none" stroke="{BLUE}" stroke-width="1.3" '
             f'stroke-dasharray="2 3" marker-start="url(#ab)" marker-end="url(#ab)"/>')
    b.append(text(710, 542, "東京⇔大阪の相互バックアップ", 11, color="#3d5f8f"))
    b.append(person(600, 885, "利用者（Discord）"))
    b.append(legend(820, 895, [(GREEN, "通常の流れ", None), (BLUE, "障害時・バックアップ", None),
                               (RED, "状態の報告（監視）", None)]))
    return svg(1200, 990, "".join(b))


def main_dedup():
    b = [text(600, 30, "同じ情報が複数の経路から届いても、配信するのは1つの系統だけ", 18, True)]
    for name, y in (("自宅サーバー経由", 90), ("東京の予備の受信", 200), ("大阪の予備の受信", 310)):
        b.append(box(40, y, 190, 56, name, 14))
        b.append(arrow([(230, y + 28), (290, y + 28), (290, 228), (330, 228)]))
    b.append(box(330, 190, 190, 76, "同じ情報として\nまとめる", 14))
    b.append(arrow([(520, 228), (585, 228)]))
    b.append('<polygon points="690,150 795,228 690,306 585,228" fill="#fff" stroke="#000"/>')
    b.append(text(690, 228, "配信する権利を\n取れた？", 14))
    b.append(arrow([(795, 228), (850, 228)]))
    b.append(text(822, 214, "はい", 12, color=GREEN))
    b.append(box(850, 190, 170, 76, "配信Lambdaへ\n振り分け", 14))
    b.append(arrow([(1020, 228), (1085, 228)]))
    b.append(person(1120, 185, "Discord"))
    b.append(arrow([(690, 306), (690, 360)], RED))
    b.append(text(705, 333, "いいえ", 12, anchor="start", color=RED))
    b.append(box(600, 360, 180, 50, "待機（送らない）", 14, stroke=RED))
    b.append(box(240, 440, 780, 58, "ポイント：Webhook 1件ごとではなく、配信Lambdaへ振り分ける「前」に1回だけ決める", 14,
                 fill="#f4f8fc", stroke=BLUE))
    return svg(1200, 530, "".join(b))


def main_latency():
    # 2026-11-27 に直近 7 日の CloudWatch Logs（配信 Lambda の discord_batch_duration）を集計。ワーカーごとの値の真ん中あたり
    rows = [("緊急地震速報", 1.47, 3.9, 8.1), ("震度変化関連", 0.47, 3.1, 6.7), ("地震・津波関連", 0.84, 3.45, 8.0),
            ("気象系", 1.0, 3.43, 8.3), ("火山情報", 1.83, 4.27, 8.5)]
    x0, y0, scale = 220, 80, 95   # 1 秒 = 95px
    b = [text(600, 30, "配信ワーカーがDiscordへの送信を終えるまでの時間（直近7日間）", 18, True)]
    bottom = y0 + len(rows) * 70
    for s in range(0, 10):
        x = x0 + s * scale
        b.append(f'<line x1="{x}" y1="{y0 - 6}" x2="{x}" y2="{bottom}" stroke="#e5e5e5"/>')
        b.append(text(x, bottom + 16, f"{s}秒", 12, color="#555"))
    for i, (name, p50, p95, mx) in enumerate(rows):
        y = y0 + i * 70
        b.append(text(x0 - 14, y + 25, name, 14, anchor="end"))
        b.append(f'<rect x="{x0}" y="{y + 8}" width="{p95 * scale}" height="34" fill="#cfe2f3" stroke="{BLUE}"/>')
        b.append(f'<rect x="{x0}" y="{y + 8}" width="{p50 * scale}" height="34" fill="{GREEN}"/>')
        b.append(f'<line x1="{x0 + mx * scale}" y1="{y + 2}" x2="{x0 + mx * scale}" y2="{y + 48}" stroke="{RED}" stroke-width="3"/>')
        b.append(text(x0 + p50 * scale - 5, y + 25, f"{p50:.1f}", 12, True, anchor="end", color="#fff")
                 if p50 >= 0.8 else text(x0 + p50 * scale + 5, y + 25, f"{p50:.1f}", 12, True, anchor="start"))
        b.append(text(x0 + p95 * scale + 6, y + 25, f"p95 {p95:.1f}", 12, anchor="start", color="#3d5f8f"))
        b.append(text(x0 + mx * scale + 8, y + 25, f"最大 {mx:.1f}", 12, anchor="start", color=RED))
    ly = bottom + 46
    b.append(f'<rect x="{x0}" y="{ly - 8}" width="22" height="16" fill="{GREEN}"/>' + text(x0 + 30, ly, "中央値", 12, anchor="start"))
    b.append(f'<rect x="{x0 + 110}" y="{ly - 8}" width="22" height="16" fill="#cfe2f3" stroke="{BLUE}"/>'
             + text(x0 + 140, ly, "p95（95%がこの時間以内）", 12, anchor="start"))
    b.append(f'<line x1="{x0 + 360}" y1="{ly - 9}" x2="{x0 + 360}" y2="{ly + 9}" stroke="{RED}" stroke-width="3"/>'
             + text(x0 + 370, ly, "最大", 12, anchor="start"))
    b.append(text(600, ly + 30, "※ワーカーごとの値の真ん中あたり。気象庁の発表から利用者の画面に表示されるまでの時間ではありません。",
                  12, color="#555"))
    return svg(1200, ly + 56, "".join(b))


def main_image_lambda():
    b = [text(600, 30, "画像の配信：地図を描く場所をAWS Lambdaへ", 18, True)]
    b.append(text(60, 75, "以前", 15, True, anchor="start"))
    b.append(group(60, 90, 700, 110, "自宅鯖"))
    b += [box(80, 135, 150, 50, "電文を受信", 13), box(290, 135, 200, 50, "地図を描く（重い）", 13, stroke=RED),
          box(550, 135, 190, 50, "自宅から画像を送る", 13)]
    b += [arrow([(230, 160), (290, 160)]), arrow([(490, 160), (550, 160)]), arrow([(740, 160), (845, 160)])]
    b.append(person(880, 112, "Discord"))
    b.append(text(60, 245, "現在", 15, True, anchor="start"))
    b.append(group(60, 300, 230, 100, "自宅鯖"))
    b.append(box(80, 335, 150, 50, "電文を受信", 13))
    b.append(aws_group(330, 300, 430, 140))
    b += [box(350, 345, 170, 50, "Lambdaで\n地図を描く", 13), box(570, 345, 170, 50, "画像の置き場所へ\n直接保存", 12)]
    b += [arrow([(230, 360), (350, 360)]), arrow([(520, 370), (570, 370)])]
    b.append(arrow([(655, 395), (655, 420), (155, 420), (155, 385)], GREEN, "5 3"))
    b.append(text(450, 408, "自宅へは「どこに置いたか」だけ返す", 12, color="#3a6e1c"))
    b.append(arrow([(175, 300), (175, 270), (880, 270), (880, 300)], GREEN))
    b.append(text(520, 258, "自宅からは画像のURLだけを送る", 12, color="#3a6e1c"))
    b.append(person(880, 305, "Discord"))
    b.append(box(60, 460, 700, 36, "Lambdaに何かあったときは、今までどおり自宅で描いて送る（予備の経路）", 13, stroke=BLUE, dash="5 3"))
    b.append(text(1060, 75, "津波の図\n最初の画像を送るまで", 14, True))
    top, base = 140, 470
    for x, sec, lab, col in ((1000, 23.0, "約23秒", "#bdbdbd"), (1120, 1.7, "約1.7秒", GREEN)):
        h = (base - top) * sec / 23.0
        b.append(f'<rect x="{x - 35}" y="{base - h}" width="70" height="{h}" fill="{col}"/>')
        b.append(text(x, base - h - 14, lab, 14, True))
    b.append(f'<line x1="950" y1="{base}" x2="1170" y2="{base}" stroke="#000"/>')
    b.append(text(1000, base + 16, "以前", 13) + text(1120, base + 16, "現在", 13))
    return svg(1200, 515, "".join(b))


# ---------- 2 枠目（積層灯） ----------
def sub_control():
    b = [text(500, 30, "今の積層灯の制御の構成", 18, True)]
    b.append(box(40, 80, 220, 56, "DPI-Bot\n（受信・配信監視）", 14))
    b.append(box(40, 170, 220, 56, "Web管理画面", 14))
    b.append(group(320, 65, 260, 170, "PC"))
    b.append(box(340, 115, 220, 70, "Pythonサーバー\n（色と点滅を決める）", 14))
    b += [arrow([(260, 108), (300, 108), (300, 135), (340, 135)]), arrow([(260, 198), (300, 198), (300, 165), (340, 165)])]
    b.append(arrow([(450, 235), (450, 290)]))
    b.append(text(462, 262, "USB", 12, anchor="start"))
    b.append(box(340, 290, 220, 56, "Arduino UNO R3", 14))
    b.append(arrow([(450, 346), (450, 400)]))
    b.append(text(462, 373, "GPIO出力", 12, anchor="start"))
    b.append(box(340, 400, 220, 56, "8chリレー", 14))
    b.append(box(40, 400, 220, 56, "DC24V電源", 14, stroke=RED))
    b.append(arrow([(260, 428), (340, 428)], RED))
    b.append(arrow([(560, 428), (700, 428), (700, 300), (725, 300)], RED))
    b.append(text(630, 414, "各色の信号", 12))
    b.append(tower(780, 110, {"赤": "on", "黄": "on", "緑": "on", "青": "on", "白": "on"}, 1.3))
    for i, name in enumerate(("赤", "黄", "緑", "青", "白（追加）")):
        b.append(text(835, 110 + i * 36.4 + 17, name, 13, anchor="start"))
    b.append(text(780, 435, "PATLITE LR6（中古）", 13, True))
    b.append(box(40, 490, 520, 40, "リレー：赤・黄・緑・青・白・ブザー・確認ボタンのLED・停止ボタンのLED", 12, fill="#f7f7f7"))
    return svg(1000, 560, "".join(b))


def sub_future():
    b = [text(500, 30, "これからやりたい構成（PCなしで動かす）", 18, True)]
    b.append(box(40, 80, 220, 60, "DPI-Bot\n配信監視システム", 14))
    b.append(box(380, 80, 240, 60, "Arduino UNO R4 WiFi", 15, bold=True, stroke=GREEN))
    b.append(arrow([(260, 110), (380, 110)]))
    b.append(text(320, 96, "Wi-Fi", 12, color="#3a6e1c"))
    b.append(box(380, 200, 240, 56, "リレー → MOSFET\n（カチカチ音をなくす）", 13))
    b.append(arrow([(500, 140), (500, 200)]))
    b.append(arrow([(620, 228), (740, 228)]))
    b.append(tower(800, 90, {"緑": "on"}, 1.1))
    b.append(text(800, 300, "PATLITE積層灯", 13, True))
    b.append(box(40, 200, 220, 56, "PC（USBで中継）", 14, fill="#f2f2f2", color="#666", dash="4 3"))
    b.append(text(150, 282, "↑ これがいらなくなる", 13, True, color=RED))
    return svg(1000, 380, "".join(b))


def sub_colors():
    cases = [("緊急地震速報\n（警報）", {"白": "flash", "赤": "flash"}, "白＋赤・点滅"),
             ("大津波警報", {"白": "flash", "赤": "flash"}, "白＋赤・点滅"),
             ("津波警報", {"白": "flash", "黄": "flash"}, "白＋黄・点滅"),
             ("震度6弱以上", {"白": "on", "赤": "on"}, "白＋赤・点灯"),
             ("自宅の配信の\n重大な障害", {"赤": "flash"}, "赤・点滅→点灯"),
             ("AWSのバックアップ\nで配信中", {"赤": "flash", "青": "flash"}, "赤＋青・点滅→点灯")]
    b = [text(600, 30, "積層灯の光り方（白＝防災情報、赤・黄・青＝システムの状態）", 18, True)]
    for i, (name, on, how) in enumerate(cases):
        cx = 100 + i * 200
        b.append(tower(cx, 75, on, 1.0))
        b.append(text(cx, 290, name, 14, True))
        b.append(text(cx, 330, how, 13, color="#444"))
    b.append(''.join(f'<line x1="{430}" y1="{367 + d * 0.5}" x2="{440}" y2="{367 + d}" stroke="#e53935" stroke-width="2.4" '
                     f'stroke-linecap="round"/>' for d in (-7, 0, 7))
             + text(450, 367, "左右の線＝点滅", 12, anchor="start"))
    b.append(text(640, 367, "正常なときは全部消灯（ランプの並びはイメージです）", 12, anchor="start"))
    return svg(1200, 395, "".join(b))


def sub_cost():
    b = [text(500, 30, "市販のLAN対応積層灯と比べると", 18, True)]
    base, top, full = 360, 110, 153780
    for x, val, lab, col in ((300, 153780, "153,780円（市販・税込の一例）", "#bdbdbd"), (650, 16000, "約16,000円（今回の自作）", GREEN)):
        h = (base - top) * val / full
        b.append(f'<rect x="{x - 70}" y="{base - h}" width="140" height="{h}" fill="{col}"/>')
        b.append(text(x, base - h - 16, lab, 14, True))
    b.append(f'<line x1="150" y1="{base}" x2="850" y2="{base}" stroke="#000"/>')
    b.append(text(300, base + 18, "PATLITE NHV6-4-RYGB", 13) + text(650, base + 18, "中古のPATLITE＋Arduino", 13))
    b.append(box(520, 150, 300, 50, "差は約13万8,000円（約90％安い）", 15, True, fill="#fff8e1", stroke="#ffb020"))
    b.append(text(500, base + 48, "※機能が完全に同じではありません（音声合成などは自作にはありません）", 12, color="#555"))
    return svg(1000, 430, "".join(b))


FIGURES = {
    "main_architecture": main_architecture, "main_dedup": main_dedup, "main_latency": main_latency,
    "main_image_lambda": main_image_lambda,
    "sub_control": sub_control, "sub_future": sub_future, "sub_colors": sub_colors, "sub_cost": sub_cost,
}


def render(name: str, svg_text: str, workdir: Path) -> Path:
    w, h = (int(v) for v in re.search(r'width="(\d+)" height="(\d+)"', svg_text).groups())
    html = workdir / f"{name}.html"
    html.write_text(f'<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;background:#fff}}</style>{svg_text}',
                    encoding="utf-8")
    png = OUT / f"advent2026_{name}.png"
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    f"--user-data-dir={workdir / 'profile'}", f"--window-size={w},{h}", f"--screenshot={png}",
                    html.as_uri()], check=True, timeout=90, capture_output=True)
    return png


def main(names: list[str]) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for name in names or FIGURES:
            print(render(name, FIGURES[name](), Path(tmp)).relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
