# 飞书知识库命令参考

Python 3.9+ 标准库即可运行。先读 [AGENTS.md](AGENTS.md)，配置本地环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BITABLE_APP_TOKEN`。请勿打印或提交真实凭证。

以下在仓库根目录运行：

```sh
# 只读诊断；缺凭证或权限时输出下一步建议
python3 knowledge-base/kb.py doctor
# 预览固定七张表、字段、选项、成员；不会写入
python3 knowledge-base/kb.py init --name 我的称呼
# 确认预览后初始化
python3 knowledge-base/kb.py init --name 我的称呼 --yes
# 以后加入成员；可重复运行，不覆盖已有成员
python3 knowledge-base/kb.py init --name 我的称呼 --member 成员乙 成员丙:writer
python3 knowledge-base/kb.py init --name 我的称呼 --member 成员乙 成员丙:writer --yes
# 查结构与记录
python3 knowledge-base/kb.py schema
python3 knowledge-base/kb.py schema 联系人
python3 knowledge-base/kb.py find 成员
python3 knowledge-base/kb.py find 资料 --key 阅读计划
python3 knowledge-base/kb.py find 联系人 --keyword 合作方 --limit 10
# 先校验/预览，再由写入人确认并执行；apply 默认仍然只预览
python3 knowledge-base/kb.py plan changes.json
python3 knowledge-base/kb.py apply changes.json
python3 knowledge-base/kb.py apply changes.json --yes
# 超过20项，需确认批量范围
python3 knowledge-base/kb.py apply changes.json --yes --allow-large
```

`--member` 可跟多个名称，也可重复传入。ID 自动从 `m1` 开始，或写成 `名称:ID`；只允许字母、数字、短横线和下划线。`--name` 也支持 `名称:ID`。旧成员保留原顺序，新增成员追加；默认 OWNER 始终是成员表第一位。不要用 init 修改已有成员的 ID 或名称。

模板唯一来源是 [schema.json](schema.json)。`init` 是唯一建表、加字段和补选项入口，保留现有单选项的 ID/颜色以及额外选项。主字段或字段类型冲突时停止，不自动改名、删改结构或转换类型。非事务操作中途失败时，先 doctor 再重新预览 init，可补完之前缺失的部分。一次只运行一个 init。

支持的业务操作：

| op | 参数与行为 |
|---|---|
| upsert | `table`、`key`、`fields`；适用于所有非系统表，按主字段去重，有更新时间时自动填 |
| create_task | `fields` 必填标题、负责人、创建人；编号自动生成；默认待办，不自动通知 |
| update_task | `id`、`fields`、可选 `note:{by,text}`；禁止改编号、创建人、创建时间或覆盖备注 |
| progress | `member`、`date`、`text`；成员/日期/内容相同则跳过 |
| notify | `to`、`from`、`text`；新建待发送通知，不代表已送达 |

人员字段填成员**名称**，先查成员表与 schema。日期填 `YYYY-MM-DD`，自动时间为北京时间。完整 changes.json 示例见 [AGENTS.md](AGENTS.md)。工具没有删除入口，也不提供自定义建表接口。

可用 `python3 knowledge-base/kb.py --env-file /本地配置路径 doctor` 读取显式本地 env 文件；其值覆盖环境变量，不执行 shell 展开。优先使用进程环境。`KB_TABLE_PREFIX`（或 `FEISHU_TABLE_PREFIX`）可给所有逻辑表加前缀，两个同时设置时 Python 优先 `KB_TABLE_PREFIX`；BOT 使用 `FEISHU_TABLE_PREFIX`。同一个知识库请保持前缀一致。业务命令不会回退到无前缀的表。

安全性：预检发现错误时整批不执行；apply 每条写前检查现有值，写后回读。中途失败不会回滚前面的成功操作，必须核实后重新 plan。任务编号以现有最大编号递增，跨进程并发创建无事务保证，请避免同时派任务。

离线测试：`python3 -I knowledge-base/test_kb.py`。真实测试：`KB_ONLINE_TEST=1 python3 -I knowledge-base/test_kb.py`；只创建 `测试_pb_<随机>_` 前缀表，finally 清理并比较正式表清单、结构和记录摘要。在线测试需要管理测试表的权限，请只在已授权的表格上执行。
