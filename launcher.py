#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
快速启动 · QuickLaunch
------------------------------------------------
零依赖的本地启动器：漂亮的 Web UI + 真实启动本机程序 / 脚本 / 目录 / 网址。

特点
  * 仅用 Python 标准库，不需要 pip 安装任何东西
  * 只监听 127.0.0.1，带一次性 CSRF token，外部网页无法调用
  * 支持：应用(.exe/.lnk) / 目录 / 网址 / 命令行 / 脚本(.py/.bat/.ps1/.js) / 任意文件
  * 支持以管理员身份运行、指定工作目录、附加参数
  * 支持扫描开始菜单与注册表，一键批量导入已安装软件
  * 支持原生文件 / 目录选择对话框

用法
  python launcher.py                # 默认 8848 端口，自动打开浏览器
  python launcher.py --port 9000    # 指定端口
  python launcher.py --no-open      # 不自动打开浏览器
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------------------------------------------------------------- 常量

BASE = Path(__file__).resolve().parent
WEB = BASE / "web"
CFG_FILE = BASE / "config.json"

IS_WIN = os.name == "nt"
TOKEN = secrets.token_hex(16)
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NO_WINDOW = 0x08000000

VERSION = "1.0.0"

# 分组默认配色
PALETTE = ["#3b6cf6", "#7c5cff", "#12b886", "#ff8a3d",
           "#f2506e", "#14b8c4", "#f0b429", "#8b8f9a"]

TYPE_LABEL = {
    "app": "应用", "folder": "目录", "url": "网址",
    "cmd": "命令", "script": "脚本", "file": "文件",
}


# ---------------------------------------------------------------- 工具

def expand(p: str) -> str:
    """展开 %VAR% 与 ~"""
    if not p:
        return ""
    p = os.path.expandvars(os.path.expanduser(p))
    return p


def exists(p: str) -> bool:
    if not p:
        return False
    p = expand(p)
    if p.lower().startswith(("http://", "https://")):
        return True
    # 纯命令名（如 notepad.exe / wt.exe）交给 PATH 判断
    if not os.path.isabs(p) and not os.path.dirname(p):
        from shutil import which
        return which(p) is not None
    return Path(p).exists()


SHELL_EXT = (".msc", ".cpl", ".appref-ms", ".url")


def item_ok(item: dict) -> bool:
    """判断启动项目标是否还存在（用于前端提示「路径不存在」）"""
    t = item.get("type", "app")
    p = expand((item.get("path") or "").strip())
    if not p:
        return False
    if t == "url":
        return True
    if Path(p).exists():
        return True
    from shutil import which
    if which(p):
        return True
    low = p.lower()
    if low.endswith(SHELL_EXT):
        return True
    # 无目录部分的裸命令交给 shell / PATH 解析，视为可用
    if not os.path.dirname(p) and "." not in os.path.basename(p):
        return True
    return False


def annotate(cfg: dict) -> dict:
    for g in cfg.get("groups", []):
        for i in g.get("items", []):
            try:
                i["_exists"] = item_ok(i)
            except Exception:
                i["_exists"] = True
    return cfg


def strip_index(icon: str) -> str:
    """去掉注册表 DisplayIcon 尾部的 ',0'"""
    if not icon:
        return ""
    icon = icon.strip().strip('"')
    return re.sub(r",\s*-?\d+\s*$", "", icon).strip('"')


# ---------------------------------------------------------------- 默认配置

def default_config() -> dict:
    home = Path.home()
    ts = int(time.time())

    def item(name, icon, type_, path="", **kw):
        data = {
            "id": secrets.token_hex(4),
            "name": name, "icon": icon, "type": type_, "path": path,
            "args": "", "cwd": "", "desc": "", "elevate": False,
            "console": False, "useCount": 0, "lastUsed": 0, "createdAt": ts,
        }
        data.update(kw)
        return data

    def keep(items):
        return [i for i in items if exists(i["path"])]

    groups = [
        {
            "id": "files", "name": "文件与目录", "icon": "📁", "color": PALETTE[0],
            "items": keep([
                item("下载", "📥", "folder", str(home / "Downloads"), desc="Downloads"),
                item("桌面", "🗂️", "folder", str(home / "Desktop"), desc="Desktop"),
                item("文档", "📄", "folder", str(home / "Documents"), desc="Documents"),
                item("工作区", "🧰", "folder", r"D:\WorkBuddy", desc="D:\\WorkBuddy"),
                item("本机磁盘", "💽", "cmd", 'explorer.exe "shell:MyComputerFolder"',
                     desc="资源管理器 · 此电脑"),
            ]),
        },
        {
            "id": "tools", "name": "系统工具", "icon": "🛠️", "color": PALETTE[2],
            "items": keep([
                item("任务管理器", "📊", "app", "taskmgr.exe"),
                item("服务", "🔧", "app", "services.msc"),
                item("设备管理器", "🖨️", "app", "devmgmt.msc"),
                item("注册表编辑器", "🗝️", "app", "regedit.exe"),
                item("计算器", "🧮", "app", "calc.exe"),
                item("记事本", "📝", "app", "notepad.exe"),
                item("终端", "🖥️", "app", "wt.exe"),
                item("控制面板", "🎛️", "cmd", "control.exe", desc="Control Panel"),
            ]),
        },
        {
            "id": "dev", "name": "开发", "icon": "💻", "color": PALETTE[1],
            "items": keep([
                item("VS Code", "💻", "app", r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"),
                item("VS Code", "💻", "app", r"C:\Program Files\Microsoft VS Code\Code.exe"),
                item("PowerShell", "⚡", "app", "powershell.exe"),
                item("命令提示符", "▪️", "app", "cmd.exe"),
                item("Python", "🐍", "app", "python.exe"),
                item("Git Bash", "🐙", "app", r"C:\Program Files\Git\git-bash.exe"),
            ]),
        },
        {
            "id": "web", "name": "常用网站", "icon": "🌐", "color": PALETTE[5],
            "items": [
                item("GitHub", "🐙", "url", "https://github.com/", desc="github.com"),
                item("阿里云控制台", "☁️", "url", "https://ecs.console.aliyun.com/",
                     desc="ecs.console.aliyun.com"),
                item("腾讯云 EdgeOne", "🌀", "url", "https://console.cloud.tencent.com/edgeone",
                     desc="console.cloud.tencent.com"),
                item("WorkBuddy 文档", "📘", "url", "https://www.workbuddy.cn/docs/workbuddy/Overview",
                     desc="workbuddy.cn/docs"),
            ],
        },
    ]

    # 去掉空的候选分组（同一程序可能有多个候选路径，造成重复）
    for g in groups:
        seen, uniq = set(), []
        for i in g["items"]:
            key = (i["name"], i["type"])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(i)
        g["items"] = uniq

    groups = [g for g in groups if g["items"]]

    return {
        "version": 1,
        "settings": {"theme": "light", "density": "cozy", "sort": "custom"},
        "groups": groups,
    }


def load_config() -> dict:
    if not CFG_FILE.exists():
        cfg = default_config()
        save_config(cfg)
        return cfg
    try:
        with open(CFG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict) or "groups" not in cfg:
            raise ValueError("结构不正确")
        cfg.setdefault("settings", {"theme": "light", "density": "cozy", "sort": "custom"})
        return cfg
    except Exception as e:
        # 损坏则备份后重建，避免用户数据静默丢失
        bak = CFG_FILE.with_name(f"config.broken.{int(time.time())}.json")
        try:
            CFG_FILE.replace(bak)
            print(f"[!] config.json 解析失败({e})，已备份到 {bak.name}，重建默认配置")
        except Exception:
            pass
        cfg = default_config()
        save_config(cfg)
        return cfg


def save_config(cfg: dict) -> None:
    tmp = CFG_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    tmp.replace(CFG_FILE)


# ---------------------------------------------------------------- 启动逻辑

def build_argv(item: dict) -> tuple[str, bool]:
    """返回 (命令行字符串, 是否交给 shell)。

    注意：Windows 下 shell=True 时若传 list，Python 会用 list2cmdline
    给整串加引号（cmd /c ""echo a > b""），重定向与管道会失效。
    因此这里统一返回字符串。
    """
    t = item.get("type", "app")
    path = expand(item.get("path", "").strip())
    args = (item.get("args") or "").strip()

    if t == "cmd":
        return f"{path} {args}".strip(), True

    if t == "script":
        ext = Path(path).suffix.lower()
        if ext in (".bat", ".cmd"):
            comspec = os.environ.get("COMSPEC", "cmd.exe")
            return f'"{comspec}" /c "{path}" {args}'.strip(), True
        if ext == ".ps1":
            return (f'powershell.exe -NoProfile -ExecutionPolicy Bypass '
                    f'-File "{path}" {args}').strip(), True
        if ext == ".py":
            return f'"{sys.executable or "python.exe"}" "{path}" {args}'.strip(), False
        if ext == ".js":
            return f'node.exe "{path}" {args}'.strip(), False

    if args:
        return f'"{path}" {args}', False
    return path, False


def launch(item: dict) -> dict:
    t = item.get("type", "app")
    path = expand((item.get("path") or "").strip())
    args = (item.get("args") or "").strip()
    cwd = expand((item.get("cwd") or "").strip())

    if not path:
        return {"ok": False, "msg": "路径为空"}

    try:
        # --- 网址 / 目录 / 文件 / 快捷方式：走 shell 关联 ---
        if t == "url":
            target = path if path.lower().startswith("http") else "http://" + path
            os.startfile(target)  # type: ignore[attr-defined]
            return {"ok": True, "msg": f"已打开 {target}"}

        if t in ("folder", "file"):
            if not Path(path).exists():
                return {"ok": False, "msg": f"路径不存在：{path}"}
            os.startfile(path)  # type: ignore[attr-defined]
            return {"ok": True, "msg": f"已打开 {Path(path).name}"}

        # 参数干净的可执行文件直接交给 shell 关联，兼容 .lnk / UWP / 关联程序
        if t == "app" and not args and not item.get("elevate"):
            if Path(path).exists() and path.lower().endswith(
                    (".exe", ".lnk", ".url", ".bat", ".cmd", ".msc", ".cpl", ".appref-ms")):
                os.startfile(path)  # type: ignore[attr-defined]
                return {"ok": True, "msg": f"已启动 {item.get('name') or Path(path).name}"}

        cmd, use_shell = build_argv(item)

        # --- 需要提权 ---
        if item.get("elevate") and IS_WIN:
            rc = ctypes.windll.shell32.ShellExecuteW(  # type: ignore[attr-defined]
                None, "runas", cmd, None, cwd or None, 1)
            if rc <= 32:
                return {"ok": False, "msg": f"提权启动失败（代码 {rc}）"}
            return {"ok": True, "msg": "已以管理员身份启动"}

        flags = 0
        if IS_WIN:
            if item.get("console"):
                flags |= CREATE_NEW_CONSOLE
            elif use_shell:
                flags |= CREATE_NO_WINDOW

        subprocess.Popen(  # noqa: S603
            cmd,
            shell=use_shell,
            cwd=cwd or None,
            creationflags=flags,
            close_fds=True,
        )
        return {"ok": True, "msg": f"已启动 {item.get('name') or path}"}

    except FileNotFoundError as e:
        return {"ok": False, "msg": f"找不到程序：{e.filename or path}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "msg": f"{type(e).__name__}: {e}"}


def open_containing(path: str) -> dict:
    p = expand(path)
    if not p:
        return {"ok": False, "msg": "路径为空"}
    target = p if Path(p).is_dir() else str(Path(p).parent)
    if not Path(target).exists():
        return {"ok": False, "msg": f"目录不存在：{target}"}
    subprocess.Popen(f'explorer.exe /select,"{p}"', shell=True)
    return {"ok": True, "msg": "已在资源管理器中定位"}


# ---------------------------------------------------------------- 扫描

SCAN_CACHE: dict = {"ts": 0, "data": []}
SKIP_WORDS = ("卸载", "uninstall", "readme", "帮助", "help", "文档",
              "license", "许可", "changelog", "更新日志", "官方网站", "website")


def scan_start_menu() -> list[dict]:
    out: list[dict] = []
    roots = [
        os.path.join(os.environ.get("ProgramData", ""), r"Microsoft\Windows\Start Menu\Programs"),
        os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs"),
    ]
    for root in roots:
        if not root or not Path(root).exists():
            continue
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                depth = len(Path(dirpath).relative_to(root).parts)
                if depth >= 3:
                    dirnames[:] = []
                for fn in filenames:
                    if not fn.lower().endswith((".lnk", ".url")):
                        continue
                    name = Path(fn).stem
                    low = name.lower()
                    if any(w in low for w in SKIP_WORDS):
                        continue
                    out.append({
                        "name": name,
                        "path": os.path.join(dirpath, fn),
                        "type": "app",
                        "source": "开始菜单",
                    })
        except Exception:
            continue
    return out


def scan_registry() -> list[dict]:
    if not IS_WIN:
        return []
    try:
        import winreg
    except ImportError:
        return []

    out: list[dict] = []
    roots = []
    for hive, sub in (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ):
        try:
            roots.append(winreg.OpenKey(hive, sub))
        except OSError:
            continue

    def val(key, name):
        try:
            v, _ = winreg.QueryValueEx(key, name)
            return v
        except OSError:
            return None

    for root in roots:
        idx = 0
        while True:
            try:
                sub = winreg.EnumKey(root, idx)
            except OSError:
                break
            idx += 1
            try:
                k = winreg.OpenKey(root, sub)
            except OSError:
                continue
            try:
                if val(k, "SystemComponent"):
                    continue
                name = val(k, "DisplayName")
                icon = strip_index(val(k, "DisplayIcon") or "")
                loc = val(k, "InstallLocation") or ""
                if not name or not icon:
                    continue
                if not icon.lower().endswith(".exe") or not Path(icon).exists():
                    continue
                out.append({"name": str(name), "path": icon,
                            "type": "app", "source": "注册表"})
            except Exception:
                pass
            finally:
                k.Close()
    return out


def do_scan(force: bool = False) -> list[dict]:
    if not force and time.time() - SCAN_CACHE["ts"] < 120 and SCAN_CACHE["data"]:
        return SCAN_CACHE["data"]

    items = scan_start_menu() + scan_registry()
    seen, uniq = set(), []
    for it in items:
        key = (it["name"].lower(), it["path"].lower())
        base = Path(it["path"]).stem.lower()
        if key in seen or base in seen:
            continue
        seen.add(key)
        seen.add(base)
        uniq.append(it)
    uniq.sort(key=lambda x: x["name"].lower())
    uniq = uniq[:400]
    SCAN_CACHE.update(ts=time.time(), data=uniq)
    return uniq


# ---------------------------------------------------------------- 原生选择框

def _co_init():
    if IS_WIN:
        try:
            ctypes.windll.ole32.CoInitialize(None)  # type: ignore[attr-defined]
        except Exception:
            pass


def pick_file() -> str:
    if not IS_WIN:
        return ""
    _co_init()
    from ctypes import wintypes

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE), ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD), ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD), ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", ctypes.c_void_p), ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]

    OFN_FILEMUSTEXIST = 0x00001000
    OFN_PATHMUSTEXIST = 0x00000800
    OFN_EXPLORER = 0x00080000
    OFN_NOCHANGEDIR = 0x00000008

    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(ofn)
    buf = ctypes.create_unicode_buffer(4096)
    ofn.lpstrFile = buf
    ofn.nMaxFile = 4096
    ofn.lpstrFilter = "程序或快捷方式\0*.exe;*.lnk;*.bat;*.cmd;*.py;*.ps1;*.url\0所有文件\0*.*\0\0"
    ofn.lpstrTitle = "选择要启动的文件"
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_NOCHANGEDIR
    if ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):  # type: ignore[attr-defined]
        return buf.value
    return ""


def pick_dir() -> str:
    if not IS_WIN:
        return ""
    _co_init()
    from ctypes import wintypes

    class BROWSEINFO(ctypes.Structure):
        _fields_ = [
            ("hwndOwner", wintypes.HWND), ("pidlRoot", ctypes.c_void_p),
            ("pszDisplayName", wintypes.LPWSTR), ("lpszTitle", wintypes.LPCWSTR),
            ("ulFlags", wintypes.UINT), ("lpfn", ctypes.c_void_p),
            ("lParam", wintypes.LPARAM), ("iImage", ctypes.c_int),
        ]

    BIF_RETURNONLYFSDIRS = 0x0001
    BIF_NEWDIALOGSTYLE = 0x0040
    bi = BROWSEINFO()
    bi.lpszTitle = "选择文件夹"
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
    shell32 = ctypes.windll.shell32  # type: ignore[attr-defined]
    pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
    if not pidl:
        return ""
    try:
        path_buf = ctypes.create_unicode_buffer(1024)
        if shell32.SHGetPathFromIDListW(pidl, path_buf):
            return path_buf.value
        return ""
    finally:
        try:
            ctypes.windll.ole32.CoTaskMemFree(pidl)  # type: ignore[attr-defined]
        except Exception:
            pass


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = f"QuickLaunch/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ---- 低层工具
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _err(self, code: int, msg: str):
        self._json({"ok": False, "msg": msg}, code)

    def log_message(self, fmt, *args):  # 安静一点
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s %s\n" % (self.command, self.path.split("?")[0]))

    # ---- 安全
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1", "")

    def _token_ok(self) -> bool:
        return self.headers.get("X-QL-Token", "") == TOKEN

    # ---- GET
    def do_GET(self):  # noqa: N802
        if not self._host_ok():
            return self._err(403, "非法 Host")
        path = self.path.split("?")[0]

        if path == "/api/ping":
            return self._json({"ok": True, "version": VERSION, "host": socket.gethostname(),
                               "time": time.strftime("%Y-%m-%d %H:%M:%S")})
        if path == "/api/config":
            return self._json({"ok": True, "config": annotate(load_config())})

        if path in ("/", "/index.html"):
            return self._serve_html()
        return self._serve_static(path)

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def _serve_html(self):
        idx = WEB / "index.html"
        if not idx.exists():
            return self._err(500, "缺少 web/index.html")
        html = idx.read_text(encoding="utf-8").replace("__QL_TOKEN__", TOKEN)
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def _serve_static(self, path: str):
        rel = path.lstrip("/")
        if ".." in rel or rel.startswith("/"):
            return self._err(400, "非法路径")
        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            return self._err(403, "越界")
        if not target.is_file():
            return self._err(404, "未找到")
        ctype = {".html": "text/html; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".json": "application/json; charset=utf-8",
                 ".svg": "image/svg+xml",
                 ".png": "image/png",
                 ".ico": "image/x-icon"}.get(target.suffix.lower(),
                                             "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    # ---- POST
    def do_POST(self):  # noqa: N802
        if not self._host_ok():
            return self._err(403, "非法 Host")
        if not self._token_ok():
            return self._err(403, "缺少令牌")

        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:  # noqa: BLE001
            return self._err(400, f"请求体解析失败：{e}")

        path = self.path.split("?")[0]

        if path == "/api/config":
            try:
                cfg = data.get("config") or {}
                if not isinstance(cfg, dict) or "groups" not in cfg:
                    return self._err(400, "配置结构不正确")
                save_config(cfg)
                return self._json({"ok": True})
            except Exception as e:  # noqa: BLE001
                return self._err(500, f"保存失败：{e}")

        if path == "/api/run":
            item = data.get("item")
            cfg = load_config()
            if not item:
                iid = data.get("id")
                for g in cfg["groups"]:
                    for i in g["items"]:
                        if i["id"] == iid:
                            item = i
                            break
            if not item:
                return self._err(404, "找不到启动项")

            res = launch(item)
            res["name"] = item.get("name", "")
            if res.get("ok") and item.get("id") and not data.get("dry"):
                # 记录使用次数 / 最近使用 / 运行结果
                item["useCount"] = int(item.get("useCount") or 0) + 1
                item["lastUsed"] = int(time.time())
                for g in cfg["groups"]:
                    for i in g["items"]:
                        if i.get("id") == item["id"]:
                            i["useCount"] = item["useCount"]
                            i["lastUsed"] = item["lastUsed"]
                try:
                    save_config(cfg)
                except Exception:
                    pass
            return self._json(res)

        if path == "/api/folder":
            return self._json(open_containing(data.get("path", "")))

        if path == "/api/scan":
            try:
                items = do_scan(force=bool(data.get("force")))
                return self._json({"ok": True, "items": items, "count": len(items)})
            except Exception as e:  # noqa: BLE001
                return self._err(500, f"扫描失败：{e}")

        if path == "/api/pick":
            kind = data.get("kind", "file")
            try:
                p = pick_dir() if kind == "dir" else pick_file()
                return self._json({"ok": True, "path": p})
            except Exception as e:  # noqa: BLE001
                return self._err(500, f"打开选择框失败：{e}")

        if path == "/api/quit":
            self._json({"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
            return

        return self._err(404, "未知接口")


# ---------------------------------------------------------------- 入口

def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(preferred: int) -> int:
    if port_free(preferred):
        return preferred
    for p in range(preferred + 1, preferred + 40):
        if port_free(p):
            return p
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser(description="快速启动 · 本地启动器")
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    port = pick_port(args.port)
    url = f"http://127.0.0.1:{port}/"

    if not CFG_FILE.exists():
        load_config()  # 生成默认配置

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True

    print("=" * 58)
    print(f"  🚀  快速启动 QuickLaunch v{VERSION}")
    print(f"  地址   {url}")
    print(f"  配置   {CFG_FILE}")
    print(f"  停止   在此窗口按 Ctrl + C")
    print("=" * 58)

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
