# 端到端冒烟测试

本测试会**真实调用 claude CLI**（产生真实费用），因此不纳入 `npm test`，需要手动执行。

## 前置条件

1. `.env` 已配置（可从 `.env.example` 复制）
2. `claude` 已完成登录：`claude --version` 能正常输出
3. 已执行过 `npm install`

## 执行

```bash
bash tests/e2e/smoke.sh
```

## 通过标准

1. 服务在 `127.0.0.1:<端口>` 启动成功：默认端口 `8787`；若该端口被其它进程占用，脚本会**自动改用一个空闲端口（8790–8899）**
   并明确打印出来（**绝不杀掉任何非自己启动的进程**）；也可用 `AGENTFLOW_PORT=<端口>` 显式指定（显式指定却被占用则直接报错退出）
2. 创建任务后，事件流中出现 3 个 `node.succeeded`
3. 最终状态为 `completed`
4. 产出 3 个 Artifact：`requirement` / `code_diff` / `test_report`
5. `logs/runs/` 下生成了对应的原始日志文件
6. **记录本次实测花费**（来自 `budgetUsedUsd`），回填到 `记录.md`

> 说明：需求文本必须**落在各角色自己的 `owns` 之内**（`pm` 只读、`backend_dev` 写 `src/**`、`qa_engineer` 写 `tests/**`），
> 否则 `owns` 路径级强制会把节点判为越界失败。冒烟脚本已按此措辞（dev 只产 `src/hello.sh`，测试由 qa 在 `tests/**` 内自建）。