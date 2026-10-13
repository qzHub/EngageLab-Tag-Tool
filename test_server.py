import base64
import io
import json
import unittest
from urllib.error import HTTPError

import server


class FakeResponse:
    def __init__(self, status=200, body=b"success"):
        self.status = status
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body

    def getcode(self):
        return self.status


class TagToolTests(unittest.TestCase):
    def test_normalize_registration_ids_trims_and_deduplicates(self):
        self.assertEqual(server.normalize_registration_ids([" id-1 ", "", "id-1", "id-2"]), ["id-1", "id-2"])

    def test_validate_config_rejects_non_engagelab_host(self):
        with self.assertRaisesRegex(server.ValidationError, "数据中心"):
            server.validate_config(
                {
                    "api_base_url": "https://example.com",
                    "app_key": "key",
                    "master_secret": "secret",
                    "tag": "vip",
                    "registration_ids": ["id-1"],
                }
            )

    def test_validate_config_rejects_invalid_tag(self):
        with self.assertRaisesRegex(server.ValidationError, "只能包含"):
            server.validate_config(
                {
                    "api_base_url": "https://pushapi-sgp.engagelab.com",
                    "app_key": "key",
                    "master_secret": "secret",
                    "tag": "not allowed",
                    "registration_ids": ["id-1"],
                }
            )

    def test_bind_tag_batches_and_builds_basic_auth(self):
        requests = []

        def opener(request, **kwargs):
            requests.append((request, kwargs))
            return FakeResponse()

        ids = [f"id-{number}" for number in range(1001)]
        result = server.bind_tag_in_batches(
            "https://pushapi-sgp.engagelab.com", "app-key", "master-secret", "vip用户", ids, 30, opener
        )

        self.assertEqual(result["batches"], 2)
        self.assertEqual(result["success_count"], 1001)
        self.assertEqual(len(json.loads(requests[0][0].data)["registration_ids"]["add"]), 1000)
        expected_auth = base64.b64encode(b"app-key:master-secret").decode("ascii")
        self.assertEqual(requests[0][0].get_header("Authorization"), f"Basic {expected_auth}")
        self.assertIn("%E7%94%A8%E6%88%B7", requests[0][0].full_url)
        self.assertEqual(requests[0][1]["timeout"], 30)

    def test_bind_tag_keeps_processing_after_http_error(self):
        calls = 0

        def opener(request, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                body = json.dumps(
                    {"error": {"code": 27005, "message": "registration id is illegal", "data": "{\"invalid_regids\":[\"bad-id\"]}"}}
                ).encode()
                raise HTTPError(request.full_url, 400, "Bad Request", {}, io.BytesIO(body))
            return FakeResponse()

        result = server.bind_tag_in_batches(
            "https://pushapi-sgp.engagelab.com", "key", "secret", "vip", [f"id-{i}" for i in range(1001)], 30, opener
        )

        self.assertEqual(calls, 2)
        self.assertEqual(result["success_count"], 1)
        self.assertEqual(result["failed_count"], 1000)
        self.assertEqual(result["results"][0]["invalid_registration_ids"], ["bad-id"])

    def test_verify_tag_bindings_splits_bound_and_unbound_ids(self):
        def opener(request, **_kwargs):
            registration_id = request.full_url.rsplit("/", 1)[-1]
            body = json.dumps({"result": registration_id == "bound-id"}).encode()
            return FakeResponse(body=body)

        result = server.verify_tag_bindings(
            "https://pushapi-sgp.engagelab.com",
            "app-key",
            "master-secret",
            "vip用户",
            ["bound-id", "unbound-id"],
            30,
            opener,
        )

        self.assertEqual(result["bound_registration_ids"], ["bound-id"])
        self.assertEqual(result["unbound_registration_ids"], ["unbound-id"])
        self.assertEqual(result["error_count"], 0)

    def test_verify_tag_bindings_reports_individual_api_errors(self):
        def opener(request, **_kwargs):
            if request.full_url.endswith("bad-id"):
                body = json.dumps({"error": {"code": 27002, "message": "invalid registration id"}}).encode()
                raise HTTPError(request.full_url, 400, "Bad Request", {}, io.BytesIO(body))
            return FakeResponse(body=b'{"result":true}')

        result = server.verify_tag_bindings(
            "https://pushapi-sgp.engagelab.com",
            "key",
            "secret",
            "vip",
            ["good-id", "bad-id"],
            30,
            opener,
        )

        self.assertEqual(result["bound_registration_ids"], ["good-id"])
        self.assertEqual(result["error_count"], 1)
        self.assertEqual(result["errors"][0]["status"], 400)
        self.assertIn("27002", result["errors"][0]["message"])


if __name__ == "__main__":
    unittest.main()
