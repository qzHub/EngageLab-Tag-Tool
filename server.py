#!/usr/bin/env python3
"""Small local web tool for binding an EngageLab tag to registration IDs."""

from __future__ import annotations

import argparse
import base64
import json
import re
import ssl
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


STATIC_DIR = Path(__file__).with_name("static")
INDEX_FILE = STATIC_DIR / "index.html"
MAX_REQUEST_BYTES = 10 * 1024 * 1024
MAX_REGISTRATION_IDS = 100_000
ENGAGELAB_BATCH_SIZE = 1_000
VERIFY_WORKERS = 10
ALLOWED_API_HOSTS = {
    "pushapi-sgp.engagelab.com",
    "pushapi-usva.engagelab.com",
    "pushapi-defra.engagelab.com",
    "pushapi-hk.engagelab.com",
    "pushapi-jpn.engagelab.com",
    "pushapi-bra.engagelab.com",
}
TAG_PATTERN = re.compile(r"^[A-Za-z0-9_\u3400-\u9fff]+$")
IS_PACKAGED = bool(getattr(sys, "frozen", False))


def safe_print(message: str) -> None:
    """Print only when a console stream exists (windowed bundles have none)."""
    if sys.stdout is not None:
        print(message)


class ValidationError(ValueError):
    """Raised when a request cannot safely be sent to EngageLab."""


@dataclass(frozen=True)
class BatchResult:
    batch: int
    count: int
    success: bool
    status: int | None
    message: str
    invalid_registration_ids: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "batch": self.batch,
            "count": self.count,
            "success": self.success,
            "status": self.status,
            "message": self.message,
            "invalid_registration_ids": self.invalid_registration_ids,
        }


def chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def normalize_registration_ids(raw_ids: Any) -> list[str]:
    if not isinstance(raw_ids, list):
        raise ValidationError("registration_ids 必须是数组")

    unique_ids: list[str] = []
    seen: set[str] = set()
    for index, value in enumerate(raw_ids, start=1):
        if not isinstance(value, str):
            raise ValidationError(f"第 {index} 个 registration ID 不是字符串")
        registration_id = value.strip()
        if not registration_id:
            continue
        if len(registration_id.encode("utf-8")) > 255:
            raise ValidationError(f"第 {index} 个 registration ID 过长")
        if registration_id not in seen:
            seen.add(registration_id)
            unique_ids.append(registration_id)

    if not unique_ids:
        raise ValidationError("CSV 中没有可用的 registration ID")
    if len(unique_ids) > MAX_REGISTRATION_IDS:
        raise ValidationError(f"一次最多处理 {MAX_REGISTRATION_IDS:,} 个 registration ID")
    return unique_ids


def validate_config(data: Any) -> tuple[str, str, str, str, list[str], int]:
    if not isinstance(data, dict):
        raise ValidationError("请求体必须是 JSON 对象")

    api_base_url = str(data.get("api_base_url", "")).strip().rstrip("/")
    app_key = str(data.get("app_key", "")).strip()
    master_secret = str(data.get("master_secret", "")).strip()
    tag = str(data.get("tag", "")).strip()
    timeout = data.get("timeout_seconds", 30)

    parsed_url = urlparse(api_base_url)
    if (
        parsed_url.scheme != "https"
        or parsed_url.hostname not in ALLOWED_API_HOSTS
        or parsed_url.path not in ("", "/")
        or parsed_url.query
        or parsed_url.fragment
        or parsed_url.username
        or parsed_url.password
    ):
        raise ValidationError("请选择受支持的 EngageLab 数据中心地址")
    if not app_key:
        raise ValidationError("AppKey 不能为空")
    if not master_secret:
        raise ValidationError("Master Secret 不能为空")
    if not tag:
        raise ValidationError("Tag 不能为空")
    if len(tag.encode("utf-8")) > 40:
        raise ValidationError("Tag 的 UTF-8 长度不能超过 40 字节")
    if not TAG_PATTERN.fullmatch(tag):
        raise ValidationError("Tag 只能包含字母、数字、下划线和中文字符")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 5 <= timeout <= 120:
        raise ValidationError("请求超时必须是 5 到 120 秒之间的整数")

    registration_ids = normalize_registration_ids(data.get("registration_ids"))
    return api_base_url, app_key, master_secret, tag, registration_ids, timeout


def parse_error_body(body: str) -> tuple[str, list[str]]:
    message = body.strip() or "EngageLab 返回了空错误响应"
    invalid_ids: list[str] = []
    try:
        payload = json.loads(body)
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        if isinstance(error, dict):
            code = error.get("code")
            detail = error.get("message")
            if detail:
                message = f"{code}: {detail}" if code is not None else str(detail)
            raw_data = error.get("data")
            if isinstance(raw_data, str):
                try:
                    raw_data = json.loads(raw_data)
                except json.JSONDecodeError:
                    raw_data = None
            if isinstance(raw_data, dict) and isinstance(raw_data.get("invalid_regids"), list):
                invalid_ids = [str(item) for item in raw_data["invalid_regids"]]
    except json.JSONDecodeError:
        pass
    return message, invalid_ids


def bind_tag_in_batches(
    api_base_url: str,
    app_key: str,
    master_secret: str,
    tag: str,
    registration_ids: list[str],
    timeout: int,
    opener: Callable[..., Any] = urlopen,
) -> dict[str, Any]:
    endpoint = f"{api_base_url}/v4/tags/{quote(tag, safe='')}"
    auth = base64.b64encode(f"{app_key}:{master_secret}".encode("utf-8")).decode("ascii")
    results: list[BatchResult] = []

    for batch_number, batch_ids in enumerate(chunks(registration_ids, ENGAGELAB_BATCH_SIZE), start=1):
        body = json.dumps(
            {"registration_ids": {"add": batch_ids}},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        request = Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Basic {auth}",
                "Accept": "application/json",
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "EngageLab-Tag-Tool/1.0",
            },
        )

        try:
            with opener(request, timeout=timeout, context=ssl.create_default_context()) as response:
                response_body = response.read().decode("utf-8", errors="replace").strip()
                status = response.getcode()
                results.append(
                    BatchResult(
                        batch=batch_number,
                        count=len(batch_ids),
                        success=200 <= status < 300,
                        status=status,
                        message=response_body or "success",
                        invalid_registration_ids=[],
                    )
                )
        except HTTPError as error:
            response_body = error.read().decode("utf-8", errors="replace")
            error.close()
            message, invalid_ids = parse_error_body(response_body)
            results.append(
                BatchResult(batch_number, len(batch_ids), False, error.code, message, invalid_ids)
            )
        except (URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            results.append(
                BatchResult(batch_number, len(batch_ids), False, None, f"网络请求失败: {reason}", [])
            )

    success_count = sum(result.count for result in results if result.success)
    return {
        "total": len(registration_ids),
        "batch_size": ENGAGELAB_BATCH_SIZE,
        "batches": len(results),
        "success_count": success_count,
        "failed_count": len(registration_ids) - success_count,
        "results": [result.as_dict() for result in results],
    }


def verify_tag_bindings(
    api_base_url: str,
    app_key: str,
    master_secret: str,
    tag: str,
    registration_ids: list[str],
    timeout: int,
    opener: Callable[..., Any] = urlopen,
) -> dict[str, Any]:
    auth = base64.b64encode(f"{app_key}:{master_secret}".encode("utf-8")).decode("ascii")
    tag_path = quote(tag, safe="")
    ssl_context = ssl.create_default_context()

    def verify_one(registration_id: str) -> dict[str, Any]:
        endpoint = (
            f"{api_base_url}/v4/tags/{tag_path}/registration_ids/"
            f"{quote(registration_id, safe='')}"
        )
        request = Request(
            endpoint,
            method="GET",
            headers={
                "Authorization": f"Basic {auth}",
                "Accept": "application/json",
                "User-Agent": "EngageLab-Tag-Tool/1.0",
            },
        )
        try:
            with opener(request, timeout=timeout, context=ssl_context) as response:
                status = response.getcode()
                response_body = response.read().decode("utf-8", errors="replace")
                try:
                    payload = json.loads(response_body)
                except json.JSONDecodeError:
                    return {
                        "registration_id": registration_id,
                        "bound": None,
                        "status": status,
                        "message": "EngageLab 返回了无法解析的响应",
                    }
                result = payload.get("result") if isinstance(payload, dict) else None
                if not isinstance(result, bool):
                    return {
                        "registration_id": registration_id,
                        "bound": None,
                        "status": status,
                        "message": "EngageLab 响应中缺少布尔类型的 result 字段",
                    }
                return {
                    "registration_id": registration_id,
                    "bound": result,
                    "status": status,
                    "message": "已绑定" if result else "未绑定",
                }
        except HTTPError as error:
            response_body = error.read().decode("utf-8", errors="replace")
            error.close()
            message, _ = parse_error_body(response_body)
            return {
                "registration_id": registration_id,
                "bound": None,
                "status": error.code,
                "message": message,
            }
        except (URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            return {
                "registration_id": registration_id,
                "bound": None,
                "status": None,
                "message": f"网络请求失败: {reason}",
            }

    with ThreadPoolExecutor(max_workers=VERIFY_WORKERS) as executor:
        results = list(executor.map(verify_one, registration_ids))

    bound_ids = [item["registration_id"] for item in results if item["bound"] is True]
    unbound_ids = [item["registration_id"] for item in results if item["bound"] is False]
    errors = [item for item in results if item["bound"] is None]
    return {
        "total": len(registration_ids),
        "bound_count": len(bound_ids),
        "unbound_count": len(unbound_ids),
        "error_count": len(errors),
        "bound_registration_ids": bound_ids,
        "unbound_registration_ids": unbound_ids,
        "errors": errors,
    }


class TagToolHandler(BaseHTTPRequestHandler):
    server_version = "EngageLabTagTool/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/session/watch":
            self._watch_browser_session()
            return
        if self.path.split("?", 1)[0] not in ("/", "/index.html"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content = INDEX_FILE.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        )
        self.end_headers()
        self.wfile.write(content)

    def _watch_browser_session(self) -> None:
        server = self.server
        if not isinstance(server, TagToolServer) or not server.exit_when_page_closes:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        server.watcher_connected()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                self.wfile.write(b".\n")
                self.wfile.flush()
                time.sleep(2)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            server.watcher_disconnected()

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/api/tags/batch", "/api/tags/verify"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Content-Type 必须是 application/json"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "请求体为空或超过 10 MB"})
            return

        try:
            data = json.loads(self.rfile.read(content_length))
            config = validate_config(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "请求体不是有效的 JSON"})
            return
        except ValidationError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        if self.path == "/api/tags/verify":
            result = verify_tag_bindings(*config)
        else:
            result = bind_tag_in_batches(*config)
        self._send_json(HTTPStatus.OK, result)

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep standard access logs, which never include the JSON body or credentials.
        if sys.stderr is not None:
            super().log_message(fmt, *args)


class TagToolServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], exit_when_page_closes: bool = False):
        super().__init__(server_address, TagToolHandler)
        self.exit_when_page_closes = exit_when_page_closes
        self._active_watchers = 0
        self._ever_connected = False
        self._watcher_generation = 0
        self._watcher_lock = threading.Lock()

    def watcher_connected(self) -> None:
        with self._watcher_lock:
            self._active_watchers += 1
            self._ever_connected = True
            self._watcher_generation += 1

    def watcher_disconnected(self) -> None:
        with self._watcher_lock:
            self._active_watchers = max(0, self._active_watchers - 1)
            self._watcher_generation += 1
            generation = self._watcher_generation
            should_wait_for_shutdown = self._active_watchers == 0
        if should_wait_for_shutdown:
            threading.Thread(
                target=self._shutdown_if_still_unused,
                args=(generation,),
                daemon=True,
            ).start()

    def _shutdown_if_still_unused(self, generation: int) -> None:
        # A short grace period allows ordinary page reloads to reconnect.
        time.sleep(5)
        with self._watcher_lock:
            should_shutdown = self._active_watchers == 0 and self._watcher_generation == generation
        if should_shutdown:
            safe_print("网页已关闭，正在停止服务……")
            self.shutdown()

    def arm_initial_connection_timeout(self, seconds: int = 60) -> None:
        threading.Thread(
            target=self._shutdown_if_never_opened,
            args=(seconds,),
            daemon=True,
        ).start()

    def _shutdown_if_never_opened(self, seconds: int) -> None:
        time.sleep(seconds)
        with self._watcher_lock:
            should_shutdown = not self._ever_connected
        if should_shutdown:
            safe_print("浏览器页面未能打开，正在停止服务……")
            self.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser(description="EngageLab registration ID 批量打 Tag 工具")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument(
        "--port",
        type=int,
        default=0 if IS_PACKAGED else 8080,
        help="监听端口（独立应用自动选择空闲端口，源码运行默认 8080）",
    )
    parser.add_argument(
        "--open-browser",
        action=argparse.BooleanOptionalAction,
        default=IS_PACKAGED,
        help="启动后自动打开默认浏览器（独立应用默认开启）",
    )
    parser.add_argument(
        "--exit-when-page-closes",
        action=argparse.BooleanOptionalAction,
        default=IS_PACKAGED,
        help="浏览器页面关闭后自动停止服务（独立应用默认开启）",
    )
    args = parser.parse_args()

    server = TagToolServer((args.host, args.port), args.exit_when_page_closes)
    actual_host, actual_port = server.server_address[:2]
    browser_host = "127.0.0.1" if actual_host in ("0.0.0.0", "::") else actual_host
    browser_url = f"http://{browser_host}:{actual_port}"
    safe_print(f"EngageLab Tag 工具已启动: {browser_url}")
    safe_print("按 Ctrl+C 停止。AppKey 和 Master Secret 不会写入磁盘。")
    if args.exit_when_page_closes:
        server.arm_initial_connection_timeout()
    if args.open_browser:
        threading.Timer(0.25, webbrowser.open, args=(browser_url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        safe_print("\n正在停止……")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
