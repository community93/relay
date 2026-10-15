# Relay API v1

Current `apiVersion` is **3** (0.1.17+). Version 3 changed `workspace.list` from a full dump to a bounded map — see [Read narrow](#read-narrow). `GET /v1/health` reports the version this connection speaks.

Authenticated native HTTP clients only. Read the saved connection JSON for `baseUrl` and `token`; never expose the token. `GET /v1/health` and `POST /v1/command` require `Authorization: Bearer <token>`. POST requires `Content-Type: application/json`. Browser origins (an `Origin` or `Sec-Fetch-Site` header) and a mismatched `Host` are rejected, so a web page cannot drive the port. No cloud service, fixed port or credential discovery. The app must remain open with AI connection enabled.

Requests are capped at 2 MiB. Response bodies returned to AI may be bounded; Relay retains engine evidence. Commands return `{ok:true,data:...}` or `{ok:false,error:{code,message}}`. Conflict/busy errors use HTTP409. Unknown IDs use404. Invalid payloads use400. Persistence errors use500. On timeout inspect the entity by stable ID before retrying a write.

**Every rejection is written to be actionable without another round trip**: it names the field, echoes what arrived, and lists the accepted values or sibling keys. Read the message and fix that thing; do not retry the same payload.

## Scopes and the host allowlist

Each connection grants one tier, and a higher tier includes everything below it:

| tier | what it adds |
| --- | --- |
| `read` | `workspace.list`, `entity.find`, `entity.get`, `job.get` |
| `write` | collection / environment / request / document / runner upserts, `request.preview`, `entity.open`, `document.export` |
| `execute` | `request.execute`, `document.verify`, `runner.execute`, `job.cancel` |

`request.preview` sits at `write` deliberately: it resolves variables and auth into real credentials, so a read-only connection should not see them, but it sends nothing and therefore needs no host grant.

The user chooses the tier when opening the connection; the default grants no execute rights, and an `execute` connection must name at least one allowed host. `GET /v1/health` and `workspace.list` report the live `scope`, `allowedHosts`, and only the `actions` that scope can actually reach — call `workspace.list` first and treat that list as the whole surface rather than probing.

Calling an action above the granted tier returns HTTP403 with `code:"insufficient_scope"` and a message naming the tier to ask for. Do not retry it in a loop and do not look for a workaround: ask the user to reopen the connection with a wider scope.

`execute` additionally checks the resolved URL against the allowlist immediately before the request leaves Relay, after variable substitution. A blocked host returns `code:"scope"`. `document.verify` and `runner.execute` check **every** endpoint up front and refuse the whole job if any single one is off-list, so a refusal means nothing was sent — fix the allowlist or narrow the document, then retry. Redirects are re-checked **hop by hop**: an allowlisted host that answers 302 with an off-list target stops the run and reports `跳转被中止：重定向目标是未授权主机 <host>`. Do not treat a redirect as still-in-bounds just because the URL you sent is in bounds. Manual sends from the Relay window are unrestricted; the allowlist only governs automation.

## MCP endpoint

The same listener also speaks MCP over Streamable HTTP at `POST /mcp`, so a client that supports remote MCP needs no skill, no script and no second process. It is the *same* gate: `initialize`, `tools/list`, `tools/call` and `ping` only, JSON-RPC 2.0, replies as plain JSON. `GET /mcp` returns 405 because Relay never pushes events — poll `job_get` instead. A notification (no `id`) gets an empty 202.

Tool names are the actions with dots replaced by underscores (`request.execute` → `request_execute`), and the arguments are the same envelope body minus `action`. **`tools/list` only advertises tools the current scope can reach** (17 in total at `execute`) — a `read` connection sees `workspace_list`, `entity_find`, `entity_get`, `job_get` and nothing else — so the advertised list is the whole surface. Calling a tool above the granted scope anyway returns a tool result with `isError:true` naming the tier to ask for, not a transport error; surface that to the user instead of retrying.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"entity_get","arguments":{"type":"request","id":"example-get"}}}
```

Prefer `/v1/command` when you already have the skill's client; prefer `/mcp` when the host tool only takes a server URL.

## Read narrow

Your context is the scarce resource here, and a workspace can hold hundreds of requests. Relay's reads are shaped so that a first call never has to be a dump.

```json
{"action":"workspace.list"}
{"action":"workspace.list","collectionId":"handoff-collection","limit":50}
{"action":"entity.find","query":"order","method":"POST","limit":20}
{"action":"entity.get","type":"request","id":"example-get"}
```

`workspace.list` with no `collectionId` returns a **map**: every collection with a request *count*, plus environments, documents (with endpoint status) and runners. It does not inline individual requests. `totalCollections` / `totalRequests` tell you what exists; `hiddenCollections` and a `next` string tell you what the limit withheld. Pass `collectionId` to expand exactly one collection into `{id,name,protocol,method,revision}` rows.

`entity.find` is how you locate a request without walking collections: a case-insensitive substring over name **and** URL, optionally filtered by HTTP verb, returning matches with their `collectionId`, folder path and revision. Give it `query`, `method`, or both.

`limit` is accepted by all three (default 80, max 500). Prefer a narrow read over a wide one, and never re-issue a wide read to answer something `entity.find` already answers.

Entity types: `collection`, `request`, `environment`, `document`, `runner`. Read returns `{entity,revision}`; documents also return endpoints with generated `fields`, `status`, `issues`. Lists include entity IDs and revisions.

All updates to existing entities require `expectedRevision` equal to the latest revision; new entities omit it. IDs are optional on creates (Relay generates one). Supplied IDs use letters/digits/underscore/hyphen, max80 chars. Choose stable task-scoped IDs to recover from ambiguous write failures. `.upsert` merges supplied top-level fields; supplied arrays replace that array. Updating a request with an unsaved tab or active execution returns `busy`.

## Preview before you execute

```json
{"action":"request.preview","id":"handoff-get-order"}
```

`request.preview` runs the same variable, auth and collection-header resolution a real send uses and returns the result — `wire` (secrets masked), `environment`, `missingVariables` — **without sending anything**. It also audits every JSON path in the request's checks and extractors against the last real response Relay holds for that request (an open tab, or a document endpoint that links it), and reports per path:

| status | meaning |
| --- | --- |
| `ok` | the path resolves; `actualType` and `value` are included |
| `not-found` | the path broke — `reason` names the segment and lists the sibling keys |
| `would-fail` | the path resolves but the declared `equals`/`type` expectation does not hold against that response |
| `bad-path` | the path is not valid grammar |
| `unchecked` | no stored response yet; run once or open the request in Relay |

Use it instead of discovering a wrong `$.data.token` by spending an execution and an allowlist hit. Because nothing goes on the wire, a preview is **not** gated by the host allowlist — you can preview a request pointed at a host you are not allowed to call.

JSON paths accept `$`, `.field`, `[0]`, `["a.b"]`; field names are any run of characters that is not whitespace, `.`, `[`, `]` or `$`, so Chinese keys work with the dot form (`$.数据.条目[0].机构`). No eval, no wildcards.

## Batches

```json
{"commands":[
  {"action":"collection.upsert","id":"handoff-collection","data":{"name":"订单接口"}},
  {"action":"request.upsert","id":"handoff-get-order","collectionId":"handoff-collection","data":{"name":"查询订单","draft":{"method":"GET","url":"{{baseUrl}}/orders"}}}
]}
```

One POST, up to **20** commands, executed sequentially in one reply — building a dozen requests should not cost a dozen round trips. Each item comes back as `{index, ok, data}` or `{index, ok:false, action, error}`. A failing item does **not** stop the rest, so you get the eleven good ones plus a precise complaint about the third; fix and resend only that index.

The transport grades **every** command in the array before any of them runs. If one exceeds the granted scope, or nests another `commands`, or is unknown, the **whole batch is refused** and nothing is written — the message names the offending index (`commands[1] request.upsert`). Do not read that as a transient failure; it is the same tier wall as a single call, and a partial batch is exactly the outcome it prevents. `commands` and `action` cannot appear in the same envelope.

Batching is on `/v1/command` only; MCP's `tools/call` is one tool per call by design.

## Create requests

```json
{"action":"collection.upsert","id":"handoff-collection","data":{"name":"订单接口","description":"交付范围"}}
{"action":"request.upsert","id":"handoff-get-order","collectionId":"handoff-collection","data":{"name":"查询订单","description":"按订单编号查询","protocol":"http","draft":{"method":"GET","url":"{{baseUrl}}/orders/{{orderId}}","headers":[{"key":"Authorization","value":"Bearer {{token}}"}],"checks":[{"kind":"status","expected":"200"},{"kind":"json","operator":"type","path":"$.id","expected":"number"}]}}}
```

Request data: `name`, `description`, `protocol` (`http`/`sse`/`ws`), `draft`, `auth`, or `curl`. One cURL per command; `curl` and `draft` are mutually exclusive. Protocol is inferred for new requests unless explicit. `collectionId` required only on creation; updates stay in their original parent.

Draft fields: `name`, `method`, `url`, `params`, `headers`, `body`, `settings`, `checks`, `extractors`, `subprotocols`. Use upper-case method. Row shape: `{key,value,enabled?,description?}`. Values are strings. URL is the query source; Relay merges a params table into a URL on creation.

Body examples:

```json
{"mode":"raw","raw":{"language":"json","content":"{\"name\":\"demo\"}"}}
{"mode":"urlencoded","urlencoded":[{"key":"grant_type","value":"client_credentials"}]}
{"mode":"form","form":[{"key":"name","value":"demo"}]}
{"mode":"none"}
```

Raw languages: `json`, `text`, `xml`, `html`, `javascript`. File uploads are configured in Relay, not by an AI filesystem path. Settings: `timeoutMs`(0–300000), `followRedirects`, `sslVerify`, `cookieJar`, `proxy`, `maxRedirects`.

Auth: `{kind:"inherit"}`, `{kind:"noauth"}`, `{kind:"bearer",bearer:{token:"{{token}}"}}`, `{kind:"basic",basic:{username:"...",password:"{{password}}"}}`, `{kind:"apikey",apikey:{key:"X-API-Key",value:"{{apiKey}}",addTo:"header"}}` (or `query`). Recognized secrets are redacted on reads; never write `<redacted>` back.

Checks: `{kind:"status",expected:"200, 201"}`, `{kind:"time",expected:"1500"}`, `{kind:"json",operator:"exists",path:"$.id"}`, `{kind:"json",operator:"equals",path:"$.code",expected:"0"}`, `{kind:"json",operator:"type",path:"$.data",expected:"object"}`. JSON equality expects JSON text (string example `"\"demo\""`). Types: string/number/boolean/null/array/object. Path grammar is the one described under [Preview before you execute](#preview-before-you-execute); preview the request to find out whether a path resolves before executing it. Optional `enabled:false` disables a rule.

Extractors: `{name:"token",source:"json",path:"$.data.token"}` or `{name:"etag",source:"header",path:"ETag"}`. Runtime variables are scoped to the current runner, not persisted. Failed extraction blocks stale environment fallback. Default success is HTTP200–399; explicit status assertions can accept expected errors such as401.

```json
{"action":"environment.upsert","id":"handoff-dev","data":{"name":"开发","variables":[{"key":"baseUrl","value":"http://127.0.0.1:8080"}]}}
```

Environment data: `name`, `variables`. API does not change the active environment; user selects it in Relay. Execute with the currently selected environment. Do not replace an existing environment's variable array with masked values; add a separate environment or reconcile values from authorized source material.

## Documents

```json
{"action":"document.upsert","id":"handoff-doc","data":{"name":"订单接口交付","overview":"调用流程与业务约定","version":"1.0.0"}}
{"action":"document.endpoint.upsert","documentId":"handoff-doc","requestId":"handoff-get-order","expectedRevision":"<latest-document-revision>","data":{"summary":"查询订单","description":"根据订单编号查询订单详情。","notes":"不存在时返回404。"}}
```

Endpoint IDs can be supplied; otherwise the existing linked request is reused. API creates HTTP delivery endpoints. Document fields are discovered from real request/verified response samples. After verification read `entity.get` for their exact IDs, then patch:

```json
{"action":"document.endpoint.upsert","id":"<endpoint-id>","documentId":"handoff-doc","requestId":"handoff-get-order","expectedRevision":"<latest-document-revision>","data":{"fields":{"response:id":{"description":"订单编号"},"params:page":{"description":"页码，从1开始","required":false}}}}
```

Field IDs are `params:<key>`, `headers:<key>`, `body:<generated path>`, `response:<generated path>`; use the actual returned IDs. `required` accepts true/false/null; unknown stays null. Field metadata merges per field. Arbitrary samples, verified stamps and `reviewed` input are not accepted. The user confirms delivery in the UI.

## Execute and inspect jobs

```json
{"action":"request.execute","id":"handoff-get-order"}
{"action":"document.verify","id":"handoff-doc"}
{"action":"runner.upsert","id":"handoff-chain","data":{"name":"登录→查询","sources":["login-request","handoff-get-order"],"stopOnError":true}}
{"action":"runner.execute","id":"handoff-chain"}
{"action":"job.get","id":"<jobId>"}
{"action":"job.cancel","id":"<jobId>"}
```

Execution returns `{jobId,state:"running"}`. Poll until `completed`, `failed` or `cancelled`; inspect `result.ok`, each assertion and entry. Network/business failure can be a completed job with `result.ok:false`. Each job is session-local; up to8 active, most recent50 retained. AI connection off prevents new commands; already-started authorized executions continue and remain visible in Relay. Cancel them explicitly before disconnecting when needed.

Runner data: `name`, `sources` (collection/folder/request IDs), `stopOnError`, `delayMs`(0–60000). Schedule cannot be enabled via API. The CSV data file (if the user attached one to the plan) is part of the plan's stored data but cannot be created or changed through the API — it is chosen from a local file in the UI; `runner.execute` runs its iterations exactly as the manual button would. Request/document automatic execution supports HTTP; SSE/WS configurations can be created and opened for interactive debugging. No script execution or arbitrary file access is exposed.

## Review and export

```json
{"action":"entity.open","type":"document","id":"handoff-doc"}
{"action":"document.export","id":"handoff-doc","format":"markdown"}
```

Open supports request/document/runner. Export formats: `markdown`, `html`, `openapi`. Returns content plus `review` and revision; it does not mark reviewed or publish anything. The client can save it to a user-authorized path. Check review entries before claiming final readiness. Requests or active environment changes invalidate evidence as they do in the app.
