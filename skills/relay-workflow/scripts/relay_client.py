"""Portable, stdlib-only client for Relay API v1. No automatic mutation retries."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError("Relay redirects are not allowed")


class RelayClient:
    def __init__(self, config):
        if not isinstance(config, dict):
            raise ClientError("Connection config must be an object")
        parsed = urllib.parse.urlsplit(config.get("baseUrl", ""))
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or not parsed.port or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ClientError("Connection must use http://127.0.0.1:<port>")
        token = config.get("token", "")
        if not isinstance(token, str) or len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
            raise ClientError("Invalid connection token")
        self.url = f"http://127.0.0.1:{parsed.port}"
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, command=None):
        data = json.dumps(command, ensure_ascii=False).encode("utf-8") if command is not None else None
        req = urllib.request.Request(self.url + path, data=data,
                                     headers={"Authorization": "Bearer " + self.token,
                                              "Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=35) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                result = json.load(error)
            except (ValueError, UnicodeError):
                raise ClientError(f"Relay HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise ClientError("Relay is unavailable; enable a new connection. Read current state before retrying writes.") from None
        if not isinstance(result, dict):
            raise ClientError("Invalid Relay response")
        if not result.get("ok"):
            error = result.get("error", {})
            raise ClientError(f"{error.get('code', 'error')}: {error.get('message', 'Operation failed')}")
        return result["data"]

    def command(self, payload):
        return self.request("/v1/command", payload)

    def wait(self, job_id, seconds):
        deadline = time.monotonic() + seconds
        while True:
            job = self.command({"action": "job.get", "id": job_id})
            if job["state"] != "running":
                return job
            if time.monotonic() >= deadline:
                raise ClientError(f"Wait limit reached; job {job_id} still runs. Inspect or cancel explicitly.")
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description="Create, verify and document APIs in the running Relay app")
    parser.add_argument("--config", default=os.environ.get("RELAY_CONNECTION"), help="Connection JSON path (or RELAY_CONNECTION)")
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("health")
    sub.add_parser("list")
    call = sub.add_parser("call")
    call.add_argument("--file", required=True, help="Command JSON file; - reads stdin")
    call.add_argument("--wait", action="store_true")
    call.add_argument("--wait-seconds", type=float, default=180)
    export = sub.add_parser("export")
    export.add_argument("--id", required=True)
    export.add_argument("--format", choices=["markdown", "html", "openapi"], default="markdown")
    export.add_argument("--output", required=True)
    export.add_argument("--force", action="store_true", help="Overwrite this output file")
    args = parser.parse_args()
    if not args.config:
        parser.error("Supply --config saved from Relay's AI connection dialog")
    try:
        config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
        client = RelayClient(config)
        if args.operation == "health":
            result = client.request("/v1/health")
        elif args.operation == "list":
            result = client.command({"action": "workspace.list"})
        elif args.operation == "call":
            if not 1 <= args.wait_seconds <= 600:
                raise ClientError("--wait-seconds must be 1–600")
            source = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8-sig")
            result = client.command(json.loads(source))
            if args.wait and result.get("jobId"):
                result = client.wait(result["jobId"], args.wait_seconds)
        else:
            destination = Path(args.output)
            if destination.exists() and not args.force:
                raise ClientError("Output exists; choose a new path or use --force")
            result = client.command({"action": "document.export", "id": args.id, "format": args.format})
            content = result.pop("content")
            with destination.open("w" if args.force else "x", encoding="utf-8", newline="\n") as file:
                file.write(content)
            result["output"] = str(destination.resolve())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result.get("state") in ("failed", "cancelled") or result.get("result", {}).get("ok") is False:
            return 2
        return 0
    except (ClientError, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
