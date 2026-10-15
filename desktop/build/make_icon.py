# -*- coding: utf-8 -*-
"""生成 QuickLaunch 图标：build/icon.ico + build/icon.png

设计：蓝紫渐变圆角方底 + 白色火箭（指向右上，象征「启动」）
      火箭舷窗为镂空，透出底色。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
S = 1024
C1 = (59, 108, 246)     # #3b6cf6
C2 = (124, 92, 255)     # #7c5cff

# 竖直朝上的火箭（归一化坐标，y 向下）
BODY = [(0.500, 0.020), (0.600, 0.300), (0.600, 0.620), (0.400, 0.620), (0.400, 0.300)]
FIN_L = [(0.400, 0.450), (0.215, 0.770), (0.400, 0.660)]
FIN_R = [(0.600, 0.450), (0.785, 0.770), (0.600, 0.660)]
FLAME = [(0.500, 0.982), (0.402, 0.620), (0.598, 0.620)]
WINDOW = (0.500, 0.340, 0.075)   # cx, cy, r


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def pt(u, v, scale=1.0):
    """归一化 → 像素，并围绕中心缩放"""
    cx = cy = 0.5
    u = cx + (u - cx) * scale
    v = cy + (v - cy) * scale
    return (round(u * S), round(v * S))


def main():
    # ---------- 渐变底 ----------
    grad = Image.new("RGB", (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            px[x, y] = lerp(C1, C2, x / S * 0.55 + y / S * 0.45)

    # 左上角高光，增加质感
    glow = Image.new("L", (S, S), 0)
    ImageDraw.Draw(glow).ellipse([-S * 0.6, -S * 0.8, S * 0.9, S * 0.5], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.11))
    grad = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), grad,
                           glow.point(lambda v: int(v * 0.40)))

    # ---------- 圆角遮罩 ----------
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # ---------- 火箭（先竖直画好，再整体旋转） ----------
    gly = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(gly)
    sc = 0.98
    for poly in (FIN_L, FIN_R, FLAME, BODY):
        d.polygon([pt(u, v, sc) for u, v in poly], fill=255)

    # 舷窗镂空
    cx, cy, r = WINDOW
    cx, cy = 0.5 + (cx - 0.5) * sc, 0.5 + (cy - 0.5) * sc
    r *= sc
    d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=0)

    gly = gly.filter(ImageFilter.GaussianBlur(S * 0.0045))

    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    img = Image.alpha_composite(img, Image.composite(white, Image.new("RGBA", (S, S), (0, 0, 0, 0)), gly))

    # ---------- 输出 ----------
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))
    img.save(os.path.join(OUT, "icon.ico"),
             sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icon.ico / icon.png 已生成于", OUT)


if __name__ == "__main__":
    main()
