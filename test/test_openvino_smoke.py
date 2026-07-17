"""Hardware-independent tests for the OpenVINO smoke-test validation logic.

These exercise ``validate_embedding_response`` with synthetic helper responses
so the fail-closed behaviour is covered without an NPU, a model, or OpenVINO.
"""
import math
import os
import sys
import unittest

sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../src/compute/openvino"))
)

import smoke_test  # noqa: E402


def _good_response(dim=1024, device="NPU", model_id="qwen3-embedding-0.6b-int8"):
    vec = [0.0] * dim
    vec[0] = 1.0
    return {
        "v": "1",
        "id": "smoke-1",
        "ok": True,
        "action": "embed",
        "model_id": model_id,
        "embedding": vec,
        "device": device,
        "requested_device": "NPU",
        "fallback_occurred": False,
        "fallback_reason": None,
    }


class TestValidateEmbeddingResponse(unittest.TestCase):
    def _validate(self, response, **overrides):
        kwargs = dict(
            model_id="qwen3-embedding-0.6b-int8",
            required_device="NPU",
            expect_dim=1024,
            allow_fallback=False,
        )
        kwargs.update(overrides)
        return smoke_test.validate_embedding_response(response, **kwargs)

    def test_valid_npu_response_passes(self):
        self.assertEqual(self._validate(_good_response()), [])

    def test_non_object_response_fails(self):
        errors = self._validate("not-a-dict")
        self.assertTrue(any("not a JSON object" in e for e in errors))

    def test_helper_error_fails(self):
        resp = {"ok": False, "error_code": "compile_failed", "error": "boom"}
        errors = self._validate(resp)
        self.assertTrue(any("compile_failed" in e for e in errors))

    def test_wrong_device_fails(self):
        errors = self._validate(_good_response(device="CPU"))
        self.assertTrue(any("did not run on the required hardware" in e for e in errors))

    def test_fallback_when_disabled_fails(self):
        resp = _good_response(device="CPU")
        resp["fallback_occurred"] = True
        resp["fallback_reason"] = "device_not_found:NPU"
        errors = self._validate(resp)
        self.assertTrue(any("fallback is disabled" in e.lower() for e in errors))

    def test_fallback_allowed_still_requires_device_match(self):
        # Even when fallback is allowed, required_device is CPU in that scenario.
        resp = _good_response(device="CPU")
        resp["fallback_occurred"] = True
        errors = self._validate(resp, required_device="CPU", allow_fallback=True)
        self.assertEqual(errors, [])

    def test_wrong_dimension_fails(self):
        errors = self._validate(_good_response(dim=768))
        self.assertTrue(any("dimension" in e for e in errors))

    def test_empty_embedding_fails(self):
        resp = _good_response()
        resp["embedding"] = []
        errors = self._validate(resp)
        self.assertTrue(any("empty or missing" in e for e in errors))

    def test_missing_embedding_fails(self):
        resp = _good_response()
        del resp["embedding"]
        errors = self._validate(resp)
        self.assertTrue(any("empty or missing" in e for e in errors))

    def test_non_finite_embedding_fails(self):
        resp = _good_response()
        resp["embedding"][3] = math.inf
        errors = self._validate(resp)
        self.assertTrue(any("non-finite" in e for e in errors))

    def test_nan_embedding_fails(self):
        resp = _good_response()
        resp["embedding"][3] = math.nan
        errors = self._validate(resp)
        self.assertTrue(any("non-finite" in e for e in errors))

    def test_non_numeric_embedding_fails(self):
        resp = _good_response()
        resp["embedding"][3] = "oops"
        errors = self._validate(resp)
        self.assertTrue(any("non-numeric" in e for e in errors))

    def test_bool_embedding_value_fails(self):
        # bool is a subclass of int; it must be rejected as non-numeric.
        resp = _good_response()
        resp["embedding"][3] = True
        errors = self._validate(resp)
        self.assertTrue(any("non-numeric" in e for e in errors))

    def test_model_id_mismatch_fails(self):
        errors = self._validate(_good_response(model_id="e5-small-v2-qint8"))
        self.assertTrue(any("model_id" in e for e in errors))

    def test_expected_dimensions_map(self):
        self.assertEqual(smoke_test.EXPECTED_DIMENSIONS["qwen3-embedding-0.6b-int8"], 1024)
        self.assertEqual(smoke_test.EXPECTED_DIMENSIONS["e5-small-v2-qint8"], 384)


if __name__ == "__main__":
    unittest.main()
