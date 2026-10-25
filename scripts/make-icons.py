"""Renders media/icon.png and media/notification.png (no image libraries needed)."""
import math, struct, zlib, sys, os

def png(path, w, h, pixels):
    raw = b''.join(b'\x00' + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

def inside_rounded(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r); cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def dist_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)

def render(size):
    S = 4  # supersampling
    bg_top, bg_bot = (0xE0, 0x8A, 0x6A), (0xC1, 0x5F, 0x3C)
    pad = size * 0.06; radius = size * 0.22
    cx = cy = size / 2
    ray = size * 0.30; thick = size * 0.075
    segs = []
    for k in range(3):
        a = math.pi / 2 + k * math.pi / 3
        segs.append((cx + ray * math.cos(a), cy - ray * math.sin(a), cx - ray * math.cos(a), cy + ray * math.sin(a)))
    px = [0] * (size * size * 4)
    for y in range(size):
        for x in range(size):
            cov_bg = cov_fg = 0
            for sy in range(S):
                for sx in range(S):
                    fx = x + (sx + 0.5) / S; fy = y + (sy + 0.5) / S
                    if inside_rounded(fx, fy, pad, pad, size - pad, size - pad, radius):
                        cov_bg += 1
                        if any(dist_seg(fx, fy, *s) <= thick for s in segs):
                            cov_fg += 1
            n = S * S
            if cov_bg == 0:
                continue
            t = y / size
            bg = [round(bg_top[i] * (1 - t) + bg_bot[i] * t) for i in range(3)]
            f = cov_fg / max(cov_bg, 1)
            col = [round(bg[i] * (1 - f) + 255 * f) for i in range(3)]
            i = (y * size + x) * 4
            px[i:i + 4] = [col[0], col[1], col[2], round(255 * cov_bg / n)]
    return px

root = sys.argv[1]
for name, size in (('icon.png', 128), ('notification.png', 256)):
    png(os.path.join(root, name), size, size, render(size))
    print('wrote', name)
