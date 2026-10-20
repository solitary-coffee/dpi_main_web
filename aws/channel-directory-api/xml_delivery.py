"""Side-effect-free XML -> Discord messages, shared by preview and dispatch."""
import hashlib
import json
import xml.etree.ElementTree as ET

RENDERER_VERSION = "xml-embed-v1"
MAX_MESSAGES = 40


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def render_xml(xml_text, summary, route, slot):
    root = ET.fromstring(xml_text)
    if local_name(root.tag) != "Report":
        raise ValueError("気象庁のReport形式XMLに対応しています。")
    body = next((x for x in root if local_name(x.tag) == "Body"), None)
    if body is None:
        raise ValueError("配信内容のBodyがありません。")
    title = summary.get("headline") or summary.get("controlTitle") or "気象庁XML"
    status = summary.get("status") or "不明"
    lines = []

    def walk(node, path=()):
        name = local_name(node.tag)
        children = list(node)
        text = (node.text or "").strip()
        attrs = " / ".join(f"{local_name(k)}={v}" for k, v in node.attrib.items())
        label = " / ".join((*path, name))
        if text or attrs:
            lines.append(f"{label}" + (f" ({attrs})" if attrs else "") + (f": {text}" if text else ""))
        for child in children:
            walk(child, (*path, name))

    walk(body)
    content = "\n".join(lines) or "本文情報なし"
    # Keep all values, split rather than truncate; Discord uses UTF-16 lengths.
    chunks, chunk, size = [], [], 0
    for char in content:
        width = 2 if ord(char) > 0xFFFF else 1
        if size + width > 3500:
            chunks.append("".join(chunk))
            chunk, size = [], 0
        chunk.append(char)
        size += width
    if chunk:
        chunks.append("".join(chunk))
    if len(chunks) > MAX_MESSAGES:
        raise ValueError(f"Embedが{MAX_MESSAGES}通を超えます。大量配信防止のため送信できません。")
    messages = []
    for index, description in enumerate(chunks):
        embed = {
            "title": title[:100] + (f" ({index + 1}/{len(chunks)})" if len(chunks) > 1 else ""),
            "description": description,
            "color": 0xE67E22 if status != "通常" else 0x3498DB,
            "footer": {"text": f"{summary.get('publishingOffice', '')[:100]} | 状態: {status[:40]} | {RENDERER_VERSION}"},
        }
        if index == 0:
            embed["fields"] = [
                {"name": label, "value": str(value or "—")[:200], "inline": True}
                for label, value in [
                    ("イベントID", summary.get("eventId")),
                    ("発表時刻", summary.get("reportDateTime")),
                    ("配信枠", slot),
                    ("配信経路", route),
                ]
            ]
        messages.append({"username": "DPI-Bot", "allowed_mentions": {"parse": []}, "embeds": [embed]})
    canonical = json.dumps({"version": RENDERER_VERSION, "xml": xml_text,
                            "route": route, "slot": slot, "messages": messages},
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"messages": messages, "previewDigest": hashlib.sha256(canonical.encode()).hexdigest(),
            "rendererVersion": RENDERER_VERSION, "messageCount": len(messages),
            "formatNote": "XML管理配信用の共通Embed形式です。自動配信の種別別レイアウトとは異なります。"}
