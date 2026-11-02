#!/usr/bin/env python3
"""python3 -I test_kb.py；在线测试另需 KB_ONLINE_TEST=1。"""
import copy
import hashlib
import http.client
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

# -I 不包含脚本目录；按绝对文件路径加载同目录的单文件工具。
ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("kb_under_test", ROOT / "kb.py")
kb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kb)
NOW = datetime(2026, 11, 1, 14, 30, 0, 123000, tzinfo=kb.CST)
CONFIG = {"FEISHU_APP_ID": "fixture-app", "FEISHU_APP_SECRET": "fixture-private-secret",
          "FEISHU_BITABLE_APP_TOKEN": "fixture-base-token", "KB_TABLE_PREFIX": ""}


def field(name, typ=1, options=None, primary=False):
    f = {"field_name": name, "type": typ, "is_primary": primary}
    if options is not None:
        f["property"] = {"options": [{"name": o} for o in options]}
    return f


def fixtures():
    result = {"扩展资料": [field("主键", primary=True), field("类型", 3, ["已有", "新增"]),
                        field("金额(元)", 2), field("当前状态"), field("更新时间", 5), field("入口", 15)]}
    for name, fields in kb.template([{"名称": "甲"}, {"名称": "乙"}]).items():
        result[name] = [{**f, "is_primary": i == 0, "field_id": "f%d" % i} for i, f in enumerate(fields)]
    result["数据表"] = [field("名称", primary=True)]
    return result


class FakeHTTP:
    """替换 HTTP 层，保留真实 Client、分页、读写路径和序列化逻辑。"""
    def __init__(self, prefix=""):
        self.schemas = {"table%d" % i: fs for i, fs in enumerate(fixtures().values())}
        self.table_list = [{"name": prefix + name, "table_id": "table%d" % i}
                           for i, name in enumerate(fixtures())]
        self.rows = {tid: [] for tid in self.schemas}
        self.calls = []
        self.count = 0
        self.corrupt = False
        self.fail_write = False
        self.paginate = False

    def tid(self, name):
        return next(t["table_id"] for t in self.table_list if t["name"].endswith(name))

    def add(self, name, fields):
        self.count += 1
        row = {"record_id": "rec%d" % self.count, "fields": copy.deepcopy(fields)}
        self.rows[self.tid(name)].append(row)
        return row

    def request(self, method, path, body=None, token=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path.startswith("/auth/"):
            return {"code": 0, "tenant_access_token": "fixture-tenant-token"}
        parsed = urllib.parse.urlsplit(path)
        route = parsed.path.split("/apps/", 1)[1].split("/", 1)[1]
        parts = route.split("/")
        if route == "tables":
            if method == "POST":
                tid = "table%d" % (len(self.schemas) + 10)
                self.table_list.append({"name": body["table"]["name"], "table_id": tid})
                self.schemas[tid] = [{**f, "field_id": "f%d" % i, "is_primary": i == 0}
                                     for i, f in enumerate(body["table"]["fields"])]
                self.rows[tid] = []
                data = {"table_id": tid}
            else:
                data = {"items": self.table_list}
        elif "fields" in parts:
            fs = self.schemas[parts[1]]
            if method == "POST":
                fs.append({**body, "field_id": "f%d" % len(fs), "is_primary": False})
                data = {"field": fs[-1]}
            elif method == "PUT":
                f = next(f for f in fs if f["field_id"] == parts[3])
                f.update(copy.deepcopy(body))
                data = {"field": f}
            else:
                data = {"items": fs}
        elif "records" in parts:
            rows = self.rows[parts[1]]
            if method == "GET" and len(parts) == 4:
                data = {"record": next(r for r in rows if r["record_id"] == parts[3])}
            elif method == "GET":
                data = {"items": rows}
            elif method in ("PUT", "POST"):
                if self.fail_write:
                    raise kb.KBError("模拟写入失败")
                if method == "PUT":
                    row = next(r for r in rows if r["record_id"] == parts[3])
                    row["fields"].update(copy.deepcopy(body["fields"]))
                else:
                    self.count += 1
                    row = {"record_id": "rec%d" % self.count, "fields": copy.deepcopy(body["fields"])}
                    rows.append(row)
                if self.corrupt:
                    row["fields"][next(iter(body["fields"]))] = "回读损坏"
                data = {"record": row}
            else:
                raise AssertionError("unexpected method")
        else:
            raise AssertionError("unexpected route")
        if self.paginate and "items" in data:
            start = int(urllib.parse.parse_qs(parsed.query).get("page_token", ["0"])[0])
            items = data["items"]
            data = {"items": items[start:start + 1], "has_more": start + 1 < len(items),
                    "page_token": str(start + 1)}
        return copy.deepcopy({"code": 0, "data": data})

    def writes(self):
        return [c for c in self.calls if c[0] in ("PUT", "POST") and not c[1].startswith("/auth/")]


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.http = FakeHTTP()
        self.client = kb.Client(CONFIG, self.http)
        self.k = kb.KB(self.client, lambda: NOW)

    def plan(self, change):
        return self.k.plan([change])[0]

    def task(self, title="测试任务", **extra):
        return {"op": "create_task", "fields": {"标题": title, "负责人": "甲", "创建人": "乙", **extra}}

    def assertError(self, c, part):
        entry = self.plan(c)
        self.assertEqual(entry["action"], "错误")
        self.assertIn(part, entry["error"])
        self.assertFalse(self.http.writes())

    def test_unknown_field_and_invalid_option(self):
        self.assertError({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"拼错": "x"}}, "可用字段")
        self.assertError({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"类型": "潜在扩展资料"}}, "已有、新增")

    def test_dates_numbers_and_unsupported_types(self):
        e = self.plan(self.task(截止日期="2026-11-07"))
        self.assertEqual(e["fields"]["截止日期"], 1793980800000)
        self.assertError(self.task(截止日期="2026-02-30"), "无效日期")
        for value in ("2026-1-01", 123, None):
            self.assertError(self.task(截止日期=value), "YYYY-MM-DD")
        for value in (True, [], "NaN", "Infinity", "abc"):
            self.assertError({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"金额(元)": value}}, "数字")
        e = self.plan({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"金额(元)": "12.50"}})
        self.assertEqual(e["fields"]["金额(元)"], 12.5)
        self.assertError({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"入口": "url"}}, "暂不支持")

    def test_upsert_create_update_skip_and_primary(self):
        self.http.add("扩展资料", {"主键": [{"text": "A"}], "当前状态": "旧", "类型": "已有"})
        e = self.plan({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"当前状态": "新"}})
        self.assertEqual(e["action"], "更新")
        self.assertEqual(set(e["fields"]), {"当前状态", "更新时间"})
        report = self.k.apply([e])
        self.assertTrue(report[0]["成功"])
        self.assertEqual(self.http.writes()[0][2]["fields"], e["fields"])
        self.assertEqual(self.http.rows[self.http.tid("扩展资料")][0]["fields"]["类型"], "已有")
        e = self.plan({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"当前状态": "新"}})
        self.assertEqual(e["action"], "跳过")
        self.assertTrue(self.k.apply([e])[0]["成功"])
        e = self.plan({"op": "upsert", "table": "扩展资料", "key": "B", "fields": {"类型": "新增"}})
        self.assertEqual(e["fields"]["主键"], "B")
        self.assertTrue(self.k.apply([e])[0]["成功"])
        self.http.calls.clear()
        self.assertError({"op": "upsert", "table": "扩展资料", "key": "A", "fields": {"主键": "C"}}, "主字段")

    def test_duplicate_primary_fails_closed(self):
        for _ in range(2):
            self.http.add("扩展资料", {"主键": "A"})
        self.assertError({"op": "upsert", "table": "扩展资料", "key": "A"}, "多个")

    def test_task_number_and_duplicate_title(self):
        self.http.add("任务", {"编号": "T-0009", "标题": "已有", "状态": "进行中"})
        self.http.add("任务", {"编号": "ignore", "标题": "完成过", "状态": "已完成"})
        e = self.plan(self.task("完成过"))
        self.assertEqual(e["key"], "T-0010")
        self.assertEqual(e["fields"]["状态"], "待办")
        self.assertEqual(e["fields"]["创建时间"], e["fields"]["更新时间"])
        self.assertError(self.task("已有"), "T-0009")
        for f in ("编号", "备注", "创建时间", "更新时间"):
            self.assertError(self.task(**{f: "wrong"}), "不允许")

    def test_batch_sequential_tasks_and_virtual_record(self):
        changes = [self.task("一"), self.task("二"), {"op": "update_task", "id": "T-0001", "fields": {"状态": "已完成"}}]
        entries = self.k.plan(changes)
        self.assertEqual([e["key"] for e in entries], ["T-0001", "T-0002", "T-0001"])
        reports = self.k.apply(entries)
        self.assertTrue(all(r["成功"] for r in reports), reports)
        self.assertEqual(reports[0]["record_id"], reports[2]["record_id"])
        self.http.calls.clear()
        entries = self.k.plan([self.task("重复"), self.task("重复")])
        self.assertEqual(entries[1]["action"], "错误")
        with self.assertRaises(kb.KBError):
            self.k.apply(entries)
        self.assertFalse(self.http.writes())

    def test_append_note_and_forbidden_update(self):
        self.http.add("任务", {"编号": "T-0005", "备注": [{"text": "旧备注"}], "状态": "待办"})
        e = self.plan({"op": "update_task", "id": "T-0005", "fields": {"状态": "已完成"},
                       "note": {"by": "乙", "text": "已寄出"}})
        self.assertEqual(e["fields"]["备注"], "旧备注\n2026-11-01T14:30:00.123+08:00 乙：已寄出")
        for f in ("编号", "创建人", "创建时间", "备注", "更新时间"):
            self.assertError({"op": "update_task", "id": "T-0005", "fields": {f: "x"}}, "不允许")
        self.assertError({"op": "update_task", "id": "missing"}, "找不到任务")
        for note in ({"by": "外人", "text": "x"}, {"by": "乙", "text": "x\ny"}, {"text": "x"}):
            self.assertError({"op": "update_task", "id": "T-0005", "note": note}, "")

    def test_progress_dedup_existing_and_batch(self):
        c = {"op": "progress", "member": "乙", "date": "2026-11-01", "text": "完成"}
        self.http.add("进度", {"成员": "乙", "日期": kb.date_ms(c["date"]), "内容": [{"text": "完成"}]})
        self.assertEqual(self.plan(c)["action"], "跳过")
        c["text"] = "新进展"
        entries = self.k.plan([c, c])
        self.assertEqual([e["action"] for e in entries], ["新增", "跳过"])
        self.assertTrue(all(r["成功"] for r in self.k.apply(entries)))
        self.http.calls.clear()
        self.assertError({**c, "member": "外人"}, "可选项")

    def test_protection_prefix_and_notify_fields(self):
        for name in ("成员", "通知", "任务", "进度"):
            self.assertError({"op": "upsert", "table": name, "key": "x"}, "受保护")
        fake = FakeHTTP("测试_")
        instance = kb.KB(kb.Client({**CONFIG, "KB_TABLE_PREFIX": "测试_"}, fake), lambda: NOW)
        for name in ("成员", "通知", "任务", "进度", "测试_任务"):
            self.assertEqual(instance.plan([{"op": "upsert", "table": name, "key": "x"}])[0]["action"], "错误")
        e = instance.plan([{"op": "notify", "to": "甲", "from": "乙", "text": "提醒"}])[0]
        self.assertEqual(e["table"], "测试_通知")
        self.assertEqual(set(e["fields"]), {"收件人", "发件人", "内容", "创建时间", "状态"})
        self.assertEqual(e["fields"]["状态"], "待发送")
        self.assertTrue(instance.apply([e])[0]["成功"])
        for key in ("to", "from"):
            self.assertError({"op": "notify", "to": "甲", "from": "乙", "text": "x", key: "外人"}, "可选项")

    def test_all_errors_prevent_writes_and_large_batch(self):
        changes = [{"op": "upsert", "table": "扩展资料", "key": str(n)} for n in range(21)]
        entries = self.k.plan(changes)
        with self.assertRaisesRegex(kb.KBError, "allow-large"):
            self.k.apply(entries)
        self.assertFalse(self.http.writes())
        self.assertTrue(all(r["成功"] for r in self.k.apply(entries, True)))
        self.http.calls.clear()
        entries = self.k.plan([self.task(), {"op": "delete", "table": "扩展资料"}, None])
        self.assertEqual(sum(e["action"] == "错误" for e in entries), 2)
        with self.assertRaises(kb.KBError):
            self.k.apply(entries)
        self.assertFalse(self.http.writes())

    def test_readback_failure_and_stop(self):
        entries = self.k.plan([self.task("一"), self.task("二")])
        self.http.corrupt = True
        reports = self.k.apply(entries)
        self.assertFalse(reports[0]["成功"])
        self.assertIn("回读", reports[0]["错误"])
        self.assertIsNotNone(reports[0]["record_id"])
        self.assertIn("未执行", reports[1]["错误"])
        self.assertEqual(len(self.http.writes()), 1)

    def test_concurrent_edit_rejected(self):
        row = self.http.add("任务", {"编号": "T-0001", "备注": "旧"})
        entries = self.k.plan([{"op": "update_task", "id": "T-0001", "note": {"by": "甲", "text": "我的"}}])
        row["fields"]["备注"] = "别人刚加的"
        self.assertIn("预检后发生变化", self.k.apply(entries)[0]["错误"])
        self.assertFalse(self.http.writes())

    def test_empty_dates_and_server_managed_values(self):
        self.http.schemas[self.http.tid("扩展资料")].append(field("系统时间", 1002))
        row = self.http.add("扩展资料", {"主键": "A", "更新时间": None,
                                  "系统时间": 1000, "当前状态": "旧"})
        entries = self.k.plan([{"op": "upsert", "table": "扩展资料", "key": "A",
                               "fields": {"当前状态": "新"}}])
        row["fields"]["系统时间"] = 2000
        self.assertTrue(self.k.apply(entries)[0]["成功"])
        self.assertTrue(self.k.equal({"fields": {"日期": field("日期", 5)}}, "日期", None, None))

    def test_prefix_isolation_has_no_fallback(self):
        instance = kb.KB(kb.Client({**CONFIG, "KB_TABLE_PREFIX": "不存在_"}, self.http))
        with self.assertRaisesRegex(kb.KBError, "找不到表"):
            instance.find("扩展资料")
        self.assertFalse(self.http.writes())

    def test_find_schema_and_all_pagination(self):
        for n in range(3):
            self.http.add("扩展资料", {"主键": [{"text": "A%d" % n}], "金额(元)": 12,
                                  "更新时间": kb.date_ms("2026-11-07"), "当前状态": "已签约"})
        self.http.paginate = True
        schema = self.k.schema()
        self.assertEqual(len(schema), 9)
        self.assertEqual(schema[0]["主字段"], "主键")
        self.assertIn("单选", [f["类型"] for f in schema[0]["字段"]])
        rows = self.k.find("扩展资料", keyword="已签约", limit=2)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["fields"]["更新时间"], "2026-11-07")
        self.assertEqual(rows[0]["fields"]["金额(元)"], "12")
        self.assertEqual(self.k.find("扩展资料", key="A2")[0]["fields"]["主键"], "A2")
        self.assertEqual(self.k.find("扩展资料", limit=0), [])
        with self.assertRaises(kb.KBError):
            self.k.find("扩展资料", limit=-1)

    def cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        code = kb.main(argv, client=self.client, stdout=out, stderr=err)
        return code, out.getvalue() + err.getvalue()

    def test_cli_preview_apply_errors_and_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "changes.json"
            path.write_text(json.dumps([self.task()]), encoding="utf-8")
            for command in ("plan", "apply"):
                code, output = self.cli([command, str(path)])
                self.assertEqual(code, 0, output)
                self.assertIn("[新增]", output)
                self.assertFalse(self.http.writes())
            code, output = self.cli(["apply", str(path), "--yes"])
            self.assertEqual(code, 0, output)
            self.assertIn('"成功": true', output)
            path.write_text('[{"op":"upsert","table":"扩展资料","key":"A","fields":{"不存在":"x"}}]')
            code, output = self.cli(["apply", str(path), "--yes"])
            self.assertEqual(code, 1)
            self.assertIn("整批未执行", output)
        for secret in (*CONFIG.values(), "fixture-tenant-token"):
            if secret:
                self.http.add("扩展资料", {"主键": "安全测试", "当前状态": secret})
        code, output = self.cli(["find", "扩展资料"])
        self.assertEqual(code, 0)
        for secret in (*CONFIG.values(), "fixture-tenant-token"):
            if secret:
                self.assertNotIn(secret, output)
        self.assertIn("已隐藏", output)
        self.assertEqual(self.cli(["garbage"])[0], 1)

    def test_config_env_file_no_shell_execution_and_no_leak(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "env"
            path.write_text('# comment\nexport FEISHU_APP_ID="example" # note\nFEISHU_APP_SECRET=literal$(no)\nFEISHU_BITABLE_APP_TOKEN=base # note\nKB_TABLE_PREFIX=测试_\n')
            cfg = kb.load_config(path, {})
            self.assertEqual(cfg["FEISHU_APP_SECRET"], "literal$(no)")
            self.assertEqual(cfg["FEISHU_BITABLE_APP_TOKEN"], "base")
            self.assertEqual(cfg["KB_TABLE_PREFIX"], "测试_")
            self.assertEqual(kb.load_config(path, CONFIG)["FEISHU_APP_ID"], "example")
            path.write_text('SENSITIVE_BAD_LINE')
            with self.assertRaises(kb.KBError) as error:
                kb.load_config(path, {})
            self.assertNotIn("SENSITIVE_BAD_LINE", str(error.exception))
        with self.assertRaises(kb.KBError):
            kb.load_config(environ={})

    def test_invalid_json_and_structures(self):
        with self.assertRaises(kb.KBError):
            self.k.plan({})
        for c in ({"op": "upsert", "table": "扩展资料", "key": "x", "fields": []},
                  {"op": "upsert", "table": "不存在", "key": "x"},
                  {"op": "notify", "to": "甲", "from": "乙", "text": "x", "送达时间": "x"}):
            self.assertError(c, "")
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "x"
            for content in ("{", "[NaN]", "[Infinity]"):
                p.write_text(content)
                with self.assertRaises(kb.KBError):
                    kb.read_changes(p)


class InitTests(unittest.TestCase):
    def setUp(self):
        self.http = FakeHTTP()
        self.http.table_list = []
        self.http.schemas = {}
        self.http.rows = {}
        self.client = kb.Client(CONFIG, self.http)
        self.k = kb.KB(self.client, lambda: NOW)

    def test_preview_create_repeat_repair_and_members(self):
        self.k.init("甲", ["乙:writer"], False)
        self.assertFalse(self.http.writes())
        self.k.init("甲", ["乙:writer"], True)
        self.assertEqual(len(self.http.table_list), 7)
        self.assertEqual(self.k.find("成员")[1]["fields"]["ID"], "writer")
        self.http.calls.clear()
        self.k.init("甲", ["乙:writer"], True)
        self.assertFalse(self.http.writes())
        tid = self.http.tid("任务")
        # Missing field and member option are repaired while unknown options retain IDs/colors.
        fs = self.http.schemas[tid]
        fs[:] = [f for f in fs if f["field_name"] != "详情"]
        owner = next(f for f in fs if f["field_name"] == "负责人")
        owner["property"]["options"] = [{"name": "甲", "id": "opt-kept", "color": 1}, {"name": "自建选项", "id": "opt-extra"}]
        self.k.init("甲", ["乙:writer", "丙"], True)
        self.assertIn("详情", {f["field_name"] for f in fs})
        self.assertEqual(owner["property"]["options"][0]["id"], "opt-kept")
        self.assertEqual([o["name"] for o in owner["property"]["options"]], ["甲", "自建选项", "乙", "丙"])
        self.assertEqual(len(self.k.find("资料", key="欢迎使用")), 1)
        self.assertIn("七张模板表及字段、选项检查通过。", self.k.doctor())
        self.assertFalse(any(c[0] == "DELETE" for c in self.http.calls))

    def test_schema_conflicts_and_member_collisions_are_read_only(self):
        self.k.init("甲", yes=True)
        for extra in (["乙:m1"], ["甲:other"], ["乙:../bad"]):
            self.http.calls.clear()
            with self.assertRaises(kb.KBError):
                self.k.init("甲", extra, True)
            self.assertFalse(self.http.writes())
        self.http.schemas[self.http.tid("资料")][0]["field_name"] = "其他主字段"
        self.http.calls.clear()
        with self.assertRaisesRegex(kb.KBError, "主字段不符"):
            self.k.init("甲", yes=True)
        self.assertFalse(self.http.writes())
        self.assertTrue(any("主字段不符" in line for line in self.k.doctor()))

    def test_doctor_no_writes_and_init_cli(self):
        lines = self.k.doctor()
        self.assertTrue(any("缺表" in line for line in lines))
        self.assertFalse(self.http.writes())
        out = io.StringIO()
        self.assertEqual(kb.main(["init", "--name", "甲", "--member", "乙", "丙"], client=self.client, stdout=out), 0)
        self.assertIn("确认后加 --yes", out.getvalue())
        self.assertFalse(self.http.writes())


class TransportTests(unittest.TestCase):
    @staticmethod
    def response(data):
        return io.BytesIO(json.dumps(data).encode())

    def test_network_429_and_5xx_retry_maximum(self):
        for error in (urllib.error.URLError("secret-url"), http.client.IncompleteRead(b""),
                      urllib.error.HTTPError("secret-url", 429, "secret", {}, None),
                      urllib.error.HTTPError("secret-url", 503, "secret", {}, None)):
            calls, delays = [], []
            def opener(*args, **kwargs):
                calls.append(1)
                if len(calls) < 4:
                    raise error
                return self.response({"code": 0})
            self.assertEqual(kb.HTTP(opener=opener, sleep=delays.append).request("GET", "/test")["code"], 0)
            self.assertEqual(len(calls), 4)
            self.assertEqual(delays, [1, 2, 4])
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("PRIVATE_SECRET")) as mock:
            with self.assertRaises(kb.KBError) as exc:
                kb.HTTP(sleep=lambda _: None).request("GET", "/test")
            self.assertEqual(mock.call_count, 4)
            self.assertNotIn("PRIVATE_SECRET", str(exc.exception))

    def test_business_permission_and_bad_response_no_secrets(self):
        for response in ({"code": 1254302, "msg": "PRIVATE_SECRET"},
                         {"code": 42, "msg": "PRIVATE_SECRET"}, {"x": "PRIVATE_SECRET"}):
            with self.assertRaises(kb.KBError) as error:
                kb.HTTP(opener=lambda *a, **k: self.response(response)).request("GET", "/test")
            self.assertNotIn("PRIVATE_SECRET", str(error.exception))
            if response.get("code") == 1254302:
                self.assertIn("添加文档应用", str(error.exception))
        with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("PRIVATE_SECRET", 403, "PRIVATE_SECRET", {}, None)) as mock:
            with self.assertRaisesRegex(kb.KBError, "添加文档应用"):
                kb.HTTP().request("GET", "/test")
            self.assertEqual(mock.call_count, 1)

    def test_invalid_pagination(self):
        client = kb.Client(CONFIG, FakeHTTP())
        with patch.object(client, "api", return_value={"items": [], "has_more": True}):
            with self.assertRaisesRegex(kb.KBError, "分页"):
                client.tables()


@unittest.skipUnless(os.environ.get("KB_ONLINE_TEST") == "1", "仅 KB_ONLINE_TEST=1 时运行")
class OnlineTests(unittest.TestCase):
    def test_isolated_end_to_end_and_cleanup(self):
        config = kb.load_config()
        config["KB_TABLE_PREFIX"] = ""
        client = kb.Client(config)
        prefix = "测试_pb_%s_" % uuid.uuid4().hex[:12]
        self.assertRegex(prefix, r"^测试_pb_[a-f0-9]{12}_$")
        real = client.tables()
        def fingerprint():
            result = {}
            for t in real:
                payload = [client.fields(t["table_id"]), sorted(client.records(t["table_id"]), key=lambda r: r["record_id"])]
                result[t["table_id"]] = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            return result
        before = fingerprint()
        print("在线测试：正式表只读指纹已读取", flush=True)
        isolated = kb.Client({**config, "KB_TABLE_PREFIX": prefix})
        try:
            instance = kb.KB(isolated)
            preview = instance.init("测试成员甲", ["测试成员乙"], False)
            self.assertIn("确认后加 --yes", preview[-1])
            self.assertEqual(client.tables(), real)
            print("PASS init 预览零写入；七张表与全部字段选项已展示", flush=True)
            instance.init("测试成员甲", ["测试成员乙"], True)
            def snapshot():
                return {t["name"]: [isolated.fields(t["table_id"]), isolated.records(t["table_id"])]
                        for t in client.tables() if t["name"].startswith(prefix)}
            first = snapshot()
            second = instance.init("测试成员甲", ["测试成员乙"], True)
            self.assertEqual(first, snapshot())
            self.assertIn("待执行结构操作：0；新增成员：0", second)
            self.assertEqual(len(instance.find("资料", key="欢迎使用")), 1)
            print("PASS init --yes 首次创建、第二次零变更，欢迎记录去重", flush=True)
            self.assertIn("七张模板表及字段、选项检查通过。", instance.doctor())
            changes = [
                {"op": "upsert", "table": "资料", "key": "在线测试资料", "fields": {"内容": "初始内容", "分类": "学习"}},
                {"op": "upsert", "table": "资料", "key": "在线测试资料", "fields": {"内容": "已更新"}},
                {"op": "create_task", "fields": {"标题": "在线测试任务", "负责人": "测试成员甲", "创建人": "测试成员乙", "截止日期": "2026-11-07"}},
                {"op": "update_task", "id": "T-0001", "fields": {"状态": "已完成"}, "note": {"by": "测试成员甲", "text": "在线追加备注"}},
                {"op": "progress", "member": "测试成员甲", "date": "2026-11-01", "text": "在线测试进展"},
                {"op": "progress", "member": "测试成员甲", "date": "2026-11-01", "text": "在线测试进展"},
                {"op": "notify", "to": "测试成员乙", "from": "测试成员甲", "text": "隔离测试通知"},
            ]
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "changes.json"
                path.write_text(json.dumps(changes, ensure_ascii=False))
                for argv in (["plan", str(path)], ["apply", str(path)], ["apply", str(path), "--yes"]):
                    out, err = io.StringIO(), io.StringIO()
                    code = kb.main(argv, client=isolated, stdout=out, stderr=err)
                    self.assertEqual(code, 0, isolated.redactor.clean(out.getvalue() + err.getvalue()))
                    if "--yes" not in argv:
                        self.assertEqual(instance.find("资料", key="在线测试资料"), [])
                    print("PASS 在线 CLI %s" % (argv[0] + (" --yes" if "--yes" in argv else " 仅预览")), flush=True)
            self.assertEqual(instance.find("资料", key="在线测试资料")[0]["fields"]["内容"], "已更新")
            task = instance.find("任务", key="T-0001")[0]["fields"]
            self.assertEqual(task["状态"], "已完成")
            self.assertEqual(task["截止日期"], "2026-11-07")
            self.assertRegex(task["备注"], r"^\d{4}-\d{2}-\d{2}T.*\+08:00 .+：在线追加备注$")
            self.assertEqual(len(instance.find("进度")), 1)
            self.assertEqual(instance.find("通知")[0]["fields"]["状态"], "待发送")
            print("PASS 资料、任务、进度、通知全部回读，进度去重与备注格式通过", flush=True)
        finally:
            errors = []
            for table in client.tables():
                if table["name"].startswith(prefix):
                    try:
                        client.api("DELETE", "/tables/" + urllib.parse.quote(table["table_id"], safe=""))
                    except kb.KBError:
                        errors.append(table["name"])
            remaining = client.tables()
            print("清理后剩余表名：" + client.redactor.clean(json.dumps([t["name"] for t in remaining], ensure_ascii=False)), flush=True)
            self.assertFalse(errors, "测试表清理失败")
            self.assertFalse([t for t in remaining if t["name"].startswith(prefix)])
            self.assertEqual(sorted((t["table_id"], t["name"]) for t in real), sorted((t["table_id"], t["name"]) for t in remaining))
            self.assertEqual(before, fingerprint(), "正式表数据或结构只读指纹发生变化，请核查并发修改")
            print("PASS 正式表名称、ID、全部结构与记录指纹一致；本轮测试表零残留", flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
