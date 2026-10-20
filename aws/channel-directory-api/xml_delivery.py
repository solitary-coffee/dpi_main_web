"""Side-effect-free JMA XML -> production-shaped Discord messages.

Preview and dispatch both call :func:`render_xml`; therefore the preview is the
exact Discord JSON that is delivered. Keep this module free of network calls.
"""
import hashlib
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

RENDERER_VERSION = "xml-production-embed-v2"
MAX_MESSAGES = 40
EMBED_COLOR = 15258703


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _children(node, name):
    return [child for child in list(node) if local_name(child.tag) == name] if node is not None else []


def _child(node, name):
    return next(iter(_children(node, name)), None)


def _descendants(node, name):
    return [item for item in (node.iter() if node is not None else ()) if local_name(item.tag) == name]


def _text(node, default=""):
    if node is None:
        return default
    value = "".join(node.itertext()).strip()
    return value or default


def _first_text(node, name, default=""):
    return _text(next(iter(_descendants(node, name)), None), default)


def _attribute(node, name, default=""):
    if node is not None:
        for key, value in node.attrib.items():
            if local_name(key) == name:
                return str(value).strip()
    return default


def _jst(value):
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone(timedelta(hours=9))).strftime("%-d日%-H時%-M分")
    except (ValueError, TypeError):
        return value


def _headline(head):
    headline = _child(head, "Headline")
    return _first_text(headline, "Text") or _text(headline)


def _title(head, control, with_serial=False):
    title = _first_text(head, "Title") or _first_text(control, "Title") or "気象庁XML"
    info_type = _first_text(head, "InfoType")
    serial = _first_text(head, "Serial")
    status = _first_text(control, "Status")
    if with_serial and serial:
        title += f"[第{serial}報]"
    suffix = "|".join(value for value in (info_type, status if with_serial else "") if value)
    return f"{title}({suffix})" if suffix else title


def _code(lines):
    value = "\n".join(str(line).strip() for line in lines if str(line).strip()).strip()
    return f"```{value}```" if value else ""


def _earthquake_embed(head, control, body):
    earthquake = next(iter(_descendants(body, "Earthquake")), None)
    observation = next(iter(_descendants(body, "Observation")), None)
    hypocenter = _child(earthquake, "Hypocenter")
    area = _child(hypocenter, "Area")
    magnitude = next(iter(_descendants(earthquake, "Magnitude")), None)
    coordinate = next(iter(_descendants(area, "Coordinate")), None)
    lines = []
    maximum = _first_text(observation, "MaxInt")
    if maximum:
        lines.append(f"最大震度:{maximum}")
    place = _first_text(area, "Name")
    detailed = _first_text(area, "DetailedName")
    magnitude_text = _attribute(magnitude, "description") or _text(magnitude)
    if place:
        lines.append(f"震源:{place}{f'({detailed})' if detailed else ''}{f' {magnitude_text}' if magnitude_text else ''}")
    elif magnitude_text:
        lines.append(magnitude_text)
    coordinate_text = _attribute(coordinate, "description") or _text(coordinate)
    if coordinate_text:
        lines.append(coordinate_text)
    origin = _first_text(earthquake, "OriginTime")
    if origin:
        lines.append(f"発生時間:{_jst(origin)}")
    comment = _first_text(next(iter(_descendants(body, "ForecastComment")), None), "Text")
    if comment:
        lines.extend(("", comment))
    headline = _headline(head)
    fallback = _first_text(body, "Text")
    description = "\n".join(value for value in (headline, _code(lines) if lines else fallback) if value)
    return {"title": _title(head, control, with_serial=bool(_first_text(head, "Serial"))),
            "description": description or "本文情報なし", "color": EMBED_COLOR}


def _intensity_embeds(head, control, body):
    embeds = [_earthquake_embed(head, control, body)]
    observation = next(iter(_descendants(body, "Observation")), None)
    for pref in _descendants(observation, "Pref"):
        groups = {}
        for area in _children(pref, "Area"):
            intensity = _first_text(area, "MaxInt")
            name = _first_text(area, "Name")
            if intensity and name:
                groups.setdefault(intensity, []).append(name)
        if groups:
            description = "\n".join(f"震度{level}```{','.join(names)}```" for level, names in groups.items())
            embeds.append({"title": _first_text(pref, "Name") or "各地の震度", "description": description,
                           "color": EMBED_COLOR})
    return embeds


def _eew_embed(head, control, body):
    earthquake = next(iter(_descendants(body, "Earthquake")), None)
    hypocenter = next(iter(_descendants(earthquake, "Hypocenter")), None)
    area = _child(hypocenter, "Area")
    magnitude = next(iter(_descendants(earthquake, "Magnitude")), None)
    forecast = next(iter(_descendants(body, "Forecast")), None)
    lines = []
    serial = _first_text(head, "Serial")
    if serial:
        lines.append(f"第{serial}報")
    origin = _first_text(earthquake, "OriginTime")
    if origin:
        lines.append(f"発生時間:{_jst(origin)}")
    place = _first_text(area, "Name")
    if place:
        lines.append(f"震源:{place}")
    magnitude_text = _attribute(magnitude, "description") or _text(magnitude)
    if magnitude_text:
        lines.append(magnitude_text)
    maximum = _first_text(forecast, "ForecastInt") or _first_text(forecast, "MaxInt")
    if maximum:
        lines.append(f"最大予測震度:{maximum}")
    warning_areas = []
    for item in _descendants(forecast, "Item"):
        name = _first_text(_child(item, "Area"), "Name")
        if name and name not in warning_areas:
            warning_areas.append(name)
    if warning_areas:
        lines.append(f"対象地域:{'、'.join(warning_areas)}")
    fallback = _first_text(body, "Text")
    description = "\n".join(value for value in (_headline(head), _code(lines) if lines else fallback) if value)
    return {"title": _title(head, control), "description": description or "本文情報なし",
            "color": EMBED_COLOR}


def _warning_embed(head, control, body):
    lines = []
    warning = next(iter(_descendants(body, "Warning")), None)
    for item in _descendants(warning, "Item"):
        area = _first_text(_child(item, "Area"), "Name")
        kinds = []
        for kind in _children(item, "Kind"):
            name = _first_text(kind, "Name")
            status = _first_text(kind, "Status")
            if name or status:
                kinds.append(f"{'【!】' if status == '発表' else ''}{name}{f'（{status}）' if status else ''}")
        if area and kinds:
            lines.append(f"{area}: {'、'.join(kinds)}")
    fallback = _first_text(body, "Text") or _first_text(next(iter(_descendants(body, "Comment")), None), "Text")
    description = "\n".join(value for value in (_headline(head), _code(lines) if lines else fallback) if value)
    embed = {"title": _title(head, control), "description": description or "本文情報なし", "color": EMBED_COLOR}
    if lines:
        embed["footer"] = {"text": "【!】は発表された警報・注意報を示します"}
    return embed


def _tsunami_embed(head, control, body):
    lines = []
    for item in _descendants(next(iter(_descendants(body, "Tsunami")), body), "Item"):
        area = _first_text(_child(item, "Area"), "Name")
        category = _first_text(next(iter(_descendants(item, "Category")), None), "Name")
        first_height = next(iter(_descendants(item, "FirstHeight")), None)
        max_height = next(iter(_descendants(item, "MaxHeight")), None)
        details = [value for value in (category,
                   _attribute(first_height, "description") or _text(first_height),
                   _attribute(max_height, "description") or _text(max_height)) if value]
        if area and details:
            lines.append(f"{area}: {' / '.join(details)}")
    fallback = _first_text(body, "Text")
    description = "\n".join(value for value in (_headline(head), _code(lines) if lines else fallback) if value)
    embed = {"title": _title(head, control, with_serial=bool(_first_text(head, "Serial"))),
             "description": description or "本文情報なし", "color": EMBED_COLOR}
    if lines:
        embed["footer"] = {"text": "[!]がついている区域は更新、[↑]は上昇中を示します"}
    return embed


def _notice_embed(head, control, body, weather=False):
    body_text = _first_text(body, "Text")
    if not body_text:
        body_text = _first_text(next(iter(_descendants(body, "Comment")), None), "Text")
    description = "\n".join(value for value in (_headline(head), _code([body_text]) if body_text else "") if value)
    return {"title": _title(head, control, with_serial=weather and bool(_first_text(head, "Serial"))),
            "description": description or "本文情報なし", "color": EMBED_COLOR}


def _split_description(embed, limit=3500):
    description = embed.get("description") or "本文情報なし"
    chunks, current, width = [], [], 0
    for char in description:
        char_width = 2 if ord(char) > 0xFFFF else 1
        if width + char_width > limit:
            chunks.append("".join(current))
            current, width = [], 0
        current.append(char)
        width += char_width
    if current:
        chunks.append("".join(current))
    result = []
    for index, chunk in enumerate(chunks):
        item = dict(embed)
        item["description"] = chunk
        if len(chunks) > 1:
            item["title"] = f"{embed.get('title', '')} ({index + 1}/{len(chunks)})"[:256]
        result.append(item)
    return result


def render_xml(xml_text, summary, route, slot):
    root = ET.fromstring(xml_text)
    if local_name(root.tag) != "Report":
        raise ValueError("気象庁のReport形式XMLに対応しています。")
    control = _child(root, "Control")
    head = _child(root, "Head")
    body = _child(root, "Body")
    if body is None:
        raise ValueError("配信内容のBodyがありません。")

    if route == "zisin":
        embeds = _intensity_embeds(head, control, body)
        username = "防災情報提供BOT"
    elif route in {"eew", "eew_sind"}:
        embeds, username = [_eew_embed(head, control, body)], "DPI-Bot"
    elif route == "tunami":
        embeds, username = [_tsunami_embed(head, control, body)], "DPI-Bot"
    elif route == "keiho":
        embeds, username = [_warning_embed(head, control, body)], "DPI-Bot"
    else:
        embeds, username = [_notice_embed(head, control, body, weather=route in {"kisyo", "kisyo2"})], "DPI-Bot"

    split_embeds = [part for embed in embeds for part in _split_description(embed)]
    if len(split_embeds) > MAX_MESSAGES:
        raise ValueError(f"Embedが{MAX_MESSAGES}通を超えます。大量配信防止のため送信できません。")
    messages = [{"username": username, "allowed_mentions": {"parse": []}, "embeds": [embed]}
                for embed in split_embeds]
    canonical = json.dumps({"version": RENDERER_VERSION, "xml": xml_text, "route": route,
                            "slot": slot, "messages": messages}, ensure_ascii=False,
                           sort_keys=True, separators=(",", ":"))
    return {"messages": messages, "previewDigest": hashlib.sha256(canonical.encode()).hexdigest(),
            "rendererVersion": RENDERER_VERSION, "messageCount": len(messages),
            "formatNote": "実際の自動配信と同じ種別別Embed形式です。このプレビューJSONをそのまま配信します。"}
