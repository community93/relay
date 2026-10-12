# Relay API v1

Authenticated native HTTP clients only. Read the saved connection JSON for `baseUrl` and `token`; never expose the token. `GET /v1/health` and `POST /v1/command` require `Authorization: Bearer <token>`. POST requires `Content-Type: application/json`. Browser origins and redirects are rejected. No cloud service, fixed port or credential discovery. The app must remain open with AI connection enabled.

Requests are capped at 2 MiB. Response bodies returned to AI may be bounded; Relay retains engine evidence. Commands return `{ok:true,data:...}` or `{ok:false,error:{code,message}}`. Conflict/busy errors use HTTP409. Unknown IDs use404. Invalid payloads use400. Persistence errors use500. On timeout inspect the entity by stable ID before retrying a write.

## Scopes and the host allowlist

Each connection grants one tier, and a higher tier includes everything below it:

| tier | what it adds |
| --- | --- |
| `read` | `workspace.list`, `entity.get`, `job.get` |
| `write` | collection / environment / request / document / runner upserts, `entity.open`, `document.export` |
| `execute` | `request.execute`, `document.verify`, `runner.execute`, `job.cancel` |

The user chooses the tier when opening the connection; the default grants no execute rights, and an `execute` connection must name at least one allowed host. `GET /v1/health` and `workspace.list` report the live `scope`, `allowedHosts`, and only the `actions` that scope can actually reach — call `workspace.list` first and treat that list as the whole surface rather than probing.

Calling an action above the granted tier returns HTTP403 with `code:"insufficient_scope"` and a message naming the tier to ask for. Do not retry it in a loop and do not look for a workaround: ask the user to reopen the connection with a wider scope.

`execute` additionally checks the resolved URL against the allowlist immediately before the request leaves Relay, after variable substitution. A blocked host returns `code:"scope"`. `document.verify` and `runner.execute` check **every** endpoint up front and refuse the whole job if any single one is off-list, so a refusal means nothing was sent — fix the allowlist or narrow the document, then retry.

## Discovery and updates

```json
{"action":"workspace.list"}
{"action":"entity.get","type":"request","id":"example-get"}
```

Entity types: `collection`, `request`, `environment`, `document`, `runner`. Read returns `{entity,revision}`; documents also return endpoints with generated `fields`, `status`, `issues`. Lists include entity IDs and revisions.

All updates to existing entities require `expectedRevision` equal to the latest revision; new entities omit it. IDs are optional on creates (Relay generates one). Supplied IDs use letters/digits/underscore/hyphen, max80 chars. Choose stable task-scoped IDs to recover from ambiguous write failures. `.upsert` merges supplied top-level fields; supplied arrays replace that array. Updating a request with an unsaved tab or active execution returns `busy`.

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

Checks: `{kind:"status",expected:"200, 201"}`, `{kind:"time",expected:"1500"}`, `{kind:"json",operator:"exists",path:"$.id"}`, `{kind:"json",operator:"equals",path:"$.code",expected:"0"}`, `{kind:"json",operator:"type",path:"$.data",expected:"object"}`. JSON equality expects JSON text (string example `"\"demo\""`). Types: string/number/boolean/null/array/object. Paths support `$`, `.field`, `[0]`, `["a.b"]`, with no eval or wildcards. Optional `enabled:false` disables a rule.

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

Runner data: `name`, `sources` (collection/folder/request IDs), `stopOnError`, `delayMs`(0–60000). Schedule cannot be enabled via API. Request/document automatic execution supports HTTP; SSE/WS configurations can be created and opened for interactive debugging. No script execution or arbitrary file access is exposed.

## Review and export

```json
{"action":"entity.open","type":"document","id":"handoff-doc"}
{"action":"document.export","id":"handoff-doc","format":"markdown"}
```

Open supports request/document/runner. Export formats: `markdown`, `html`, `openapi`. Returns content plus `review` and revision; it does not mark reviewed or publish anything. The client can save it to a user-authorized path. Check review entries before claiming final readiness. Requests or active environment changes invalidate evidence as they do in the app.
