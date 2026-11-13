#!/usr/bin/env python3
"""
Generate and Apple-sign the three iPhone Shortcuts bundled with Health Planner.

Must run on macOS with `/usr/bin/plutil` and `/usr/bin/shortcuts sign --mode anyone`
so Ubuntu/Docker deployments can serve valid signed `.shortcut` downloads directly.
"""

from __future__ import annotations

import argparse
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

NAMESPACE = uuid.UUID("7e6a32a2-9214-4d8a-9b9c-3a6a8c0e4401")
ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT_DIR / "src" / "health-planner" / "shortcuts"
OBJ_REPLACEMENT = "\uFFFC"


def make_uuid(scope: str, key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{scope}:{key}")).upper()


def action_output_ref(output_uuid: str, output_name: str) -> dict[str, Any]:
    return {
        "OutputName": output_name,
        "OutputUUID": output_uuid,
        "Type": "ActionOutput",
    }


def variable_ref(name: str) -> dict[str, Any]:
    return {
        "Type": "Variable",
        "VariableName": name,
    }


def token_attachment(ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "Value": ref,
        "WFSerializationType": "WFTextTokenAttachment",
    }


def conditional_input(ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "Type": "Variable",
        "Variable": token_attachment(ref),
    }


def token_string(parts: list[str | dict[str, Any]]) -> dict[str, Any]:
    """
    Build a WFTextTokenString using UTF-16 code-unit offsets (matching NSString length).
    """
    text_chunks: list[str] = []
    attachments: dict[str, dict[str, Any]] = {}
    utf16_pos = 0
    for part in parts:
        if isinstance(part, str):
            text_chunks.append(part)
            utf16_pos += len(part.encode("utf-16-le")) // 2
        else:
            attachments[f"{{{utf16_pos}, 1}}"] = part
            text_chunks.append(OBJ_REPLACEMENT)
            utf16_pos += 1
    value: dict[str, Any] = {"string": "".join(text_chunks)}
    if attachments:
        value["attachmentsByRange"] = attachments
    return {
        "Value": value,
        "WFSerializationType": "WFTextTokenString",
    }


def dict_text_item(key_name: str, parts: list[str | dict[str, Any]]) -> dict[str, Any]:
    return {
        "WFItemType": 0,
        "WFKey": token_string([key_name]),
        "WFValue": token_string(parts),
    }


def dict_field(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "Value": {"WFDictionaryFieldValueItems": items},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def quantity_field_static_or_var(magnitude_ref: dict[str, Any], unit: str) -> dict[str, Any]:
    return {
        "Value": {
            "Magnitude": token_attachment(magnitude_ref),
            "Unit": unit,
        },
        "WFSerializationType": "WFQuantityFieldValue",
    }


def quantity_unit_only(unit: str) -> dict[str, Any]:
    return {
        "Value": {"Unit": unit},
        "WFSerializationType": "WFQuantityFieldValue",
    }


def action(identifier: str, params: dict[str, Any]) -> dict[str, Any]:
    return {
        "WFWorkflowActionIdentifier": identifier,
        "WFWorkflowActionParameters": params,
    }


def act_text(uid: str | None, text: str) -> dict[str, Any]:
    params: dict[str, Any] = {"WFTextActionText": text}
    if uid:
        params["UUID"] = uid
    return action("is.workflow.actions.gettext", params)


def act_comment(text: str) -> dict[str, Any]:
    return action("is.workflow.actions.comment", {
        "WFCommentActionText": text,
    })


def act_find_health(
    uid: str,
    sample_type: str,
    *,
    today_only: bool = True,
    latest_one: bool = False,
) -> dict[str, Any]:
    templates: list[dict[str, Any]] = [
        {
            "Bounded": True,
            "Operator": 4,
            "Property": "Type",
            "Removable": False,
            "Values": {
                "Enumeration": {
                    "Value": sample_type,
                    "WFSerializationType": "WFStringSubstitutableState",
                }
            },
        }
    ]
    if today_only:
        templates.append({
            "Bounded": True,
            "Operator": 1002,
            "Property": "Start Date",
            "Removable": False,
            "Values": {
                "Number": "7",
                "Unit": 16,
            },
        })
    params: dict[str, Any] = {
        "UUID": uid,
        "WFContentItemFilter": {
            "Value": {
                "WFActionParameterFilterPrefix": 1,
                "WFContentPredicateBoundedDate": False,
                "WFActionParameterFilterTemplates": templates,
            },
            "WFSerializationType": "WFContentPredicateTableTemplate",
        },
    }
    if latest_one:
        params["WFContentItemSortProperty"] = "Start Date"
        params["WFContentItemSortOrder"] = "Latest First"
        params["WFContentItemLimitEnabled"] = True
        params["WFContentItemLimitNumber"] = 1
    return action("is.workflow.actions.filter.health.quantity", params)


def act_statistics_sum(uid: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.statistics", {
        "UUID": uid,
        "WFStatisticsOperation": "Sum",
        "Input": token_attachment(input_ref),
    })


def act_health_detail(uid: str, prop: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.properties.health.quantity", {
        "UUID": uid,
        "WFContentItemPropertyName": prop,
        "WFInput": token_attachment(input_ref),
    })


def act_log_health(uid: str, sample_type: str, mag_ref: dict[str, Any], unit: str) -> dict[str, Any]:
    return action("is.workflow.actions.health.quantity.log", {
        "UUID": uid,
        "WFQuantitySampleType": sample_type,
        "WFQuantitySampleQuantity": quantity_field_static_or_var(mag_ref, unit),
        "WFQuantitySampleAdditionalQuantity": quantity_unit_only(unit),
        "WFQuantitySampleDate": token_attachment({"Type": "CurrentDate"}),
    })


def act_http_json(
    uid: str,
    method: str,
    url_parts: list[str | dict[str, Any]],
    token_ref: dict[str, Any],
    json_items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "UUID": uid,
        "WFURL": token_string(url_parts),
        "WFHTTPMethod": method,
        "ShowHeaders": True,
        "WFHTTPHeaders": dict_field([
            dict_text_item("Authorization", ["Bearer ", token_ref]),
            dict_text_item("Content-Type", ["application/json"]),
        ]),
    }
    if method != "GET":
        params["WFHTTPBodyType"] = "JSON"
        params["WFJSONValues"] = dict_field(json_items or [])
    return action("is.workflow.actions.downloadurl", params)


def act_detect_dict(uid: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.detect.dictionary", {
        "UUID": uid,
        "WFInput": token_attachment(input_ref),
    })


def act_get_clipboard(uid: str) -> dict[str, Any]:
    return action("is.workflow.actions.getclipboard", {
        "UUID": uid,
    })


def act_detect_images(uid: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.detect.images", {
        "UUID": uid,
        "WFInput": token_attachment(input_ref),
    })


def act_detect_text(uid: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.detect.text", {
        "UUID": uid,
        "WFInput": token_attachment(input_ref),
    })


def act_set_variable(var_name: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.setvariable", {
        "WFVariableName": var_name,
        "WFInput": token_attachment(input_ref),
    })


def act_dict_value(uid: str | None, key: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    params: dict[str, Any] = {
        "WFGetDictionaryValueType": "Value",
        "WFDictionaryKey": key,
        "WFInput": token_attachment(input_ref),
    }
    if uid:
        params["UUID"] = uid
    return action("is.workflow.actions.getvalueforkey", params)


def act_count(uid: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.count", {
        "UUID": uid,
        "WFCountType": "Items",
        "Input": token_attachment(input_ref),
    })


def act_notify(uid: str, title: str, body_parts: list[str | dict[str, Any]]) -> dict[str, Any]:
    return action("is.workflow.actions.notification", {
        "UUID": uid,
        "WFNotificationActionTitle": title,
        "WFNotificationActionBody": token_string(body_parts),
        "WFNotificationActionSound": True,
    })


def act_if_gt(group_id: str, input_ref: dict[str, Any], number_str: str) -> dict[str, Any]:
    return action("is.workflow.actions.conditional", {
        "GroupingIdentifier": group_id,
        "WFControlFlowMode": 0,
        "WFCondition": 2,
        "WFNumberValue": number_str,
        "WFInput": conditional_input(input_ref),
    })


def act_if_has_value(group_id: str, input_ref: dict[str, Any]) -> dict[str, Any]:
    return action("is.workflow.actions.conditional", {
        "GroupingIdentifier": group_id,
        "WFControlFlowMode": 0,
        "WFCondition": 100,
        "WFInput": conditional_input(input_ref),
    })


def act_otherwise(group_id: str) -> dict[str, Any]:
    return action("is.workflow.actions.conditional", {
        "GroupingIdentifier": group_id,
        "WFControlFlowMode": 1,
    })


def act_end_if(group_id: str) -> dict[str, Any]:
    return action("is.workflow.actions.conditional", {
        "GroupingIdentifier": group_id,
        "WFControlFlowMode": 2,
    })


def wrap_workflow(
    name: str,
    glyph: int,
    color: int,
    actions: list[dict[str, Any]],
    *,
    url_action_index: int,
    token_action_index: int,
) -> dict[str, Any]:
    return {
        "WFWorkflowActions": actions,
        "WFWorkflowClientVersion": "2700.0.4",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": glyph,
            "WFWorkflowIconStartColor": color,
        },
        "WFWorkflowImportQuestions": [
            {
                "ActionIndex": url_action_index,
                "Category": "Parameter",
                "DefaultValue": "https://你的服务器地址",
                "ParameterKey": "WFTextActionText",
                "Text": "第一步：填入 Bot 服务器地址（不含末尾 /，可在下载页点「复制服务器地址」）",
            },
            {
                "ActionIndex": token_action_index,
                "Category": "Parameter",
                "DefaultValue": "",
                "ParameterKey": "WFTextActionText",
                "Text": "第二步：填入个人同步 Token（QQ 私聊发送「/健康 同步」获取）",
            },
        ],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowName": name,
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes": [],
    }


def build_sync_apple_to_bot() -> dict[str, Any]:
    s = "sync-apple-to-bot"
    u_url = make_uuid(s, "url")
    u_tok = make_uuid(s, "tok")
    u_steps_find = make_uuid(s, "steps_find")
    u_steps_sum = make_uuid(s, "steps_sum")
    u_active_find = make_uuid(s, "active_find")
    u_active_sum = make_uuid(s, "active_sum")
    u_weight_find = make_uuid(s, "weight_find")
    u_weight_val = make_uuid(s, "weight_val")
    u_http = make_uuid(s, "http")
    u_dict = make_uuid(s, "dict")
    u_day = make_uuid(s, "day")
    g_ok = make_uuid(s, "if_ok")

    r_url = action_output_ref(u_url, "Text")
    r_tok = action_output_ref(u_tok, "Text")
    r_steps = action_output_ref(u_steps_sum, "Statistics")
    r_active = action_output_ref(u_active_sum, "Statistics")
    r_weight = action_output_ref(u_weight_val, "Value")
    r_http = action_output_ref(u_http, "Contents of URL")
    r_dict = action_output_ref(u_dict, "Dictionary")
    r_day = action_output_ref(u_day, "Dictionary Value")

    actions = [
        act_comment("同步今日 Apple 健康步数、活动能量和最新体重到 QQ Bot，用于动态修正每日目标热量。"),
        act_text(u_url, "https://你的服务器地址"),
        act_text(u_tok, "在此填入个人同步Token"),
        act_find_health(u_steps_find, "Steps", today_only=True),
        act_statistics_sum(u_steps_sum, action_output_ref(u_steps_find, "Health Samples")),
        act_find_health(u_active_find, "Active Calories", today_only=True),
        act_statistics_sum(u_active_sum, action_output_ref(u_active_find, "Health Samples")),
        act_find_health(u_weight_find, "Weight", today_only=False, latest_one=True),
        act_health_detail(u_weight_val, "Value", action_output_ref(u_weight_find, "Health Samples")),
        act_http_json(
            u_http,
            "POST",
            [r_url, "/bridge/health/sync"],
            r_tok,
            [
                dict_text_item("steps", [r_steps]),
                dict_text_item("activeEnergyKcal", [r_active]),
                dict_text_item("weightKg", [r_weight]),
            ],
        ),
        act_detect_dict(u_dict, r_http),
        act_dict_value(u_day, "day", r_dict),
        act_if_has_value(g_ok, r_day),
        act_notify(
            make_uuid(s, "notify_ok"),
            "🍎 Apple 健康已同步到 Bot",
            ["日期 ", r_day, "：步数 ", r_steps, " ｜ 活动 ", r_active, " kcal"],
        ),
        act_otherwise(g_ok),
        act_notify(make_uuid(s, "notify_err"), "⚠️ 健康同步失败", ["返回：", r_http]),
        act_end_if(g_ok),
    ]
    return wrap_workflow(
        "同步 Apple 健康到 Bot",
        59846,
        4292093695,
        actions,
        url_action_index=1,
        token_action_index=2,
    )


def build_meals_bot_to_apple() -> dict[str, Any]:
    s = "meals-bot-to-apple"
    u_url = make_uuid(s, "url")
    u_tok = make_uuid(s, "tok")
    u_http_get = make_uuid(s, "http_get")
    u_dict = make_uuid(s, "dict")
    u_items = make_uuid(s, "items")
    u_count = make_uuid(s, "count")
    g_has_items = make_uuid(s, "if_has_items")
    g_loop = make_uuid(s, "loop")
    u_loop_end = make_uuid(s, "loop_end")

    r_url = action_output_ref(u_url, "Text")
    r_tok = action_output_ref(u_tok, "Text")
    r_http_get = action_output_ref(u_http_get, "Contents of URL")
    r_dict = action_output_ref(u_dict, "Dictionary")
    r_items = action_output_ref(u_items, "Dictionary Value")
    r_count = action_output_ref(u_count, "Count")
    r_rep = variable_ref("Repeat Item")

    u_cal = make_uuid(s, "loop_cal")
    u_pro = make_uuid(s, "loop_pro")
    u_carb = make_uuid(s, "loop_carb")
    u_fat = make_uuid(s, "loop_fat")
    u_id = make_uuid(s, "loop_id")
    g_cal = make_uuid(s, "if_cal")
    g_pro = make_uuid(s, "if_pro")
    g_carb = make_uuid(s, "if_carb")
    g_fat = make_uuid(s, "if_fat")

    r_cal = action_output_ref(u_cal, "Dictionary Value")
    r_pro = action_output_ref(u_pro, "Dictionary Value")
    r_carb = action_output_ref(u_carb, "Dictionary Value")
    r_fat = action_output_ref(u_fat, "Dictionary Value")
    r_repeat_results = action_output_ref(u_loop_end, "Repeat Results")

    actions = [
        act_comment("从 QQ Bot 拉取尚未写入 Apple 健康的记餐记录，写入膳食能量/三大营养素后确认出队。"),
        act_text(u_url, "https://你的服务器地址"),
        act_text(u_tok, "在此填入个人同步Token"),
        act_http_json(u_http_get, "GET", [r_url, "/bridge/health/pending"], r_tok),
        act_detect_dict(u_dict, r_http_get),
        act_dict_value(u_items, "items", r_dict),
        act_count(u_count, r_items),
        act_if_gt(g_has_items, r_count, "0"),
        action("is.workflow.actions.repeat.each", {
            "GroupingIdentifier": g_loop,
            "WFControlFlowMode": 0,
            "WFInput": token_attachment(r_items),
        }),
        act_dict_value(u_cal, "calories", r_rep),
        act_if_gt(g_cal, r_cal, "0"),
        act_log_health(make_uuid(s, "log_cal"), "Dietary Energy", r_cal, "kcal"),
        act_end_if(g_cal),
        act_dict_value(u_pro, "proteinG", r_rep),
        act_if_gt(g_pro, r_pro, "0"),
        act_log_health(make_uuid(s, "log_pro"), "Protein", r_pro, "g"),
        act_end_if(g_pro),
        act_dict_value(u_carb, "carbsG", r_rep),
        act_if_gt(g_carb, r_carb, "0"),
        act_log_health(make_uuid(s, "log_carb"), "Carbohydrates", r_carb, "g"),
        act_end_if(g_carb),
        act_dict_value(u_fat, "fatG", r_rep),
        act_if_gt(g_fat, r_fat, "0"),
        act_log_health(make_uuid(s, "log_fat"), "Total Fat", r_fat, "g"),
        act_end_if(g_fat),
        # Last action inside Repeat Each feeds Repeat Results -> collected ID list
        act_dict_value(None, "id", r_rep),
        action("is.workflow.actions.repeat.each", {
            "UUID": u_loop_end,
            "GroupingIdentifier": g_loop,
            "WFControlFlowMode": 2,
        }),
        act_http_json(
            make_uuid(s, "http_ack"),
            "POST",
            [r_url, "/bridge/health/ack"],
            r_tok,
            [dict_text_item("ids", [r_repeat_results])],
        ),
        act_notify(
            make_uuid(s, "notify_ok"),
            "🍎 已写回 Apple 健康",
            ["已将 Bot 记录的 ", r_count, " 餐热量与营养素写入 Apple 健康"],
        ),
        act_otherwise(g_has_items),
        act_notify(
            make_uuid(s, "notify_empty"),
            "Apple 健康已最新",
            ["暂无待写回的记餐记录"],
        ),
        act_end_if(g_has_items),
    ]
    return wrap_workflow(
        "Bot 记餐写回 Apple 健康",
        59754,
        431817727,
        actions,
        url_action_index=1,
        token_action_index=2,
    )


def build_quick_log_meal() -> dict[str, Any]:
    s = "quick-log-meal"
    u_url = make_uuid(s, "url")
    u_tok = make_uuid(s, "tok")
    g_mode = make_uuid(s, "menu_mode")

    r_url = action_output_ref(u_url, "Text")
    r_tok = action_output_ref(u_tok, "Text")
    r_resp_var = variable_ref("LogResponse")

    u_clip = make_uuid(s, "clip")
    u_clip_imgs = make_uuid(s, "clip_imgs")
    u_clip_cnt = make_uuid(s, "clip_img_cnt")
    g_clip_img = make_uuid(s, "if_clip_img")
    u_clip_r = make_uuid(s, "clip_resize")
    u_clip_c = make_uuid(s, "clip_conv")
    u_clip_b = make_uuid(s, "clip_b64")
    u_clip_img_http = make_uuid(s, "clip_img_http")
    u_clip_txt = make_uuid(s, "clip_txt")
    g_clip_txt = make_uuid(s, "if_clip_txt")
    u_clip_txt_http = make_uuid(s, "clip_txt_http")
    u_ask_empty = make_uuid(s, "ask_empty")
    u_empty_http = make_uuid(s, "empty_http")

    u_clip2 = make_uuid(s, "clip2")
    u_clip2_txt = make_uuid(s, "clip2_txt")
    u_ask = make_uuid(s, "ask_food")
    u_text_http = make_uuid(s, "http_text")

    u_cam = make_uuid(s, "take_photo")
    u_cam_r = make_uuid(s, "cam_resize")
    u_cam_c = make_uuid(s, "cam_conv")
    u_cam_b = make_uuid(s, "cam_b64")
    u_pick = make_uuid(s, "select_photo")
    u_pick_r = make_uuid(s, "pick_resize")
    u_pick_c = make_uuid(s, "pick_conv")
    u_pick_b = make_uuid(s, "pick_b64")

    u_resp_dict = make_uuid(s, "resp_dict")
    u_cal = make_uuid(s, "cal")
    u_pro = make_uuid(s, "pro")
    u_carb = make_uuid(s, "carb")
    u_fat = make_uuid(s, "fat")
    u_id = make_uuid(s, "id")
    u_note = make_uuid(s, "note")

    g_ok = make_uuid(s, "if_ok")
    g_cal = make_uuid(s, "if_cal")
    g_pro = make_uuid(s, "if_pro")
    g_carb = make_uuid(s, "if_carb")
    g_fat = make_uuid(s, "if_fat")

    r_dict = action_output_ref(u_resp_dict, "Dictionary")
    r_cal = action_output_ref(u_cal, "Dictionary Value")
    r_pro = action_output_ref(u_pro, "Dictionary Value")
    r_carb = action_output_ref(u_carb, "Dictionary Value")
    r_fat = action_output_ref(u_fat, "Dictionary Value")
    r_id = action_output_ref(u_id, "Dictionary Value")
    r_note = action_output_ref(u_note, "Dictionary Value")

    def image_to_log_actions(tag: str, src_ref: dict[str, Any], u_r: str, u_c: str, u_b: str, u_http: str) -> list[dict[str, Any]]:
        return [
            action("is.workflow.actions.image.resize", {
                "UUID": u_r,
                "WFImageResizeKey": "Longest Edge",
                "WFImageResizeLength": 1024,
                "WFImage": token_attachment(src_ref),
            }),
            action("is.workflow.actions.image.convert", {
                "UUID": u_c,
                "WFImageFormat": "JPEG",
                "WFImageCompressionQuality": 0.72,
                "WFImagePreserveMetadata": False,
                "WFInput": token_attachment(action_output_ref(u_r, "Resized Image")),
            }),
            action("is.workflow.actions.base64encode", {
                "UUID": u_b,
                "WFEncodeMode": "Encode",
                "WFBase64LineBreakMode": "None",
                "WFInput": token_attachment(action_output_ref(u_c, "Converted Image")),
            }),
            act_http_json(
                u_http,
                "POST",
                [r_url, "/bridge/health/log"],
                r_tok,
                [
                    dict_text_item("mealType", ["auto"]),
                    dict_text_item("imageBase64", [action_output_ref(u_b, "Base64 Encoded")]),
                ],
            ),
            act_set_variable("LogResponse", action_output_ref(u_http, "Contents of URL")),
        ]

    mode_labels = [
        "识别剪贴板内容（文字 / 截图）",
        "粘贴或输入文字（自动带入剪贴板）",
        "拍照识别食物",
        "从相册选照片",
    ]
    r_clip = action_output_ref(u_clip, "Clipboard")
    r_clip_imgs = action_output_ref(u_clip_imgs, "Images")
    r_clip_cnt = action_output_ref(u_clip_cnt, "Count")
    r_clip_txt = action_output_ref(u_clip_txt, "Text")
    r_clip2 = action_output_ref(u_clip2, "Clipboard")
    r_clip2_txt = action_output_ref(u_clip2_txt, "Text")

    actions: list[dict[str, Any]] = [
        act_comment("桌面一键记一餐：优先支持直接识别剪贴板中复制的菜名/外卖文字或截图，也支持粘贴编辑、拍照与相册选图，调用 DeepSeek / 识图估算热量与营养并写入 Apple 健康。"),
        act_text(u_url, "https://你的服务器地址"),
        act_text(u_tok, "在此填入个人同步Token"),
        action("is.workflow.actions.choosefrommenu", {
            "GroupingIdentifier": g_mode,
            "WFControlFlowMode": 0,
            "WFMenuPrompt": "如何记这一餐？",
            "WFMenuItems": mode_labels,
        }),
        # Case 1: One-tap recognize whatever was just copied (screenshot or text)
        action("is.workflow.actions.choosefrommenu", {
            "GroupingIdentifier": g_mode,
            "WFControlFlowMode": 1,
            "WFMenuItemTitle": mode_labels[0],
        }),
        act_get_clipboard(u_clip),
        act_detect_images(u_clip_imgs, r_clip),
        act_count(u_clip_cnt, r_clip_imgs),
        act_if_gt(g_clip_img, r_clip_cnt, "0"),
        *image_to_log_actions("clip_img", r_clip_imgs, u_clip_r, u_clip_c, u_clip_b, u_clip_img_http),
        act_otherwise(g_clip_img),
        act_detect_text(u_clip_txt, r_clip),
        act_if_has_value(g_clip_txt, r_clip_txt),
        act_http_json(
            u_clip_txt_http,
            "POST",
            [r_url, "/bridge/health/log"],
            r_tok,
            [
                dict_text_item("mealType", ["auto"]),
                dict_text_item("text", [r_clip_txt]),
            ],
        ),
        act_set_variable("LogResponse", action_output_ref(u_clip_txt_http, "Contents of URL")),
        act_otherwise(g_clip_txt),
        action("is.workflow.actions.ask", {
            "UUID": u_ask_empty,
            "WFAskActionPrompt": "剪贴板为空，请粘贴或输入吃了什么（如：牛肉面 1 碗）：",
            "WFInputType": "Text",
        }),
        act_http_json(
            u_empty_http,
            "POST",
            [r_url, "/bridge/health/log"],
            r_tok,
            [
                dict_text_item("mealType", ["auto"]),
                dict_text_item("text", [action_output_ref(u_ask_empty, "Provided Input")]),
            ],
        ),
        act_set_variable("LogResponse", action_output_ref(u_empty_http, "Contents of URL")),
        act_end_if(g_clip_txt),
        act_end_if(g_clip_img),
        # Case 2: Paste / edit text pre-populated with clipboard text
        action("is.workflow.actions.choosefrommenu", {
            "GroupingIdentifier": g_mode,
            "WFControlFlowMode": 1,
            "WFMenuItemTitle": mode_labels[1],
        }),
        act_get_clipboard(u_clip2),
        act_detect_text(u_clip2_txt, r_clip2),
        action("is.workflow.actions.ask", {
            "UUID": u_ask,
            "WFAskActionPrompt": "粘贴或修改这一餐吃了什么（可在开头写 早/中/晚）：",
            "WFInputType": "Text",
            "WFAskActionDefaultAnswer": token_string([r_clip2_txt]),
        }),
        act_http_json(
            u_text_http,
            "POST",
            [r_url, "/bridge/health/log"],
            r_tok,
            [
                dict_text_item("mealType", ["auto"]),
                dict_text_item("text", [action_output_ref(u_ask, "Provided Input")]),
            ],
        ),
        act_set_variable("LogResponse", action_output_ref(u_text_http, "Contents of URL")),
        # Case 3: Camera
        action("is.workflow.actions.choosefrommenu", {
            "GroupingIdentifier": g_mode,
            "WFControlFlowMode": 1,
            "WFMenuItemTitle": mode_labels[2],
        }),
        action("is.workflow.actions.takephoto", {
            "UUID": u_cam,
            "WFCameraCaptureShowPreview": True,
            "WFPhotoCount": 1,
        }),
        *image_to_log_actions("cam", action_output_ref(u_cam, "Photo"), u_cam_r, u_cam_c, u_cam_b, make_uuid(s, "http_cam")),
        # Case 4: Photo library
        action("is.workflow.actions.choosefrommenu", {
            "GroupingIdentifier": g_mode,
            "WFControlFlowMode": 1,
            "WFMenuItemTitle": mode_labels[3],
        }),
        action("is.workflow.actions.selectphoto", {
            "UUID": u_pick,
            "WFSelectMultiplePhotos": False,
        }),
        *image_to_log_actions("pick", action_output_ref(u_pick, "Photos"), u_pick_r, u_pick_c, u_pick_b, make_uuid(s, "http_pick")),
        action("is.workflow.actions.choosefrommenu", {
            "GroupingIdentifier": g_mode,
            "WFControlFlowMode": 2,
        }),
        act_detect_dict(u_resp_dict, r_resp_var),
        act_dict_value(u_id, "id", r_dict),
        act_if_has_value(g_ok, r_id),
        act_dict_value(u_cal, "calories", r_dict),
        act_if_gt(g_cal, r_cal, "0"),
        act_log_health(make_uuid(s, "log_cal"), "Dietary Energy", r_cal, "kcal"),
        act_end_if(g_cal),
        act_dict_value(u_pro, "proteinG", r_dict),
        act_if_gt(g_pro, r_pro, "0"),
        act_log_health(make_uuid(s, "log_pro"), "Protein", r_pro, "g"),
        act_end_if(g_pro),
        act_dict_value(u_carb, "carbsG", r_dict),
        act_if_gt(g_carb, r_carb, "0"),
        act_log_health(make_uuid(s, "log_carb"), "Carbohydrates", r_carb, "g"),
        act_end_if(g_carb),
        act_dict_value(u_fat, "fatG", r_dict),
        act_if_gt(g_fat, r_fat, "0"),
        act_log_health(make_uuid(s, "log_fat"), "Total Fat", r_fat, "g"),
        act_end_if(g_fat),
        act_http_json(
            make_uuid(s, "http_ack"),
            "POST",
            [r_url, "/bridge/health/ack"],
            r_tok,
            [dict_text_item("ids", [r_id])],
        ),
        act_dict_value(u_note, "notificationText", r_dict),
        act_notify(make_uuid(s, "notify_ok"), "✅ 已记餐并写入 Apple 健康", [r_note]),
        act_otherwise(g_ok),
        act_notify(make_uuid(s, "notify_err"), "⚠️ 记餐未成功", [r_resp_var]),
        act_end_if(g_ok),
    ]
    return wrap_workflow(
        "桌面一键记一餐",
        59842,
        4282601983,
        actions,
        url_action_index=1,
        token_action_index=2,
    )


SHORTCUTS = {
    "health-sync-apple-to-bot.shortcut": build_sync_apple_to_bot,
    "health-meals-bot-to-apple.shortcut": build_meals_bot_to_apple,
    "health-quick-log-meal.shortcut": build_quick_log_meal,
}


def build_all(output_dir: Path, xml_dir: Path | None = None, sign: bool = True) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    if xml_dir:
        xml_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="qqbot-shortcuts-") as tmp:
        tmp_path = Path(tmp)
        for filename, builder in SHORTCUTS.items():
            workflow = builder()
            xml_path = (xml_dir / f"{filename}.xml") if xml_dir else (tmp_path / f"{filename}.xml")
            bplist_path = tmp_path / f"unsigned-{filename}"
            out_path = output_dir / filename

            with open(xml_path, "wb") as fh:
                plistlib.dump(workflow, fh, fmt=plistlib.FMT_XML, sort_keys=False)

            subprocess.run(["plutil", "-lint", str(xml_path)], check=True)
            with open(bplist_path, "wb") as fh:
                plistlib.dump(workflow, fh, fmt=plistlib.FMT_BINARY, sort_keys=False)

            if sign:
                subprocess.run(
                    ["/usr/bin/shortcuts", "sign", "--mode", "anyone", "--input", str(bplist_path), "--output", str(out_path)],
                    check=True,
                )
            else:
                shutil.copy2(bplist_path, out_path)
            os.chmod(out_path, 0o644)
            print(f"Built {out_path} ({out_path.stat().st_size} bytes, signed={sign})")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and sign Apple Health Shortcuts")
    parser.add_argument("--out-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--xml-dir", type=Path, default=None, help="Optional directory to also dump XML plists for inspection")
    parser.add_argument("--unsigned", action="store_true", help="Skip Apple shortcuts signing (non-macOS dev only)")
    args = parser.parse_args()

    if not args.unsigned and sys.platform != "darwin":
        raise SystemExit("Apple .shortcut signing requires macOS (/usr/bin/shortcuts).")
    build_all(args.out_dir, xml_dir=args.xml_dir, sign=not args.unsigned)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
