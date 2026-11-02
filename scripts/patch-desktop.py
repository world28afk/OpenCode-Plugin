#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# scripts/patch-desktop.py
#
# OpenCode Desktop 桌面注入补丁 —— 跨平台版（macOS / Windows, 无 Node 依赖）
#
# 作用与各插件自带的 scripts/patch-desktop.mjs（Node + npx @electron/asar）等效:
#   1) renderer 注入: 把 desktop/*-inject.js / *-dock.js 写入 app.asar 的 renderer 目录,
#      并在 index.html 里加 <script> 标签;
#   2) main 注入: 把 desktop/*-tray.js 追加到主进程入口（默认 out/main/index.js）,
#      用 /* <插件>:tray:start */ … /* <插件>:tray:end */ 标记包裹（当前为 oc-exit 托盘）。
# 区别:
#   • 纯 Python 3 标准库, 不需要 node / npm / npx（macOS 上通常没有 node）;
#   • 一次运行可以同时修补多个插件（共用同一个 app.asar, 不重复提取/重打包 124MB 文件）;
#   • 追加式改写: 旧数据区按原样保留, 新条目追加到 asar 末尾 —— 各文件既有 offset 不变,
#     正在运行的桌面端不受影响（重启后生效）;
#   • --in-place 会把 header 区块补齐到与原来完全相同的长度, 因此运行中的实例缓存的
#     data_start / offset 全部继续有效（这是「不重启也能安全写盘」的关键）;
#   • 与 .mjs 完全互相兼容: 相同的标签、插入位置与备份文件名, 两边都可以 --restore / --unpatch。
#
# 适用插件:
#   renderer 注入: oc-cyberbot / oc-deepseek-banlance / oc-plugin-manager / oc-purge
#   main   注入: oc-exit（Windows 系统托盘, 注入 out/main/index.js）
#   oc-infinite-gen-4 已停用（见 DISABLED_PLUGINS, 不再注入）。
#
# 用法:
#   python3 scripts/patch-desktop.py                     # 注入全部（自动备份, 原子替换）
#   python3 scripts/patch-desktop.py --in-place          # 桌面端运行中原地热更新（重启后生效）
#   python3 scripts/patch-desktop.py --dry-run           # 只验证, 不改动安装
#   python3 scripts/patch-desktop.py --only oc-purge oc-exit
#   python3 scripts/patch-desktop.py --unpatch                           # 移除全部注入
#   python3 scripts/patch-desktop.py --unpatch oc-deepseek-banlance      # 只移除指定插件
#   python3 scripts/patch-desktop.py --restore           # 从首次备份还原
#   python3 scripts/patch-desktop.py --app <asar路径>    # 指定 app.asar（默认按平台探测）
#
# macOS 备注:
#   • 默认路径 /Applications/OpenCode.app/Contents/Resources/app.asar;
#   • 打补丁不要求退出桌面端（原子替换, 运行中的实例继续用旧文件, 重启后生效）;
#   • 若系统对改过的应用报「已损坏」（quarantine 标记）, 执行:
#     xattr -dr com.apple.quarantine /Applications/OpenCode.app
#   • 桌面端自动更新（替换 bundle）后需重新执行本脚本。

import argparse
import hashlib
import json
import os
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

# 控制台编码兜底：某些中文 Windows（GBK）控制台无法打印 ✓/✗ 等符号，
# 若不处理会在输出校验结果时抛 UnicodeEncodeError 中断脚本。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
INJECT_SUFFIXES = ("-inject.js", "-dock.js")  # 兼容 *.mjs 各插件的命名（-inject.js / -dock.js）
MAIN_INJECT_SUFFIX = "-tray.js"              # 主进程注入（oc-exit 系统托盘）
BLOCK_SIZE = 4194304  # 与 @electron/asar 的 integrity 分块一致（4 MiB）

# 已停用/除名的插件：源码保留，但不再注入桌面端（防止全量重打把旧 UI 又注回去）。
# oc-infinite-gen-4 已从 OpenCode 移除（badge UI 亦已从 app.asar 清理）。
DISABLED_PLUGINS = {"oc-infinite-gen-4"}

# 主进程注入清单：文件名 → 标记与目标文件。
# 标记必须与各插件自带 patch-desktop.mjs 完全一致，两边才能互相 --unpatch。
MAIN_INJECTS = {
    "oc-exit-tray.js": {
        "mark_start": "/* oc-exit:tray:start */",
        "mark_end": "/* oc-exit:tray:end */",
        "target": "out/main/index.js",
    },
}


class AsarError(RuntimeError):
    pass


def fail(message: str) -> None:
    print(f"error: {message}")
    sys.exit(1)


# ---------------------------------------------------------------------------
# 插件发现
# ---------------------------------------------------------------------------

def discover_plugins():
    """扫描工作区内的插件注入片段: oc-*/desktop/*-inject.js（renderer）+ *-tray.js（main）。"""
    plugins = []
    for child in sorted(REPO_ROOT.iterdir()):
        if not child.is_dir() or not child.name.startswith("oc-"):
            continue
        if child.name in DISABLED_PLUGINS:
            continue
        desktop = child / "desktop"
        if not desktop.is_dir():
            continue
        for suffix in INJECT_SUFFIXES:
            for source in sorted(desktop.glob(f"*{suffix}")):
                base = source.name[: -len(suffix)]  # 例: oc-balance-inject.js -> oc-balance
                plugins.append(
                    {
                        "kind": "renderer",
                        "name": child.name,                 # 目录名, 例: oc-deepseek-banlance
                        "source": source,                   # desktop/oc-balance-inject.js
                        "inject_name": source.name,         # 注入到 renderer 的文件名
                        "backup_suffix": f".{base}.bak",    # 与 .mjs 一致: app.asar.oc-balance.bak
                    }
                )
        for source in sorted(desktop.glob(f"*{MAIN_INJECT_SUFFIX}")):
            spec = MAIN_INJECTS.get(source.name)
            if not spec:
                print(f"warning: 未登记的主进程注入片段, 已跳过: {source}")
                continue
            base = source.name[: -len(MAIN_INJECT_SUFFIX)]  # oc-exit-tray.js -> oc-exit
            plugins.append(
                {
                    "kind": "main",
                    "name": child.name,
                    "source": source,
                    "inject_name": source.name,
                    "backup_suffix": f".{base}.bak",
                    "mark_start": spec["mark_start"],
                    "mark_end": spec["mark_end"],
                    "target": spec["target"].strip("/"),
                }
            )
    return plugins


def select(plugins, names):
    if not names:
        return plugins
    wanted = set(names)
    chosen = [p for p in plugins if p["name"] in wanted]
    missing = sorted(wanted - {p["name"] for p in chosen})
    if missing:
        available = ", ".join(p["name"] for p in plugins)
        fail(f"未知插件: {', '.join(missing)}（可用: {available}）")
    return chosen


def describe(plugins):
    return ", ".join(f"{p['name']}({p['kind']})" for p in plugins)


# ---------------------------------------------------------------------------
# app.asar 默认路径（与 .mjs 的 defaultApp 对应, 增加 macOS 探测）
# ---------------------------------------------------------------------------

def default_app_asar():
    if sys.platform == "darwin":
        return Path("/Applications/OpenCode.app/Contents/Resources/app.asar")
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        # 新版桌面版目录改为 ai.opencode.desktop，旧版为 @opencodedesktop；按存在性优先探测
        candidates = [
            Path(local) / "Programs" / "ai.opencode.desktop" / "resources" / "app.asar",
            Path(local) / "Programs" / "@opencodedesktop" / "resources" / "app.asar",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return candidates[0]
    return None


# ---------------------------------------------------------------------------
# asar 读写（header = Pickle: u32[4] / u32[4+payload] / u32[payload] / u32[strlen] / json[padded]）
# 格式要点（与 @electron/asar 产物一致）:
#   • 文件条目的 offset 以字符串存储, size 为整数;
#   • 条目可带 integrity: {algorithm:SHA256, hash:sha256(内容), blockSize, blocks:[分块 sha256]};
#   • 数据区从 header 之后开始, offset 相对数据区起点。
# ---------------------------------------------------------------------------

def parse_asar(blob: bytes):
    if len(blob) < 16 or struct.unpack("<I", blob[0:4])[0] != 4:
        raise AsarError("不是有效的 asar 文件（头部格式不符）")
    strlen = struct.unpack("<I", blob[12:16])[0]
    if 16 + strlen > len(blob):
        raise AsarError("asar 头部长度异常")
    header = json.loads(blob[16 : 16 + strlen].decode("utf-8"))
    pad = (4 - strlen % 4) % 4
    return header, 16 + strlen + pad


def build_header(header, pad_to=None) -> bytes:
    """序列化 header。

    pad_to: 期望的 header 区块总字节数（必须是 4 的倍数）。
            JSON 允许尾随空白，用空格补齐即可让 data_start 保持不变 ——
            这样运行中的桌面端缓存的 offset 仍然指向正确的数据。
    """
    data = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if pad_to is not None:
        want = pad_to - 16
        if len(data) > want:
            raise AsarError(f"header 比原区块长 {len(data) - want} 字节, 无法等长填充")
        data = data + b" " * (want - len(data))
    pad = (4 - len(data) % 4) % 4
    payload = 4 + len(data) + pad
    return (
        struct.pack("<I", 4)
        + struct.pack("<I", 4 + payload)
        + struct.pack("<I", payload)
        + struct.pack("<I", len(data))
        + data
        + b"\x00" * pad
    )


def iter_entries(files, prefix=""):
    for name, entry in files.items():
        path = prefix + "/" + name
        if "files" in entry:
            yield from iter_entries(entry["files"], path)
        else:
            yield path, entry


def entry_map(header):
    return dict(iter_entries(header["files"]))


def dir_node(header, parts):
    node = header
    for part in parts:
        node = node["files"][part]
    return node


def read_file(blob: bytes, data_start: int, entry) -> bytes:
    off, size = int(entry["offset"]), int(entry["size"])
    return blob[data_start + off : data_start + off + size]


def integrity_of(content: bytes) -> dict:
    blocks = [
        hashlib.sha256(content[i : i + BLOCK_SIZE]).hexdigest()
        for i in range(0, len(content), BLOCK_SIZE)
    ]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(content).hexdigest(),
        "blockSize": BLOCK_SIZE,
        "blocks": blocks,
    }


def find_renderer_index(header) -> str:
    """与 .mjs 相同的选择规则: 优先路径含 renderer, 其次路径最短。"""
    candidates = [path for path, _ in iter_entries(header["files"]) if path.endswith("index.html")]
    if not candidates:
        raise AsarError("asar 中未找到 index.html")
    candidates.sort(key=lambda p: (0 if "renderer" in p else 1, len(p)))
    return candidates[0]


def strip_block(text: str, mark_start: str, mark_end: str) -> str:
    start_index = text.find(mark_start)
    if start_index < 0:
        return text
    end_index = text.find(mark_end, start_index)
    if end_index < 0:
        return text
    return text[:start_index] + text[end_index + len(mark_end) :]


class Appender:
    """把新内容追加到数据区末尾, 并更新对应条目（旧数据原样保留）。"""

    def __init__(self, data: bytes):
        self.data = data
        self.appended = bytearray()

    def put(self, entry, content: bytes) -> int:
        offset = len(self.data) + len(self.appended)
        self.appended += content
        entry["offset"] = str(offset)
        entry["size"] = len(content)
        entry["integrity"] = integrity_of(content)
        return offset


# ---------------------------------------------------------------------------
# 计划（注入 / 移除）：只改 header JSON + 在数据区末尾追加新内容, 既有条目 offset 不动。
# ---------------------------------------------------------------------------

def plan_apply(blob: bytes, header, data_start: int, renderer_plugins, main_plugins):
    data = blob[data_start:]
    appender = Appender(data)
    index_path = None
    inserted = []
    main_changed = []

    if renderer_plugins:
        index_path = find_renderer_index(header)
        live_index = entry_map(header)[index_path]
        html = read_file(blob, data_start, live_index).decode("utf-8")

        parent_parts = [p for p in index_path.rsplit("/", 1)[0].strip("/").split("/") if p]
        parent = dir_node(header, parent_parts) if parent_parts else header["files"]

        for plugin in renderer_plugins:
            name = plugin["inject_name"]
            content = plugin["source"].read_bytes()
            if name not in html:
                tag = f'  <script src="./{name}"></script>\n'
                if "</body>" in html:
                    html = html.replace("</body>", tag + "</body>", 1)
                elif "</head>" in html:
                    html = html.replace("</head>", tag + "</head>", 1)
                else:
                    html += tag
                inserted.append(name)
            appender.put(parent["files"].setdefault(name, {}), content)

        html_bytes = html.encode("utf-8")
        appender.put(live_index, html_bytes)

    for plugin in main_plugins:
        target = plugin["target"]
        entry = entry_map(header).get("/" + target)
        if entry is None:
            raise AsarError(f"asar 中未找到主进程入口: /{target}")
        text = read_file(blob, data_start, entry).decode("utf-8")
        text = strip_block(text, plugin["mark_start"], plugin["mark_end"])  # 幂等
        snippet = plugin["source"].read_text(encoding="utf-8")
        block = f"\n;{plugin['mark_start']}\n{snippet}\n;{plugin['mark_end']}\n"
        appender.put(entry, (text + block).encode("utf-8"))
        main_changed.append(target)

    return header, appender.appended, index_path, inserted, main_changed


def plan_unpatch(blob: bytes, header, data_start: int, renderer_plugins, main_plugins):
    data = blob[data_start:]
    appender = Appender(data)
    index_path = None
    removed = []
    main_changed = []

    if renderer_plugins:
        index_path = find_renderer_index(header)
        live_index = entry_map(header)[index_path]
        html = read_file(blob, data_start, live_index).decode("utf-8")
        names = {p["inject_name"] for p in renderer_plugins}

        html_changed = any(n in html for n in names)
        if html_changed:
            html = "\n".join(line for line in html.split("\n") if not any(n in line for n in names))
            appender.put(live_index, html.encode("utf-8"))

        parent_parts = [p for p in index_path.rsplit("/", 1)[0].strip("/").split("/") if p]
        parent = dir_node(header, parent_parts) if parent_parts else header["files"]
        for plugin in renderer_plugins:
            if plugin["inject_name"] in parent["files"]:
                del parent["files"][plugin["inject_name"]]
                removed.append(plugin["inject_name"])

        if not html_changed and not removed:
            index_path = None

    for plugin in main_plugins:
        target = plugin["target"]
        entry = entry_map(header).get("/" + target)
        if entry is None:
            continue
        text = read_file(blob, data_start, entry).decode("utf-8")
        next_text = strip_block(text, plugin["mark_start"], plugin["mark_end"])
        if next_text == text:
            continue
        appender.put(entry, next_text.encode("utf-8"))
        main_changed.append(target)

    if index_path is None and not main_changed:
        return None, None, removed, main_changed
    return header, appender.appended, index_path, removed, main_changed


# ---------------------------------------------------------------------------
# 校验：把写出的内容重新解析, 逐项核对
# ---------------------------------------------------------------------------

def validate(blob: bytes, renderer_plugins, main_plugins, mode: str):
    header, data_start = parse_asar(blob)
    emap = entry_map(header)
    checks = []

    if renderer_plugins:
        index_path = find_renderer_index(header)
        parent_dir = index_path.rsplit("/", 1)[0]
        html = read_file(blob, data_start, emap[index_path]).decode("utf-8")
        for plugin in renderer_plugins:
            name = plugin["inject_name"]
            full_path = f"{parent_dir}/{name}"
            if mode == "unpatch":
                checks.append((f"index.html 不再引用 {name}", name not in html))
                checks.append((f"条目已移除: {name}", full_path not in emap))
            else:
                checks.append((f"index.html 引用 {name}", name in html))
                entry = emap.get(full_path)
                same = entry is not None and read_file(blob, data_start, entry) == plugin["source"].read_bytes()
                checks.append((f"注入文件内容一致: {name}", same))

    for plugin in main_plugins:
        entry = emap.get("/" + plugin["target"])
        if entry is None:
            checks.append((f"主进程入口存在: /{plugin['target']}", False))
            continue
        text = read_file(blob, data_start, entry).decode("utf-8")
        if mode == "unpatch":
            checks.append((f"{plugin['target']} 已移除 {plugin['name']} 注入块", plugin["mark_start"] not in text))
        else:
            snippet = plugin["source"].read_text(encoding="utf-8")
            checks.append((f"{plugin['target']} 含 {plugin['name']} 注入块", plugin["mark_start"] in text))
            checks.append((f"{plugin['target']} 注入内容完整: {plugin['name']}", snippet in text))
    return checks


# ---------------------------------------------------------------------------
# 命令
# ---------------------------------------------------------------------------

def do_restore(app: Path, plugins):
    for plugin in plugins:
        backup = Path(str(app) + plugin["backup_suffix"])
        if backup.exists():
            shutil.copy2(backup, app)
            print(f"已还原: {app}")
            print(f"备份保留在: {backup}（可手动删除）")
            return
    fail("没有找到任何备份（app.asar.<插件>.bak）")


def run(args):
    plugins = discover_plugins()
    if not plugins:
        fail("未发现任何 desktop/*-inject.js 或 desktop/*-tray.js 注入片段")

    print("插件      : " + describe(plugins))
    if args.only:
        plugins = select(plugins, args.only)
        print("选择      : " + describe(plugins))

    renderer_plugins = [p for p in plugins if p["kind"] == "renderer"]
    main_plugins = [p for p in plugins if p["kind"] == "main"]

    app = Path(args.app).expanduser() if args.app else default_app_asar()
    if app is None:
        fail("当前平台没有默认安装路径, 请用 --app <app.asar> 指定")
    if not app.exists():
        fail(f"找不到 app.asar: {app}（可用 --app <路径> 指定）")
    print(f"app.asar  : {app}")

    if args.restore:
        print("模式      : 还原")
        do_restore(app, plugins)
        return

    blob = app.read_bytes()
    header, data_start = parse_asar(blob)

    if args.unpatch is not None:
        targets = select(plugins, args.unpatch)
        targets_renderer = [p for p in targets if p["kind"] == "renderer"]
        targets_main = [p for p in targets if p["kind"] == "main"]
        print("模式      : 移除注入")
        header, appended, index_path, removed, main_changed = plan_unpatch(
            blob, header, data_start, targets_renderer, targets_main
        )
        if header is None:
            print("未发现本插件注入, 无需移除")
            return
        if index_path:
            print(f"renderer  : {index_path}")
        for name in removed:
            print(f"已移除标签与文件: {name}")
        for name in main_changed:
            print(f"已移除主进程注入块: {name}")
        validate_mode = "unpatch"
        targets = targets_renderer + targets_main
    else:
        targets = plugins
        print("模式      : " + ("dry-run（不改动安装）" if args.dry_run else "注入"))
        header, appended, index_path, inserted, main_changed = plan_apply(
            blob, header, data_start, renderer_plugins, main_plugins
        )
        if index_path:
            print(f"renderer  : {index_path}")
        for name in inserted:
            print(f"已写入 <script> 标签: {name}")
        for name in main_changed:
            print(f"已写入主进程注入块: {name}")
        validate_mode = "apply"
        targets = plugins

    pad_to = data_start if args.in_place else None
    if args.in_place and args.unpatch is not None:
        fail("--in-place 只支持注入模式")
    try:
        header_block = build_header(header, pad_to=pad_to)
    except AsarError as exc:
        if pad_to is None:
            raise
        # 兜底: 去掉被改动条目的 integrity 以缩短 header（读取不依赖 integrity）
        for plugin in targets:
            entry = None
            if plugin["kind"] == "main":
                entry = entry_map(header).get("/" + plugin["target"])
            if entry is not None:
                entry.pop("integrity", None)
        try:
            header_block = build_header(header, pad_to=pad_to)
            print("提示      : 为等长写入已省略被改动条目的 integrity 字段（不影响读取）")
        except AsarError as exc2:
            fail(f"{exc2}；请完全退出 OpenCode Desktop 后重新执行（去掉 --in-place）")

    patched = header_block + blob[data_start:] + bytes(appended)

    if args.dry_run:
        target = Path(tempfile.gettempdir()) / f"oc-patch-desktop-test-{int(time.time())}.asar"
        target.write_bytes(patched)
        print(f"写入中… → (测试产物) {target}")
        checks = validate(
            target.read_bytes(),
            [p for p in targets if p["kind"] == "renderer"],
            [p for p in targets if p["kind"] == "main"],
            validate_mode,
        )
        for label, ok in checks:
            print(f"  [{'✓' if ok else '✗'}] {label}")
        if not all(ok for _, ok in checks):
            fail("dry-run 校验失败")
        print(f"dry-run 完成（未改动安装）。测试产物: {target}")
        return

    if args.unpatch is None:
        for plugin in targets:
            backup = Path(str(app) + plugin["backup_suffix"])
            if not backup.exists():
                shutil.copy2(app, backup)
                print(f"已备份  : {backup}")

    if args.in_place:
        # 原地热更新：header 区块长度不变 → data_start 不变 → 运行中的实例不受影响。
        # 顺序 = 先追加数据区（旧 header 仍然有效）→ 再覆盖 header → 最后校正长度，
        # 因此运行中的桌面端在重启前仍读到旧内容，不会读到错位数据。
        try:
            with open(app, "r+b") as fh:
                fh.seek(len(blob))
                fh.write(bytes(appended))
                fh.flush()
                fh.seek(0)
                fh.write(header_block)
                fh.truncate(len(blob) + len(appended))
                fh.flush()
        except OSError as exc:
            fail(f"原地写入失败: {exc}")
        print(f"原地热更新: 追加 {len(appended)} 字节（header 长度不变, 已有条目偏移全部保留）")
    else:
        tmp = app.parent / f".{app.name}.tmp-{os.getpid()}.asar"
        try:
            tmp.write_bytes(patched)
        except OSError as exc:
            fail(f"无法在安装目录写入临时文件: {exc}")
        try:
            os.replace(tmp, app)
        except PermissionError:
            try:
                tmp.unlink()
            except OSError:
                pass
            fail(
                "写入失败（文件被占用）。请完全退出 OpenCode Desktop 后重试；"
                "或在桌面端运行时加 --in-place 做原地热更新"
            )

    checks = validate(
        app.read_bytes(),
        [p for p in targets if p["kind"] == "renderer"],
        [p for p in targets if p["kind"] == "main"],
        validate_mode,
    )
    for label, ok in checks:
        print(f"  [{'✓' if ok else '✗'}] {label}")
    if not all(ok for _, ok in checks):
        fail("校验失败 —— 可用 --restore 从备份还原")

    if args.unpatch is not None:
        print("移除完成。重新启动 OpenCode Desktop 后生效。")
    else:
        print("注入完成。重新启动 OpenCode Desktop 后生效。")
        print("如需移除: python3 scripts/patch-desktop.py --unpatch")


def main():
    parser = argparse.ArgumentParser(
        description="OpenCode Desktop 桌面注入补丁（跨平台 / 无 Node）",
        epilog="macOS: 默认修补 /Applications/OpenCode.app/Contents/Resources/app.asar；"
        "桌面端更新后需重新执行。",
    )
    parser.add_argument("--app", help="指定 app.asar 路径（默认按平台探测）")
    parser.add_argument("--dry-run", action="store_true", help="只验证, 不改动安装")
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="桌面端仍在运行时原地热更新（追加式 + header 等长填充, 重启后生效）",
    )
    parser.add_argument("--restore", action="store_true", help="从首次备份还原")
    parser.add_argument(
        "--unpatch",
        nargs="*",
        metavar="插件",
        help="移除注入（可指定插件目录名, 缺省为全部）",
    )
    parser.add_argument(
        "--only",
        nargs="*",
        metavar="插件",
        help="只处理指定插件目录名（缺省为全部）",
    )
    run(parser.parse_args())


if __name__ == "__main__":
    main()
