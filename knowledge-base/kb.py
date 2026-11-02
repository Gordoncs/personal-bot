#!/usr/bin/env python3
"""零依赖飞书知识库 CLI。所有结构来自运行时 schema；默认只预览。"""
import argparse
import copy
import http.client
import json
import math
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://open.feishu.cn/open-apis"
CST = timezone(timedelta(hours=8), "Asia/Shanghai")
TYPE_NAMES = {1: "文本", 2: "数字", 3: "单选", 4: "多选", 5: "日期",
              7: "复选框", 11: "人员", 13: "电话号码", 15: "超链接",
              17: "附件", 18: "单向关联", 19: "查找引用", 20: "公式",
              21: "双向关联", 22: "地理位置", 23: "群组", 1001: "创建时间",
              1002: "最后更新时间", 1003: "创建人", 1004: "修改人", 1005: "自动编号"}
CONFIG_KEYS = ("FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BITABLE_APP_TOKEN")
READ_ONLY_TYPES = {19, 20, 1001, 1002, 1003, 1004, 1005}
TEMPLATE = json.loads(Path(__file__).with_name("schema.json").read_text(encoding="utf-8"))
SYSTEM_TABLES = {"成员", "任务", "进度", "通知"}


def template(members):
    result = copy.deepcopy(TEMPLATE)
    for fields in result.values():
        for field in fields:
            if field.pop("member_options", False):
                field["property"] = {"options": [{"name": m["名称"]} for m in members]}
    return result


def valid_member_id(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise KBError("成员 ID 只能包含字母、数字、下划线和短横线")
    return value


class KBError(Exception):
    pass


class Redactor:
    def __init__(self, values=()):
        self.values = set()
        for value in values:
            self.add(value)

    def add(self, value):
        if value:
            self.values.add(str(value))
            self.values.add(urllib.parse.quote(str(value), safe=""))

    def clean(self, value):
        result = str(value)
        for secret in sorted(self.values, key=len, reverse=True):
            result = result.replace(secret, "[已隐藏]")
        return result


def load_config(env_file=None, environ=None):
    config = dict(os.environ if environ is None else environ)
    if env_file:
        try:
            lines = Path(env_file).read_text(encoding="utf-8-sig").splitlines()
        except (OSError, UnicodeError):
            raise KBError("无法读取 env 文件") from None
        for index, line in enumerate(lines, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            key, sep, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise KBError("env 文件第 %d 行格式错误" % index)
            if value.startswith(('"', "'")):
                quote = value[0]
                end = value.find(quote, 1)
                if end < 0 or (value[end + 1:].strip() and
                               not value[end + 1:].lstrip().startswith("#")):
                    raise KBError("env 文件第 %d 行引号错误" % index)
                value = value[1:end]
            else:
                value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
            # 显式文件覆盖同名环境变量，不执行 shell 展开。
            config[key] = value
    if any(not config.get(key) for key in CONFIG_KEYS):
        raise KBError("缺少配置：请设置 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_BITABLE_APP_TOKEN")
    return config


def text(value):
    if value is None:
        return ""
    if isinstance(value, list):
        return "".join(text(item) for item in value)
    if isinstance(value, dict):
        for key in ("text", "name", "link", "value"):
            if key in value:
                return text(value[key])
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def date_ms(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise KBError("日期必须是 YYYY-MM-DD")
    try:
        return int(datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=CST).timestamp() * 1000)
    except (ValueError, OverflowError):
        raise KBError("无效日期，必须是 YYYY-MM-DD") from None


def display(value, field):
    if field.get("type") in (5, 1001, 1002) and value is not None and value != "":
        try:
            return datetime.fromtimestamp(float(value) / 1000, CST).strftime("%Y-%m-%d")
        except (ValueError, OverflowError, TypeError, OSError):
            raise KBError("服务端日期值无效") from None
    return text(value)


class HTTP:
    """最多三次退避重试；不回显 URL、响应体、凭证或底层异常。"""
    def __init__(self, redactor=None, opener=None, sleep=None):
        self.redactor = redactor or Redactor()
        self.opener = opener or urllib.request.urlopen
        self.sleep = sleep or time.sleep

    def request(self, method, path, body=None, token=None):
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        for attempt in range(4):
            try:
                req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
                with self.opener(req, timeout=30) as response:
                    result = json.load(response)
                if not isinstance(result, dict) or "code" not in result:
                    raise KBError("飞书响应格式错误")
                if result["code"] != 0:
                    code = result["code"]
                    # msg 不直接输出，避免服务端把请求中的敏感内容带回。
                    if code in (99991672, 99991679, 91403, 1254302, 1254303, 1254304):
                        raise KBError("飞书无权限：请在表格右上角「…」→「更多」→「添加文档应用」；并检查应用 API 权限")
                    if not isinstance(code, int):
                        raise KBError("飞书业务请求失败（错误码格式无效）")
                    raise KBError("飞书业务请求失败，错误码 %d；若无权限，请在「…」→「更多」→「添加文档应用」并检查 API 权限" % code)
                if result.get("tenant_access_token"):
                    self.redactor.add(result["tenant_access_token"])
                return result
            except urllib.error.HTTPError as exc:
                retry = exc.code == 429 or 500 <= exc.code < 600
                if not retry or attempt == 3:
                    if exc.code in (401, 403):
                        raise KBError("飞书认证或权限失败，请检查凭证，并在表格「…」→「更多」→「添加文档应用」") from None
                    raise KBError("飞书 HTTP 请求失败，状态码 %d" % exc.code) from None
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                    OSError, http.client.HTTPException):
                if attempt == 3:
                    raise KBError("网络请求失败，已退避重试 3 次") from None
            except (ValueError, UnicodeError):
                raise KBError("飞书返回了无效 JSON") from None
            self.sleep(2 ** attempt)


class Client:
    def __init__(self, config, http=None):
        self.redactor = Redactor(config.get(key) for key in CONFIG_KEYS)
        self.http = http or HTTP(self.redactor)
        self.config = config
        self.prefix = config.get("KB_TABLE_PREFIX", config.get("FEISHU_TABLE_PREFIX", ""))
        self._token = None

    def api(self, method, path, body=None):
        if self._token is None:
            response = self.http.request("POST", "/auth/v3/tenant_access_token/internal",
                                         {"app_id": self.config[CONFIG_KEYS[0]],
                                          "app_secret": self.config[CONFIG_KEYS[1]]})
            self._token = response.get("tenant_access_token")
            if not self._token:
                raise KBError("认证响应缺少访问凭证")
            self.redactor.add(self._token)
        root = "/bitable/v1/apps/" + urllib.parse.quote(self.config[CONFIG_KEYS[2]], safe="")
        data = self.http.request(method, root + path, body, self._token).get("data", {})
        if not isinstance(data, dict):
            raise KBError("飞书响应的 data 格式错误")
        return data

    def pages(self, path, size=100):
        items, page, seen = [], None, set()
        while True:
            params = {"page_size": size}
            if page:
                params["page_token"] = page
            data = self.api("GET", path + "?" + urllib.parse.urlencode(params))
            items.extend(data.get("items") or [])
            if not data.get("has_more"):
                return items
            page = data.get("page_token")
            if not page or page in seen:
                raise KBError("飞书分页响应无效，已停止读取")
            seen.add(page)

    def tables(self):
        return self.pages("/tables")

    def fields(self, tid):
        return self.pages("/tables/%s/fields" % urllib.parse.quote(tid, safe=""))

    def records(self, tid):
        return self.pages("/tables/%s/records" % urllib.parse.quote(tid, safe=""), 500)

    def record(self, tid, rid):
        data = self.api("GET", "/tables/%s/records/%s" % (urllib.parse.quote(tid, safe=""),
                                                        urllib.parse.quote(rid, safe="")))
        row = data.get("record")
        if not isinstance(row, dict) or row.get("record_id") != rid or not isinstance(row.get("fields"), dict):
            raise KBError("回读响应缺少有效记录或字段")
        return row

    def write(self, tid, fields, rid=None):
        path = "/tables/%s/records" % urllib.parse.quote(tid, safe="")
        if rid:
            path += "/" + urllib.parse.quote(rid, safe="")
        data = self.api("PUT" if rid else "POST", path, {"fields": fields})
        record = data.get("record") or {}
        if not record.get("record_id"):
            raise KBError("写入响应缺少 record_id，结果不确定；请先读取核实，不要直接重试")
        return record["record_id"]


class KB:
    def __init__(self, client, now=None):
        self.client = client
        self.now = now or (lambda: datetime.now(CST))
        self._tables = None

    def init(self, name, extra=(), yes=False):
        """结构变更唯一入口。先完整预检，再执行；从不删除或改名。"""
        existing = {t["name"]: t for t in self.client.tables()}
        schemas = {}
        for logical in TEMPLATE:
            raw = existing.get(self.client.prefix + logical)
            if raw:
                schemas[logical] = self.client.fields(raw["table_id"])
        members = []
        raw = existing.get(self.client.prefix + "成员")
        if raw:
            for row in self.client.records(raw["table_id"]):
                f = row["fields"]
                mid, label = text(f.get("ID")), text(f.get("名称"))
                if not mid or not label:
                    raise KBError("成员表有缺少 ID 或名称的记录，请先在飞书中核实")
                valid_member_id(mid)
                members.append({"ID": mid, "名称": label, "别名": text(f.get("别名"))})
        if len({m["ID"].lower() for m in members}) != len(members) or len({m["名称"].casefold() for m in members}) != len(members):
            raise KBError("成员表 ID 或名称重复，请先在飞书中核实")
        added = []
        for spec in [name, *extra]:
            label, sep, mid = spec.partition(":")
            label, mid = label.strip(), mid.strip()
            if not label:
                raise KBError("成员名称不能为空")
            found = next((m for m in members if m["名称"].casefold() == label.casefold()), None)
            if found:
                if sep and mid != found["ID"]:
                    raise KBError("已有成员名称对应不同 ID；init 不改名或修改 ID")
                continue
            if not sep:
                index = 1
                while any(m["ID"].lower() == "m%d" % index for m in members):
                    index += 1
                mid = "m%d" % index
            valid_member_id(mid)
            if any(m["ID"].lower() == mid.lower() for m in members):
                raise KBError("成员 ID 已存在，请使用其他 ID")
            member = {"ID": mid, "名称": label, "别名": ""}
            members.append(member)
            added.append(member)
        desired = template(members)
        actions, lines = [], []
        for logical, fields in desired.items():
            full = self.client.prefix + logical
            raw = existing.get(full)
            lines.append("[%s表] %s，主字段：%s" % ("检查" if raw else "新建", full, fields[0]["field_name"]))
            if not raw:
                actions.append(("table", logical, fields))
            actual = {f["field_name"]: f for f in schemas.get(logical, [])}
            primary = next((f for f in actual.values() if f.get("is_primary")), None)
            if raw and (not primary or primary["field_name"] != fields[0]["field_name"]):
                raise KBError("表「%s」主字段不符；init 不会改名，请在飞书中核实" % full)
            for field in fields:
                current = actual.get(field["field_name"])
                options = field.get("property", {}).get("options", [])
                lines.append("  %s：%s%s" % (field["field_name"], TYPE_NAMES[field["type"]],
                            "，选项：" + " / ".join(o["name"] for o in options) if options else ""))
                if not raw:
                    continue
                if not current:
                    actions.append(("field", logical, field))
                elif current["type"] != field["type"]:
                    raise KBError("表「%s」字段「%s」类型不符；init 不会修改类型" % (full, field["field_name"]))
                elif options:
                    old = current.get("property", {}).get("options", [])
                    missing = [o for o in options if o["name"] not in {v["name"] for v in old}]
                    if missing:
                        merged = {"field_name": current["field_name"], "type": current["type"],
                                  "property": {**current.get("property", {}), "options": old + missing},
                                  "field_id": current["field_id"]}
                        actions.append(("options", logical, merged))
        lines.append("成员：" + json.dumps(members, ensure_ascii=False))
        lines.append("待执行结构操作：%d；新增成员：%d" % (len(actions), len(added)))
        if not yes:
            return lines + ["仅预览，无写入。确认后加 --yes 执行"]
        for kind, logical, value in actions:
            if kind == "table":
                data = self.client.api("POST", "/tables", {"table": {"name": self.client.prefix + logical, "fields": value}})
                if not data.get("table_id"):
                    raise KBError("建表响应缺少 table_id，请重新读取核实")
                existing[self.client.prefix + logical] = {"table_id": data["table_id"]}
            else:
                path = "/tables/%s/fields" % existing[self.client.prefix + logical]["table_id"]
                body = {k: v for k, v in value.items() if k != "field_id"}
                if kind == "options":
                    path += "/" + value["field_id"]
                self.client.api("PUT" if kind == "options" else "POST", path, body)
        for member in added:
            self.client.write(existing[self.client.prefix + "成员"]["table_id"], member)
        self._tables = None
        info = self.table("资料", True)
        if not self.match(info, "标题", "欢迎使用"):
            self.client.write(info["id"], {"标题": "欢迎使用", "内容": "在 Agent 对话后说「同步到知识库」，确认清单后即可保存，也可以随时查询资料、联系人和任务。", "分类": "其他", "更新时间": int(self.now().timestamp() * 1000)})
        return lines + ["初始化完成；已有表、字段、成员和欢迎记录均保留。"]

    def doctor(self):
        lines, problems = ["凭证已配置；认证和表格读取权限正常。"], []
        existing = {t["name"]: t for t in self.client.tables()}
        members = []
        mt = existing.get(self.client.prefix + "成员")
        if mt:
            members = [{"名称": text(r["fields"].get("名称"))} for r in self.client.records(mt["table_id"])]
            if not members:
                problems.append("成员表为空")
        for logical, fields in template(members).items():
            raw = existing.get(self.client.prefix + logical)
            if not raw:
                problems.append("缺表：" + logical)
                continue
            actual = {f["field_name"]: f for f in self.client.fields(raw["table_id"])}
            primary = next((f for f in actual.values() if f.get("is_primary")), {})
            if primary.get("field_name") != fields[0]["field_name"]:
                problems.append("主字段不符：" + logical + "（请在飞书中核实，init 不会改名）")
            for f in fields:
                a = actual.get(f["field_name"])
                label = logical + " / " + f["field_name"]
                if not a:
                    problems.append("缺字段：" + label)
                elif a["type"] != f["type"]:
                    problems.append("字段类型不符：" + label + "（请在飞书中核实）")
                elif f.get("property", {}).get("options"):
                    old = {o["name"] for o in a.get("property", {}).get("options", [])}
                    if any(o["name"] not in old for o in f["property"]["options"]):
                        problems.append("缺选项：" + label)
        lines += problems or ["七张模板表及字段、选项检查通过。"]
        if problems:
            lines.append("下一步：运行 kb.py init --name 你的称呼 预览，确认后加 --yes 执行。")
        lines.append("编辑和管理权限需在飞书权限管理、版本发布及文档应用中核对；doctor 不通过试写验证权限。")
        return lines

    def table(self, name, rows=False):
        if self._tables is None:
            self._tables = {t["name"]: t for t in self.client.tables()}
        full = self.client.prefix + name
        if full not in self._tables:
            raise KBError("找不到表「%s」" % full)
        raw = self._tables[full]
        fields = self.client.fields(raw["table_id"])
        primary = [f for f in fields if f.get("is_primary")]
        if len(primary) != 1:
            raise KBError("表「%s」必须有且仅有一个主字段" % full)
        return {"name": full, "base": name, "id": raw["table_id"],
                "fields": {f["field_name"]: f for f in fields},
                "primary": primary[0]["field_name"],
                "records": copy.deepcopy(self.client.records(raw["table_id"])) if rows else []}

    def schema(self, name=None):
        if name is None:
            prefix = self.client.prefix
            names = [t["name"][len(prefix):] for t in self.client.tables()
                     if t["name"].startswith(prefix)]
        else:
            names = [name]
        result = []
        for item in names:
            t = self.table(item)
            result.append({"表": t["name"], "主字段": t["primary"], "字段": [
                {"名称": f["field_name"], "类型": TYPE_NAMES.get(f["type"], "未知类型(%s)" % f["type"]),
                 "主字段": bool(f.get("is_primary")),
                 **({"选项": [o["name"] for o in f.get("property", {}).get("options", [])]}
                    if f["type"] in (3, 4) else {})} for f in t["fields"].values()]})
        return result

    def find(self, name, key=None, keyword=None, limit=None):
        if limit is not None and limit < 0:
            raise KBError("limit 不能小于 0")
        t = self.table(name, True)
        result = []
        for row in t["records"]:
            fields = {k: display(v, t["fields"].get(k, {})) for k, v in row["fields"].items()}
            if key is not None and fields.get(t["primary"], "") != key:
                continue
            if keyword is not None and not any(keyword in v for v in fields.values()):
                continue
            result.append({"record_id": row["record_id"], "fields": fields})
        return result if limit is None else result[:limit]

    def convert(self, t, fields, internal=False):
        if not isinstance(fields, dict):
            raise KBError("fields 必须是对象")
        result = {}
        for name, value in fields.items():
            f = t["fields"].get(name)
            if f is None:
                raise KBError("未知字段「%s」；可用字段：%s" % (name, "、".join(t["fields"])))
            typ = f["type"]
            if typ == 1:
                if not isinstance(value, str):
                    raise KBError("字段「%s」必须是文本" % name)
            elif typ == 2:
                if isinstance(value, bool) or not isinstance(value, (str, int, float)):
                    raise KBError("字段「%s」必须是数字或数字字符串" % name)
                try:
                    value = float(value) if isinstance(value, str) else value
                    if not math.isfinite(value):
                        raise ValueError()
                except (ValueError, OverflowError):
                    raise KBError("字段「%s」必须是有限数字" % name) from None
            elif typ == 3:
                choices = [o["name"] for o in f.get("property", {}).get("options", [])]
                if not isinstance(value, str) or value not in choices:
                    raise KBError("字段「%s」的单选值非法；可选项：%s" % (name, "、".join(choices)))
            elif typ == 5:
                if not (internal and isinstance(value, int) and not isinstance(value, bool)):
                    value = date_ms(value)
            else:
                raise KBError("字段「%s」类型为%s，暂不支持安全写入" % (name, TYPE_NAMES.get(typ, str(typ))))
            result[name] = value
        return result

    @staticmethod
    def match(t, field, key):
        found = [r for r in t["records"] if text(r["fields"].get(field)) == key]
        if len(found) > 1:
            raise KBError("「%s」存在多个完全相同的值，无法安全定位：%s" % (field, key))
        return found[0] if found else None

    @staticmethod
    def equal(t, name, a, b):
        if (a is None or a == "" or a == []) and (b is None or b == "" or b == []):
            return True
        typ = t["fields"][name]["type"]
        if typ in (2, 5):
            try:
                return a is not None and b is not None and float(a) == float(b)
            except (ValueError, TypeError, OverflowError):
                return False
        return text(a) == text(b)

    def plan(self, changes):
        if not isinstance(changes, list):
            raise KBError("changes.json 顶层必须是数组")
        tables, entries = {}, []
        for index, change in enumerate(changes, 1):
            try:
                if not isinstance(change, dict):
                    raise KBError("每项操作必须是对象")
                op = change.get("op")
                allowed = {"upsert": {"op", "table", "key", "fields"},
                           "create_task": {"op", "fields"},
                           "update_task": {"op", "id", "fields", "note"},
                           "progress": {"op", "member", "date", "text"},
                           "notify": {"op", "to", "from", "text"}}
                if not isinstance(op, str) or op not in allowed:
                    raise KBError("不支持的 op；只允许 upsert、create_task、update_task、progress、notify")
                if set(change) - allowed[op]:
                    raise KBError("操作包含不支持的参数")
                name = {"create_task": "任务", "update_task": "任务", "progress": "进度", "notify": "通知"}.get(op)
                if op == "upsert":
                    name = self.required(change, "table")
                    # name 是不含配置前缀的逻辑名称；完整表名不能绕过保护。
                    base = name[len(self.client.prefix):] if self.client.prefix and name.startswith(self.client.prefix) else name
                    if base in SYSTEM_TABLES:
                        raise KBError("受保护的表「%s」禁止 upsert" % base)
                if name not in tables:
                    tables[name] = self.table(name, True)
                t = tables[name]
                snapshot = copy.deepcopy(t["records"])
                try:
                    entry = self._one(t, change, index)
                except Exception:
                    t["records"] = snapshot
                    raise
                entries.append(entry)
            except KBError as exc:
                entries.append({"index": index, "action": "错误", "error": str(exc)})
        return entries

    @staticmethod
    def required(obj, key):
        value = obj.get(key)
        if not isinstance(value, str) or not value.strip():
            raise KBError("%s 必须是非空文本" % key)
        return value

    def _one(self, t, c, index):
        op, now = c["op"], self.now().astimezone(CST)
        stamp, row = int(now.timestamp() * 1000), None
        fields = {}
        if op == "upsert":
            key = self.required(c, "key")
            fields = self.convert(t, c.get("fields", {}))
            primary_value = self.convert(t, {t["primary"]: key})[t["primary"]]
            if t["primary"] in fields and not self.equal(t, t["primary"], fields[t["primary"]], primary_value):
                raise KBError("不允许修改主字段值；fields 中主字段必须与 key 一致")
            row = self.match(t, t["primary"], key)
            if row is None:
                fields[t["primary"]] = primary_value
        elif op == "create_task":
            user = c.get("fields", {})
            if not isinstance(user, dict):
                raise KBError("fields 必须是对象")
            if set(user) & {"编号", "创建时间", "更新时间", "备注"}:
                raise KBError("create_task 不允许设置编号、创建时间、更新时间、备注")
            title = self.required(user, "标题")
            self.required(user, "负责人")
            self.required(user, "创建人")
            for existing in t["records"]:
                f = existing["fields"]
                if text(f.get("标题")) == title and text(f.get("状态")) != "已完成":
                    raise KBError("已有同标题未完成任务：%s" % text(f.get("编号")))
            numbers = [int(m.group(1)) for r in t["records"]
                       for m in [re.fullmatch(r"T-(\d+)", text(r["fields"].get("编号"))) ] if m]
            key = "T-%04d" % (max(numbers, default=0) + 1)
            fields = self.convert(t, {"状态": "待办", **user})
            fields.update(self.convert(t, {"编号": key, "创建时间": stamp}, True))
        elif op == "update_task":
            key = self.required(c, "id")
            row = self.match(t, "编号", key)
            if row is None:
                raise KBError("找不到任务：%s" % key)
            user = c.get("fields", {})
            if not isinstance(user, dict):
                raise KBError("fields 必须是对象")
            if set(user) & {"编号", "创建人", "创建时间", "备注", "更新时间"}:
                raise KBError("不允许修改编号、创建人、创建时间、备注、更新时间；备注只能用 note 追加")
            fields = self.convert(t, user)
            if "note" in c:
                note = c["note"]
                if not isinstance(note, dict) or set(note) != {"by", "text"}:
                    raise KBError("note 必须包含且仅包含 by 和 text")
                by, content = self.required(note, "by"), self.required(note, "text")
                if t["fields"].get("负责人", {}).get("type") != 3:
                    raise KBError("负责人必须是单选字段，才能校验 note.by 的合法选项")
                self.convert(t, {"负责人": by})
                if any(ch in by + content for ch in "\r\n\u2028\u2029"):
                    raise KBError("note 的 by 和 text 必须为单行文本")
                previous = text(row["fields"].get("备注"))
                line = "%s %s：%s" % (now.isoformat(timespec="milliseconds"), by, content)
                fields.update(self.convert(t, {"备注": previous + ("" if not previous or previous.endswith("\n") else "\n") + line}))
        elif op == "progress":
            member, day, content = (self.required(c, k) for k in ("member", "date", "text"))
            fields = self.convert(t, {"成员": member, "日期": day, "内容": content})
            key = member
            matches = [r for r in t["records"] if
                       text(r["fields"].get("成员")) == member and
                       display(r["fields"].get("日期"), t["fields"]["日期"]) == day and
                       text(r["fields"].get("内容")) == content]
            if matches:
                row = matches[0]
            fields.update(self.convert(t, {"记录时间": stamp}, True))
        else:
            to, sender, content = (self.required(c, k) for k in ("to", "from", "text"))
            key = to
            fields = self.convert(t, {"收件人": to, "发件人": sender, "内容": content, "状态": "待发送"})
            fields.update(self.convert(t, {"创建时间": stamp}, True))
        before = copy.deepcopy(row["fields"]) if row else {}
        # 自动时间不把无变化变成一次更新。
        if row:
            fields = {k: v for k, v in fields.items() if not self.equal(t, k, before.get(k), v)}
        if op == "progress" and row:
            fields = {}
        if (row is None or fields) and "更新时间" in t["fields"] and t["fields"]["更新时间"]["type"] == 5:
            fields["更新时间"] = stamp
        action = "新增" if row is None else ("更新" if fields else "跳过")
        ref = row["record_id"] if row else "@new:%d" % index
        after = {**before, **fields}
        entry = {"index": index, "action": action, "op": op, "table": t["name"],
                 "table_id": t["id"], "key": key, "record_id": row["record_id"] if row else None,
                 "ref": ref, "fields": fields, "before": before, "after": after,
                 "schema": t["fields"]}
        if row:
            row["fields"] = after
        else:
            t["records"].append({"record_id": ref, "fields": after})
        return entry

    def plan_lines(self, entries):
        lines = []
        for e in entries:
            if e["action"] == "错误":
                lines.append("[错误] #%d %s" % (e["index"], e["error"]))
                continue
            changes = []
            for name, value in e["fields"].items():
                f = e["schema"][name]
                # 时间戳保留完整北京时间，便于审阅自动字段。
                fmt = lambda v: datetime.fromtimestamp(v / 1000, CST).isoformat(timespec="milliseconds") if f["type"] == 5 and isinstance(v, (int, float)) else display(v, f)
                new = json.dumps(fmt(value), ensure_ascii=False)
                old = json.dumps(fmt(e["before"].get(name)), ensure_ascii=False)
                changes.append("%s: %s → %s" % (name, old, new) if e["action"] == "更新" else "%s: %s" % (name, new))
            lines.append("[%s] %s / %s：%s" % (e["action"], e["table"], json.dumps(e["key"], ensure_ascii=False),
                                             "；".join(changes) if changes else "无变化"))
        return lines

    def apply(self, entries, allow_large=False):
        if any(e["action"] == "错误" for e in entries):
            raise KBError("预检存在错误，整批未执行")
        if len(entries) > 20 and not allow_large:
            raise KBError("超过 20 条操作，必须额外加 --allow-large；整批未执行")
        reports, resolved, failed = [], {}, False
        for e in entries:
            rid = resolved.get(e["ref"], e["record_id"])
            report = {"操作": e["action"], "表": e["table"], "主字段值": e["key"],
                      "record_id": rid, "成功": False}
            if failed:
                report["错误"] = "前一条失败，未执行；请重新读取并规划剩余操作"
                reports.append(report)
                continue
            try:
                t = {"fields": e["schema"]}
                if rid:
                    current = self.client.record(e["table_id"], rid)["fields"]
                    # 写前再次读取，防止覆盖计划后被修改的字段（尤其是追加备注）。
                    for name in e["schema"]:
                        if e["schema"][name]["type"] in READ_ONLY_TYPES:
                            continue
                        if name in e["before"] or name in current:
                            if not self.equal(t, name, current.get(name), e["before"].get(name)):
                                if current.get(name) is None and e["before"].get(name) is None:
                                    continue
                                raise KBError("记录在预检后发生变化，已停止；请重新 plan")
                if e["action"] != "跳过":
                    rid = self.client.write(e["table_id"], e["fields"], rid)
                    report["record_id"] = rid
                    resolved[e["ref"]] = rid
                current = self.client.record(e["table_id"], rid)["fields"]
                for name, value in e["after"].items():
                    # 公式、系统修改时间等可能因本次写入合法改变。
                    if e["schema"][name]["type"] in READ_ONLY_TYPES:
                        continue
                    if not self.equal(t, name, current.get(name), value):
                        raise KBError("回读校验不一致，字段：%s；写入可能已完成，请先读取核实" % name)
                report["成功"] = True
            except KBError as exc:
                report["错误"] = str(exc)
                failed = True
            reports.append(report)
        return reports


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise KBError("命令参数错误，请运行 --help 查看用法")


def parser():
    p = Parser(description=__doc__)
    p.add_argument("--env-file", help="KEY=VALUE 配置文件；显式文件覆盖环境变量")
    sub = p.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="预览或幂等初始化固定模板；唯一结构写入口")
    init.add_argument("--name", required=True, help="你的称呼（也可 名称:ID）")
    init.add_argument("--member", nargs="+", action="extend", default=[], help="其他成员，名称或 名称:ID")
    init.add_argument("--yes", action="store_true")
    sub.add_parser("doctor", help="只读检查凭证、权限与模板完整性")
    s = sub.add_parser("schema", help="读取表结构（JSON）")
    s.add_argument("table", nargs="?")
    f = sub.add_parser("find", help="读取、筛选记录（JSON）")
    f.add_argument("table")
    f.add_argument("--key")
    f.add_argument("--keyword")
    f.add_argument("--limit", type=int)
    for name in ("plan", "apply"):
        cmd = sub.add_parser(name, help="校验预览" if name == "plan" else "预检、写入并回读")
        cmd.add_argument("changes")
        if name == "apply":
            cmd.add_argument("--yes", action="store_true", help="已获得写入人对清单的确认")
            cmd.add_argument("--allow-large", action="store_true")
    return p


def read_changes(path):
    try:
        def bad_constant(value):
            raise ValueError()
        return json.loads(Path(path).read_text(encoding="utf-8-sig"), parse_constant=bad_constant)
    except (OSError, UnicodeError, ValueError):
        raise KBError("无法读取 changes 文件，或文件不是合法 JSON") from None


def main(argv=None, client=None, stdout=None, stderr=None):
    stdout, stderr = stdout or sys.stdout, stderr or sys.stderr
    redactor = Redactor(os.environ.get(key) for key in CONFIG_KEYS)
    def emit(value, stream=stdout):
        stream.write(redactor.clean(value) + "\n")
    try:
        args = parser().parse_args(argv)
        if client is None:
            config = load_config(args.env_file)
            redactor = Redactor(config.get(key) for key in CONFIG_KEYS)
            client = Client(config)
        redactor.values.update(client.redactor.values)
        kb = KB(client)
        if args.command == "init":
            output = kb.init(args.name, args.member, args.yes)
        elif args.command == "doctor":
            output = kb.doctor()
        elif args.command == "schema":
            output = kb.schema(args.table)
        elif args.command == "find":
            output = kb.find(args.table, args.key, args.keyword, args.limit)
        else:
            entries = kb.plan(read_changes(args.changes))
            redactor.values.update(client.redactor.values)
            for line in kb.plan_lines(entries):
                emit(line)
            if any(e["action"] == "错误" for e in entries):
                emit("预检失败，整批未执行", stderr)
                return 1
            if args.command == "plan":
                return 0
            if not args.yes:
                emit("仅预览：必须先让写入人确认以上清单，再使用 apply --yes。")
                return 0
            output = kb.apply(entries, args.allow_large)
            redactor.values.update(client.redactor.values)
            emit(json.dumps(output, ensure_ascii=False, indent=2))
            return 0 if all(r["成功"] for r in output) else 1
        redactor.values.update(client.redactor.values)
        emit(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except KBError as exc:
        if client is not None:
            redactor.values.update(client.redactor.values)
        emit("[错误] " + str(exc) + "；下一步：检查本地环境变量、应用发布及文档应用权限，运行 kb.py doctor。", stderr)
        return 1
    except KeyboardInterrupt:
        emit("[错误] 操作已中断；如已开始写入，请重新读取核实", stderr)
        return 130
    except Exception:
        # 禁止 traceback 泄露包含凭证的请求、路径或第三方异常信息。
        if client is not None:
            redactor.values.update(client.redactor.values)
        emit("[错误] 未预期的响应或运行错误；如已开始写入，请读取核实。", stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
