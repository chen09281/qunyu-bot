# OpenAI 接入

进入「模型与回复」，在顶部「API 服务商」选择 **OpenAI / OpenAI 兼容接口**。

1. 官方基础地址是 `https://api.openai.com/v1`，不要附加 `/chat/completions`。使用兼容服务时填写该服务提供的基础地址和密钥。
2. 填写该服务的 API Key。保存过的密钥不会回显，留空表示保留；更换 OpenAI 主机地址时需重新填写密钥。
3. 展开「模型切换」，选择模型或手动填写 ID。内置 `gpt-4.1-mini` 作为示例，实际可用性取决于账号。保存后可以刷新该接口的模型列表，或点击「测试已保存的模型」。测试会产生少量 API 用量。
4. 识图模型留空时使用当前文字模型；也可填写单独的视觉模型 ID。所选模型必须支持图片输入。

DeepSeek 与 OpenAI 的地址、密钥、文字模型、识图模型、思考设置和输出预算分别保存。切换服务不会覆盖另一家的这些配置。人设、记忆、白名单、回复长度和超时设置共用。已排队的请求沿用接收时的服务配置，新请求使用保存后的配置。

首次进入后台也可直接选择 OpenAI 绑定密钥，不需要先配置 DeepSeek。

## 支持范围

本次接入使用 **Chat Completions**，支持群聊、授权私聊、聊天历史、流式回复、图片输入、文档函数工具和定时发言。选择的模型需支持 Chat Completions；`/models` 返回的列表可能还包含语音、嵌入或其他接口专用模型，列表并不保证每个模型都支持聊天、图片和工具。

OpenAI 模式不调用 DeepSeek 的搜索和网页读取接口，因此当前不启用「联网搜索与找图」。链接解析、订阅和签到插件独立工作。文档生成需要所选模型支持函数调用；部分推理模型在 Chat Completions 中对工具与思考参数的组合有限制，请按对应模型能力设置。

思考强度默认选「模型默认」，不发送 `reasoning_effort`。只有确认模型支持时才选择具体档位。OpenAI 不返回完整内部思考文本，实时页展示接口实际返回的文本、用量与执行状态。

OpenAI 默认启用输出 Token「无上限」按钮，即不发送本地预算参数，由服务商决定默认预算和上限。关闭后发送 `max_completion_tokens`，不会误传 DeepSeek 的 `thinking` 或 `max_tokens`。定时问候使用 256 Token 的简短预算。无上限不表示模型或服务商没有输出限制。

官方参考：[Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[GPT-4.1 mini 能力](https://developers.openai.com/api/docs/models/gpt-4.1-mini)。
