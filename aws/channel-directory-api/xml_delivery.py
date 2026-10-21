"""Render JMA XML with the same Discord frames used by the home senders.

Preview and dispatch call this same side-effect-free renderer, so the JSON
shown by the admin page is the JSON handed to the AWS delivery path.
"""
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

RENDERER_VERSION = "xml-production-embed-v3"
MAX_MESSAGES = 40
MAX_EMBEDS_PER_MESSAGE = 8
MAX_MESSAGE_TEXT = 3500
MAX_DESCRIPTION = 3000
EMBED_COLOR = 15258703
EEW_WARNING_COLOR = 15548997
TSUNAMI_FOOTER = {"text": "[!]がついている区域は更新、[↑]は上昇中を示します"}


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


def _direct_text(node, name, default=""):
    return _text(_child(node, name), default)


def _first_text(node, name, default=""):
    return _text(next(iter(_descendants(node, name)), None), default)


def _attribute(node, name, default=""):
    if node is not None:
        for key, value in node.attrib.items():
            if local_name(key) == name:
                return str(value).strip()
    return default


def _jst(value, include_date=False, seconds=False):
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        parsed = parsed.astimezone(timezone(timedelta(hours=9)))
        if include_date:
            suffix = f"{parsed.second}秒" if seconds else ""
            return f"{parsed.month}月{parsed.day}日　{parsed.hour}時{parsed.minute}分{suffix}"
        return f"{parsed.day}日{parsed.hour}時{parsed.minute}分"
    except (ValueError, TypeError):
        return value


def _headline(head):
    headline = _child(head, "Headline")
    return _first_text(headline, "Text") or _text(headline)


def _head_title(head, control):
    return _direct_text(head, "Title") or _direct_text(control, "Title") or "気象庁XML"


def _serial(head):
    return _direct_text(head, "Serial")


def _info_type(head):
    return _direct_text(head, "InfoType")


def _code_block(value):
    text = str(value or "").strip()
    return f"```{text}```" if text else ""


def _description(headline, detail):
    return "\n".join(value for value in (headline, _code_block(detail)) if value) or "本文情報なし"


def _earthquake_parts(body):
    earthquake = next(iter(_descendants(body, "Earthquake")), None)
    hypocenter = next(iter(_descendants(earthquake, "Hypocenter")), None)
    area = _child(hypocenter, "Area")
    magnitude = next(iter(_descendants(earthquake, "Magnitude")), None)
    coordinate = next(iter(_descendants(area, "Coordinate")), None)
    observation = next(iter(_descendants(body, "Observation")), None)
    return {
        "earthquake": earthquake,
        "area": area,
        "place": _direct_text(area, "Name"),
        "detailed": _direct_text(area, "DetailedName"),
        "magnitude": _attribute(magnitude, "description") or _text(magnitude),
        "magnitude_value": _text(magnitude),
        "coordinate": _attribute(coordinate, "description") or _text(coordinate),
        "origin": _direct_text(earthquake, "OriginTime"),
        "arrival": _direct_text(earthquake, "ArrivalTime"),
        "condition": _direct_text(earthquake, "Condition"),
        "maximum": _first_text(observation, "MaxInt"),
    }


def _earthquake_detail(body, include_maximum=True):
    parts = _earthquake_parts(body)
    lines = []
    if include_maximum:
        lines.append(f"最大震度:{parts['maximum'] or '不明'}")
    place = parts["place"] or "不明"
    detailed = f"({parts['detailed']})" if parts["detailed"] else ""
    magnitude = f" {parts['magnitude']}" if parts["magnitude"] else ""
    lines.append(f"震源:{place}{detailed}{magnitude}")
    if parts["coordinate"]:
        lines.append(parts["coordinate"])
    if parts["origin"]:
        lines.append(f"発生時間:{_jst(parts['origin'])}")
    comment = _first_text(next(iter(_descendants(body, "ForecastComment")), None), "Text")
    if comment:
        lines.extend(("", comment))
    return "\n".join(lines)


def _intensity_rank(value):
    normalized = str(value or "").translate(str.maketrans("０１２３４５６７８９＋－−", "0123456789+--"))
    normalized = normalized.replace("震度", "").replace("強", "+").replace("弱", "-").strip()
    order = {"7": 0, "6+": 1, "6-": 2, "5+": 3, "5-": 4, "4": 6, "3": 7, "2": 8, "1": 9, "0": 10}
    return order.get(normalized, 5 if "未入電" in normalized else 99)


def _intensity_heading(value):
    text = str(value or "").strip()
    return text if text.startswith("震度") else f"震度{text}"


def _observation_embeds(body):
    observation = next(iter(_descendants(body, "Observation")), None)
    embeds = []
    for pref in _descendants(observation, "Pref"):
        grouped = {}
        for station in _descendants(pref, "IntensityStation"):
            level = _direct_text(station, "Int")
            name = _direct_text(station, "Name")
            if level and name:
                grouped.setdefault(level, []).append(name)
        if not grouped:
            for area in _children(pref, "Area"):
                level = _direct_text(area, "MaxInt")
                name = _direct_text(area, "Name")
                if level and name:
                    grouped.setdefault(level, []).append(name)
        if grouped:
            detail = "".join(
                f"\n{_intensity_heading(level)}```{','.join(names)}```"
                for level, names in sorted(grouped.items(), key=lambda item: _intensity_rank(item[0]))
            )
            embeds.append({"title": _direct_text(pref, "Name") or "各地の震度", "description": detail, "color": EMBED_COLOR})
    return embeds


def _earthquake_embeds(head, control, body, type_code):
    title_base = _head_title(head, control)
    serial = _serial(head)
    info_type = _info_type(head)
    headline = _headline(head)
    if not _descendants(body, "Earthquake") and not _descendants(body, "Observation"):
        detail = _direct_text(body, "Text") or _first_text(next(iter(_descendants(body, "Comment")), None), "Text")
        title = f"{title_base}{f'[第{serial}報]' if serial else ''}{f'({info_type})' if info_type else ''}"
        return [{"title": title, "description": _description(headline, detail), "color": EMBED_COLOR}]
    if type_code == "VXSE51":
        title = f"{title_base}{f'（第{serial}報）' if serial and serial != '1' else ''}"
        comment = _first_text(next(iter(_descendants(body, "ForecastComment")), None), "Text")
        description = f"{headline}\n{_code_block(comment)}" if comment else (headline or "本文情報なし")
        embeds = [{"title": title, "description": description, "color": EMBED_COLOR}]
        embeds.extend(_observation_embeds(body))
        return embeds
    if type_code == "VXSE52":
        title = f"{title_base}{f'({info_type})' if info_type else ''}"
        parts = _earthquake_parts(body)
        comment = _first_text(next(iter(_descendants(body, "ForecastComment")), None), "Text")
        detail = "\n".join(filter(None, (
            f"震源:{parts['place'] or '不明'}", parts["magnitude"], parts["coordinate"],
            f"発生時間:{_jst(parts['origin'])}" if parts["origin"] else "", "", comment,
        )))
        return [{"title": title, "description": f"{headline}\n{_code_block(detail)}", "color": EMBED_COLOR}]

    parts = _earthquake_parts(body)
    comment = _first_text(next(iter(_descendants(body, "ForecastComment")), None), "Text")
    if type_code == "VXSE61":
        title = f"{title_base}{f'({info_type})' if info_type else ''}"
        origin = ""
        if parts["origin"]:
            try:
                parsed = datetime.fromisoformat(parts["origin"].replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=9)))
                origin = f"{parsed.year}年{parsed.month}月{parsed.day}日{parsed.hour}時{parsed.minute}分頃"
            except (TypeError, ValueError):
                origin = parts["origin"]
        detail = "\n".join(filter(None, (f"震源:{parts['place'] or '不明'}", parts["coordinate"], parts["magnitude"], f"発生時間:{origin}" if origin else "")))
        return [{"title": title, "description": f"{headline}\n{_code_block(detail)}", "color": EMBED_COLOR}]

    if type_code == "VXSE62":
        title = f"{_direct_text(control, 'Title') or title_base}{f'第{serial}報' if serial else ''}{f'({info_type})' if info_type else ''}"
        detail = "\n".join(filter(None, (
            f"最大震度:{parts['maximum'] or '不明'}", f"震源:{parts['place'] or '不明'} {parts['magnitude']}".rstrip(),
            parts["coordinate"], f"発生時間:{_jst(parts['origin'])}" if parts["origin"] else "",
        )))
        embeds = [{"title": title, "description": f"{headline}\n{_code_block(detail)}", "color": EMBED_COLOR}]
        grouped = {}
        observation = next(iter(_descendants(body, "Observation")), None)
        for area in _descendants(observation, "Area"):
            level = _direct_text(area, "MaxLgInt")
            name = _direct_text(area, "Name")
            if level and name:
                grouped.setdefault(level, []).append(name)
        if grouped:
            long_period = "".join(f"\n長周期地震動階級:{level}\n```{','.join(names)}```" for level, names in grouped.items())
            embeds.append({"title": title, "description": long_period, "color": EMBED_COLOR})
        return embeds

    title = f"{title_base}{f'[第{serial}報]' if serial else ''}{f'({info_type})' if info_type else ''}"
    detail = "\n".join(filter(None, (
        f"最大震度:{parts['maximum'] or '不明'}", f"震源:{parts['place'] or '不明'} {parts['magnitude']}".rstrip(),
        parts["coordinate"], f"発生時間:{_jst(parts['origin'])}" if parts["origin"] else "",
    )))
    tail = f"{comment}``` ＊印は気象庁以外の震度観測点についての情報です。```" if comment else ""
    embeds = [{"title": title, "description": "\n".join(filter(None, (detail, tail))) or "本文情報なし", "color": EMBED_COLOR}]
    embeds.extend(_observation_embeds(body))
    return embeds


def _forecast_range(node, name):
    value = next(iter(_descendants(node, name)), None)
    if value is None:
        return ""
    start = _direct_text(value, "From")
    end = _direct_text(value, "To")
    if start == end == "0" and name == "ForecastLgInt":
        return "1未満"
    if start and start == end:
        return start
    if start and end == "over":
        return f"{start}程度以上"
    return _text(value) if not (start or end) else "不明"


def _coordinate_parts(value):
    numbers = re.findall(r"[+-](\d+(?:\.\d+)?)", value or "")
    if len(numbers) >= 2:
        return f"{numbers[0]}°", f"{numbers[1]}°"
    return "不明", "不明"


def _eew_embed(head, control, body, route):
    serial = _serial(head)
    final = _direct_text(body, "NextAdvisory") == "この情報をもって、緊急地震速報：最終報とします。"
    report = f"[第{serial}{'（最終）' if final else ''}報]" if serial else ""
    is_warning = bool(_child(body, "Comments"))
    boxes = "■■■" if route == "eew_sind" else "■■"
    title = f"{boxes}緊急地震速報（{'警報' if is_warning else '予報'}）{report}{'■■' if route == 'eew_sind' else boxes}"
    cancellation = _direct_text(body, "Text")
    if _info_type(head) == "取消" and cancellation:
        return {"title": title, "description": f"{cancellation} ``` ``` ", "color": EMBED_COLOR}
    parts = _earthquake_parts(body)
    forecast = next(iter(_descendants(body, "Forecast")), None)
    detail_lines = [f"最大震度:{_forecast_range(forecast, 'ForecastInt') or '不明'}"]
    long_period = _forecast_range(forecast, "ForecastLgInt")
    if long_period:
        detail_lines.append(f"最大長周期階級:{long_period}")
    coordinate_node = next(iter(_descendants(parts["area"], "Coordinate")), None)
    coordinate_raw = _text(coordinate_node)
    latitude, longitude = _coordinate_parts(coordinate_raw)
    detail_lines.append(f"震源:{parts['place'] or '不明'}({latitude},{longitude})")
    if parts["condition"] == "仮定震源要素":
        detail_lines.append("仮定震源要素")
    else:
        depth = re.search(r"-(\d+)", coordinate_raw or "")
        depth_text = f"深さ:{int(depth.group(1)) // 1000}km" if depth else "深さ：不明"
        detail_lines[-1] += f"{depth_text} M:{parts['magnitude_value'] or '不明'}"
    event_time = parts["arrival"] if parts["condition"] else parts["origin"]
    detail_lines.append(f"{'検知時間' if parts['condition'] else '発生時間'}:{_jst(event_time, include_date=True, seconds=True) or '不明'}")
    if cancellation:
        detail_lines.append(cancellation)
    warning_areas = []
    for pref in _descendants(forecast, "Pref"):
        for area in _descendants(pref, "Area"):
            category = next(iter(_descendants(area, "Category")), None)
            code = _first_text(next(iter(_descendants(category, "Kind")), None), "Code")
            name = _direct_text(area, "Name")
            if code in {"10", "11", "19"} and name and name not in warning_areas:
                warning_areas.append(name)
    appendix = f"対象地域:\n{','.join(warning_areas)}" if warning_areas else " "
    return {"title": title, "description": f"{'\n'.join(detail_lines)} ```{appendix}``` ", "color": EMBED_COLOR}


def _eew_warning_embed(head, body):
    headline = _headline(head)
    serial = int(_serial(head) or 0)
    names = []
    for information in _descendants(_child(head, "Headline"), "Information"):
        for area in _descendants(information, "Area"):
            name = _direct_text(area, "Name")
            if name and name not in names:
                names.append(name)
    area_text = " ".join(f"**{name}**" if serial == 1 else name for name in names) or "***地域***\n不明"
    warning = _first_text(next(iter(_descendants(body, "WarningComment")), None), "Text")
    return {"title": headline or "緊急地震速報（警報）", "description": f"{area_text} ```{warning}``` ", "color": EEW_WARNING_COLOR}


def _tsunami_embeds(head, control, body, type_code):
    title_base = _head_title(head, control)
    info_type = _info_type(head)
    serial = _serial(head)
    office = _direct_text(control, "PublishingOffice")
    status = _direct_text(control, "Status")
    headline = _headline(head)
    tsunami = next(iter(_descendants(body, "Tsunami")), None)
    if type_code == "VTSE41" or next(iter(_descendants(tsunami, "Forecast")), None) is not None:
        grouped, details = {}, {}
        forecast = next(iter(_descendants(tsunami, "Forecast")), None)
        for item in _children(forecast, "Item"):
            area = _direct_text(_child(item, "Area"), "Name")
            category = _first_text(next(iter(_descendants(item, "Category")), None), "Name")
            first_height = next(iter(_descendants(item, "FirstHeight")), None)
            max_height = next(iter(_descendants(item, "MaxHeight")), None)
            if not (area and category):
                continue
            grouped.setdefault(category, []).append(area)
            height_node = next(iter(_descendants(max_height, "TsunamiHeight")), None)
            height = _attribute(height_node, "description") or _text(height_node)
            arrival = _first_text(first_height, "ArrivalTime")
            condition = _first_text(first_height, "Condition")
            revise = "[!]" if _first_text(first_height, "Revise") or _first_text(max_height, "Revise") else ""
            if arrival or condition or height:
                details.setdefault(category, []).append(f"{revise}{area}  {_jst(arrival) if arrival else condition} {height}".rstrip())
        title = f"{title_base}{f' {office}' if office else ''} 発表{f' ({status})' if status else ''}"
        overview = "".join(f"<{category}>\n{','.join(names)}\n" for category, names in grouped.items())
        embeds = [{"footer": TSUNAMI_FOOTER, "title": title, "description": f"{headline} ```{overview}``` ", "color": EMBED_COLOR}]
        for category, lines in details.items():
            embeds.append({"footer": TSUNAMI_FOOTER, "title": title, "description": f"**■■{category}■■** ```{chr(10).join(lines)}``` ", "color": EMBED_COLOR})
        return embeds

    title = f"{title_base}{f'({info_type})' if info_type else ''}{f'第{serial}報' if serial else ''}"
    rows = []
    for station in _descendants(tsunami, "Station"):
        name = _direct_text(station, "Name")
        first = next(iter(_descendants(station, "FirstHeight")), None)
        maximum = next(iter(_descendants(station, "MaxHeight")), None)
        first_text = _jst(_first_text(first, "ArrivalTime")) or _first_text(first, "Condition")
        height_node = next(iter(_descendants(maximum, "TsunamiHeight")), None)
        maximum_text = " ".join(filter(None, (_jst(_first_text(maximum, "DateTime")), _attribute(height_node, "description") or _text(height_node), _first_text(maximum, "Condition"))))
        if name:
            rows.append(f"{name} {first_text} {maximum_text}".rstrip())
    heading = "観測名　第1波概要　最大波概要"
    warning = _first_text(next(iter(_descendants(body, "WarningComment")), None), "Text")
    detail = heading + ("\n" + "\n".join(rows) if rows else "")
    return [{"footer": TSUNAMI_FOOTER, "title": title, "description": f"{headline}{f' {warning}' if warning else ''} ```{detail}``` ", "color": EMBED_COLOR}]


def _weather_embed(head, control, body):
    title = _head_title(head, control)
    serial = _serial(head)
    info_type = _info_type(head)
    if serial:
        title += f" 第{serial}報"
    if info_type:
        title += f"({info_type})"
    headline = _headline(head)
    detail = _direct_text(body, "Text")
    if not detail:
        detail = _first_text(next(iter(_descendants(body, "Comment")), None), "Text")
    if not detail:
        details = []
        for prop in _descendants(body, "Property"):
            value = _direct_text(prop, "Text")
            if value and value not in details:
                details.append(value)
        detail = "\n\n".join(details)
    description = f"{headline} ```{detail}``` " if detail else (headline or "本文情報なし")
    return {"title": title, "description": description, "color": EMBED_COLOR}


def _volcano_embed(head, control, body, type_code):
    title = _head_title(head, control)
    serial = _serial(head)
    info_type = _info_type(head)
    if type_code in {"VFVO51", "VFVO52"} and serial:
        title += f" 第{serial}報"
    if info_type:
        title += f"({info_type})"
    headline = _headline(head)
    content = next(iter(_descendants(body, "VolcanoInfoContent")), None)
    detail_parts = []
    for name in ("VolcanoHeadline", "VolcanoActivity", "VolcanoPrevention", "NextAdvisory"):
        value = _direct_text(content, name)
        if value and value not in detail_parts and value != headline:
            detail_parts.append(value)
    if type_code == "VFVO52":
        observation = next(iter(_descendants(body, "VolcanoObservation")), None)
        height = next(iter(_descendants(observation, "PlumeHeightAboveCrater")), None)
        direction = next(iter(_descendants(observation, "PlumeDirection")), None)
        if height is not None:
            detail_parts.append(f"火口上噴煙高度：{_attribute(height, 'description') or _text(height)}")
        if direction is not None:
            detail_parts.append(f"噴煙の流向:{_text(direction)}")
        other = _direct_text(observation, "OtherObservation")
        if other:
            detail_parts.append(other)
    detail = "\n".join(detail_parts) or _direct_text(body, "Text")
    description = f"{headline} ```{detail}``` " if detail else (headline or "本文情報なし")
    return {"title": title, "description": description, "color": EMBED_COLOR}


def _generic_embed(head, control, body):
    title = _head_title(head, control)
    info_type = _info_type(head)
    if info_type:
        title += f"({info_type})"
    detail = _direct_text(body, "Text") or _first_text(next(iter(_descendants(body, "Comment")), None), "Text")
    return {"title": title, "description": _description(_headline(head), detail), "color": EMBED_COLOR}


def _infer_type_code(summary, head, control):
    explicit = str((summary or {}).get("typeCode") or "").strip().upper()
    if explicit:
        return explicit
    title = f"{_head_title(head, control)} {_direct_text(control, 'Title')}"
    rules = (
        ("緊急地震速報", "VXSE45"), ("震度速報", "VXSE51"), ("震源に関する情報", "VXSE52"),
        ("長周期地震動", "VXSE62"), ("震源・震度", "VXSE53"), ("遠地地震", "VXSE53"),
        ("沖合の津波観測", "VTSE52"), ("津波情報", "VTSE51"), ("津波警報", "VTSE41"),
        ("噴火警報", "VFVO50"), ("火山の状況", "VFVO51"), ("噴火に関する火山観測", "VFVO52"), ("噴火速報", "VFVO53"),
    )
    return next((code for marker, code in rules if marker in title), "")


def _split_description(embed):
    description = str(embed.get("description") or "本文情報なし")
    if len(description) <= MAX_DESCRIPTION:
        return [embed]
    parts, remaining = [], description
    while remaining:
        split_at = min(MAX_DESCRIPTION, len(remaining))
        if len(remaining) > MAX_DESCRIPTION:
            newline = remaining.rfind("\n", 0, MAX_DESCRIPTION)
            if newline > 0:
                split_at = newline
        parts.append(remaining[:split_at].rstrip())
        remaining = remaining[split_at:].lstrip("\n")
    result = []
    for index, part in enumerate(parts):
        item = dict(embed)
        item["description"] = part
        if index:
            item["title"] = f"{embed.get('title', '')} (cont. {index + 1})"[:256]
        result.append(item)
    return result


def _pack_messages(embeds, username, max_embeds=MAX_EMBEDS_PER_MESSAGE):
    messages, chunk, text_length = [], [], 0
    for embed in [part for item in embeds for part in _split_description(item)]:
        length = len(str(embed.get("title", ""))) + len(str(embed.get("description", "")))
        if chunk and (len(chunk) >= max_embeds or text_length + length > MAX_MESSAGE_TEXT):
            messages.append({"username": username, "allowed_mentions": {"parse": []}, "embeds": chunk})
            chunk, text_length = [], 0
        chunk.append(embed)
        text_length += length
    if chunk:
        messages.append({"username": username, "allowed_mentions": {"parse": []}, "embeds": chunk})
    return messages


def render_xml(xml_text, summary, route, slot):
    root = ET.fromstring(xml_text)
    if local_name(root.tag) != "Report":
        raise ValueError("気象庁のReport形式XMLに対応しています。")
    control = _child(root, "Control")
    head = _child(root, "Head")
    body = _child(root, "Body")
    if body is None:
        raise ValueError("配信内容のBodyがありません。")

    type_code = _infer_type_code(summary, head, control)
    if route == "zisin":
        embeds, username = _earthquake_embeds(head, control, body, type_code), "DPI-Bot"
    elif route in {"eew", "eew_sind"}:
        embeds = [_eew_embed(head, control, body, route)]
        username = "防災情報提供BOT" if route == "eew_sind" else "DPI-Bot"
    elif route == "keiho" and type_code == "VXSE43":
        embeds, username = [_eew_warning_embed(head, body)], "緊急地震速報(警報)"
    elif route == "tunami":
        embeds, username = _tsunami_embeds(head, control, body, type_code), "DPI-Bot"
    elif route in {"kisyo", "kisyo2", "keiho"}:
        embeds, username = [_weather_embed(head, control, body)], "DPI-Bot"
    elif route == "kazan":
        embeds, username = [_volcano_embed(head, control, body, type_code)], "DPI-Bot"
    else:
        embeds, username = [_generic_embed(head, control, body)], "防災情報提供BOT"

    messages = _pack_messages(embeds, username, max_embeds=10 if route == "tunami" else MAX_EMBEDS_PER_MESSAGE)
    if len(messages) > MAX_MESSAGES:
        raise ValueError(f"Discordメッセージが{MAX_MESSAGES}通を超えます。大量配信防止のため送信できません。")
    canonical = json.dumps({"version": RENDERER_VERSION, "xml": xml_text, "route": route,
                            "slot": slot, "typeCode": type_code, "messages": messages},
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"messages": messages, "previewDigest": hashlib.sha256(canonical.encode()).hexdigest(),
            "rendererVersion": RENDERER_VERSION, "messageCount": len(messages),
            "embedCount": sum(len(message["embeds"]) for message in messages), "typeCode": type_code,
            "formatNote": "自宅サーバーの電文コード別Embed構成と同じ送信JSONです。このプレビューJSONをそのまま配信します。"}
