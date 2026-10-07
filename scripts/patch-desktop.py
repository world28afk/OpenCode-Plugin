#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# scripts/patch-desktop.py
#
# OpenCode Desktop 桌面注入补丁 —— 跨平台版（macOS / Windows, 无 Node 依赖）
#
# 作用与各插件自带的 scripts/patch-desktop.mjs（Node + npx @electron/asar）等效:
# 把 desktop/*-inject.js 写入 app.asar 的 renderer 目录, 并在 index.html 里加 <script> 标签。
# 区别:
#   • 纯 Python 3 标准库, 不需要 node / npm / npx（macOS 上通常没有 node）;
#   • 一次运行可以同时修补多个插件（共用同一个 app.asar, 不重复提取/重打包 124MB 文件）;
#   • 追加式改写: 旧数据区按原样保留, 新条目追加到 asar 末尾 —— 各文件既有 offset 不变,
#     正在运行的桌面端不受影响（重启后生效）;
#   • 与 .mjs 完全互相兼容: 相同的标签、插入位置与备份文件名, 两边都可以 --restore / --unpatch。
#
# 适用插件: 采用 renderer 注入（desktop/*-inject.js → out/renderer/index.html）的插件,
# 当前为 oc-infinite-gen-4 / oc-deepseek-banlance / oc-plugin-manager。
# oc-exit 为主进程托盘注入（Windows 专属, 注入 out/main/index.js）, 不在本脚本范围内。
#
# 用法:
#   python3 scripts/patch-desktop.py                     # 注入全部（自动备份, 原子替换）
#   python3 scripts/patch-desktop.py --dry-run           # 只验证, 不改动安装
#   python3 scripts/patch-desktop.py --only oc-infinite-gen-4
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

REPO_ROOT = Path(__file__).resolve().parent.parent
INJECT_SUFFIX = "-inject.js"
BLOCK_SIZE = 4194304  # 与 @electron/asar 的 integrity 分块一致（4 MiB）


class AsarError(RuntimeError):
    pass


def fail(message: str) -> None:
    print(f"error: {message}")
    sys.exit(1)


# ---------------------------------------------------------------------------
# 插件发现
# ---------------------------------------------------------------------------

def discover_plugins():
    """扫描工作区内采用 renderer 注入的插件: oc-*/desktop/*-inject.js。"""
    plugins = []
    for child in sorted(REPO_ROOT.iterdir()):
        if not child.is_dir() or not child.name.startswith("oc-"):
            continue
        desktop = child / "desktop"
        if not desktop.is_dir():
            continue
        for source in sorted(desktop.glob(f"*{INJECT_SUFFIX}")):
            base = source.name[: -len(INJECT_SUFFIX)]  # 例: oc-balance-inject.js -> oc-balance
            plugins.append(
                {
                    "name": child.name,                 # 目录名, 例: oc-deepseek-banlance
                    "source": source,                   # desktop/oc-balance-inject.js
                    "inject_name": source.name,         # 注入到 renderer 的文件名
                    "backup_suffix": f".{base}.bak",    # 与 .mjs 一致: app.asar.oc-balance.bak
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


# ---------------------------------------------------------------------------
# app.asar 默认路径（与 .mjs 的 defaultApp 对应, 增加 macOS 探测）
# ---------------------------------------------------------------------------

def default_app_asar():
    if sys.platform == "darwin":
        return Path("/Applications/OpenCode.app/Contents/Resources/app.asar")
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local) / "Programs" / "@opencodedesktop" / "resources" / "app.asar"
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


def build_header(header) -> bytes:
    data = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
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


def make_entry(content: bytes, offset: int) -> dict:
    return {"size": len(content), "offset": str(offset), "integrity": integrity_of(content)}


def find_renderer_index(header) -> str:
    """与 .mjs 相同的选择规则: 优先路径含 renderer, 其次路径最短。"""
    candidates = [path for path, _ in iter_entries(header["files"]) if path.endswith("index.html")]
    if not candidates:
        raise AsarError("asar 中未找到 index.html")
    candidates.sort(key=lambda p: (0 if "renderer" in p else 1, len(p)))
    return candidates[0]


# ---------------------------------------------------------------------------
# 计划（注入 / 移除）：只改 header JSON + 在数据区末尾追加新内容, 既有条目 offset 不动。
# ---------------------------------------------------------------------------

def plan_apply(blob: bytes, header, data_start: int, plugins):
    index_path = find_renderer_index(header)
    live_index = entry_map(header)[index_path]
    html = read_file(blob, data_start, live_index).decode("utf-8")

    data = blob[data_start:]
    appended = bytearray()
    inserted = []
    parent_parts = [p for p in index_path.rsplit("/", 1)[0].strip("/").split("/") if p]
    parent = dir_node(header, parent_parts) if parent_parts else header["files"]

    for plugin in plugins:
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
        offset = len(data) + len(appended)
        appended += content
        parent["files"][name] = make_entry(content, offset)

    html_bytes = html.encode("utf-8")
    html_offset = len(data) + len(appended)
    appended += html_bytes
    live_index["offset"] = str(html_offset)
    live_index["size"] = len(html_bytes)
    live_index["integrity"] = integrity_of(html_bytes)

    return build_header(header) + data + bytes(appended), index_path, inserted


def plan_unpatch(blob: bytes, header, data_start: int, plugins):
    index_path = find_renderer_index(header)
    live_index = entry_map(header)[index_path]
    html = read_file(blob, data_start, live_index).decode("utf-8")
    names = {p["inject_name"] for p in plugins}

    html_changed = any(n in html for n in names)
    if html_changed:
        html = "\n".join(
            line for line in html.split("\n") if not any(n in line for n in names)
        )

    parent_parts = [p for p in index_path.rsplit("/", 1)[0].strip("/").split("/") if p]
    parent = dir_node(header, parent_parts) if parent_parts else header["files"]
    removed = []
    for plugin in plugins:
        if plugin["inject_name"] in parent["files"]:
            del parent["files"][plugin["inject_name"]]
            removed.append(plugin["inject_name"])

    if not html_changed and not removed:
        return None, index_path, removed

    data = blob[data_start:]
    appended = bytearray()
    if html_changed:
        html_bytes = html.encode("utf-8")
        offset = len(data) + len(appended)
        appended += html_bytes
        live_index["offset"] = str(offset)
        live_index["size"] = len(html_bytes)
        live_index["integrity"] = integrity_of(html_bytes)

    return build_header(header) + data + bytes(appended), index_path, removed


# ---------------------------------------------------------------------------
# 校验：把写出的内容重新解析, 逐项核对
# ---------------------------------------------------------------------------

def validate(blob: bytes, plugins, mode: str):
    header, data_start = parse_asar(blob)
    emap = entry_map(header)
    index_path = find_renderer_index(header)
    parent_dir = index_path.rsplit("/", 1)[0]
    html = read_file(blob, data_start, emap[index_path]).decode("utf-8")
    checks = []
    for plugin in plugins:
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
        fail("未发现任何 desktop/*-inject.js 插件")

    print("插件      : " + ", ".join(p["name"] for p in plugins))
    if args.only:
        plugins = select(plugins, args.only)
        print("选择      : " + ", ".join(p["name"] for p in plugins))

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
        print("模式      : 移除注入")
        result, index_path, removed = plan_unpatch(blob, header, data_start, targets)
        if result is None:
            print("未发现本插件注入, 无需移除")
            return
        print(f"renderer  : {index_path}")
        for name in removed:
            print(f"已移除标签与文件: {name}")
        patched = result
        validate_mode = "unpatch"
    else:
        targets = plugins
        print("模式      : " + ("dry-run（不改动安装）" if args.dry_run else "注入"))
        patched, index_path, inserted = plan_apply(blob, header, data_start, targets)
        print(f"renderer  : {index_path}")
        for name in inserted:
            print(f"已写入 <script> 标签: {name}")
        validate_mode = "apply"

    if args.dry_run:
        target = Path(tempfile.gettempdir()) / f"oc-patch-desktop-test-{int(time.time())}.asar"
        target.write_bytes(patched)
        print(f"写入中… → (测试产物) {target}")
        checks = validate(target.read_bytes(), targets, validate_mode)
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
        fail("写入失败（文件被占用）。请完全退出 OpenCode Desktop 后重试")

    checks = validate(app.read_bytes(), targets, validate_mode)
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
