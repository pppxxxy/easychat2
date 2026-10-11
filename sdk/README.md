# EasyChat2 SDK

Drive EasyChat2's on-device agent from your own code. The app exposes a **local
OpenAI-compatible server** (`plugins/localApiServer`, loopback `127.0.0.1` + Bearer auth):

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/models` | GET | installed model catalog |
| `/v1/chat/completions` | POST | chat (supports `stream: true` SSE) |
| `/v1/agent` | POST | run one agent tool loop, returns `object: "agent.run"` |

## JavaScript / TypeScript

The client lives in the app source at `src/agent/sdk.js` (zero dependencies, injectable `fetch`):

```js
import { createAgentClient } from './src/agent/sdk.js';

const client = createAgentClient({ baseUrl: 'http://127.0.0.1:8686', apiKey: '<token>' });
console.log(await client.listModels());
console.log(await client.runAgent({ prompt: '总结工作区', mode: 'read' }));
const text = await client.streamChat({ messages: [{ role: 'user', content: '你好' }], onToken: t => process.stdout.write(t) });
```

## Python (stdlib only)

`sdk/python/easychat2.py` — no third-party dependencies (Python 3.8+):

```python
from easychat2 import EasyChat2

client = EasyChat2(base_url="http://127.0.0.1:8686", api_key="<token>")
print(client.list_models())
print(client.run_agent("列出工作区文件并总结", mode="read"))
for piece in client.stream_chat([{"role": "user", "content": "你好"}]):
    print(piece, end="", flush=True)
```

## JSON-RPC 2.0

`src/agent/rpc.js` maps the internal JSONL event stream (`run_start` / `text` /
`tool_start` / …) to JSON-RPC 2.0, so any JSON-RPC / ACP-style editor or IDE can
drive the agent without knowing our internal event names:

```js
import { toRpcNotification, parseRpcMessage, handleRpcRequest } from './src/agent/rpc.js';

// events → notifications
toRpcNotification({ type: 'text', text: 'hi' });
// → { jsonrpc: '2.0', method: 'agent.text', params: { type: 'text', text: 'hi', protocolVersion: 1 } }

// requests → responses
await handleRpcRequest(parseRpcMessage(line), {
  'agent.run': async params => runAgent(params),
});
```

Methods: `agent.run`, `agent.cancel`, `agent.models`.

## Notes

- The server binds to loopback only; keep the Bearer token private.
- The native HTTP layer does not load the model itself — it forwards the request
  to the app's JS agent loop. A local model must be loaded for `/v1/chat/completions`
  and `/v1/agent` to produce output.
- `POST /v1/agent` runs the same serialized queue as chat inference.
