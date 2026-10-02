# V5 可选评测工具

本目录为自愿诊断模板，不是评分、合成或参榜前置条件。输入文件为空，不代表完成真实模型验证。可从一条输入、一个模型开始，不要求固定样本数、供应商数量或高分比例。

普通输入：`[{"id":"ID","title":"原文","content":"原文"}]`。
合成输入：`[{"id":"ID","A":{"title":"A","content":"原文"},"B":{"title":"B","content":"原文"}}]`。
如填写人工参考，`references` 中使用 `total_interval:[下限,上限]`、按 V5 顺序的 `levels:[12 个 0–4 整数]`。真实评测不把工程模拟输出当作人工真值。

复制到私有目录后填写 inputs/configs。配置和 runtime 数据库包含密钥，不能打包公开。离线 `--freeze`/`--dry-run` 不调用模型。真实运行需要主动指定 `--allow-real`、配置、调用预算、费用上限和失败停止比例：

```powershell
npm run scoring:eval -- --eval-dir PRIVATE_DIR --freeze
npm run scoring:eval -- --eval-dir PRIVATE_DIR --allow-real --configs PRIVATE_JSON --set calibration --budget 10 --max-cost 1 --stop-failure-rate 0.5 --repeat 1
npm run scoring:eval -- --eval-dir PRIVATE_DIR --report --set calibration
```

报告保留失败、调用次数、耗时、token、重复分差与跨模型分差，不承诺任意模型相差不超过 3 分，也不会审批模型或调整运行分数。
