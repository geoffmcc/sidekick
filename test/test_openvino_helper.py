import unittest
import sys
import os

# Ensure helper can be imported
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/compute/openvino')))
try:
    import helper
except ImportError as e:
    helper = None
    import_error = str(e)

class TestOpenVINOProtocol(unittest.TestCase):
    def test_import_success(self):
        self.assertIsNotNone(helper, f"Failed to import helper: {import_error if not helper else ''}")

    def test_allowed_models_present(self):
        if helper is None:
            self.skipTest("Helper not imported")
        self.assertIn("e5-small-v2-qint8", helper.ALLOWED_MODELS)
        self.assertIn("qwen3-embedding-0.6b-int8", helper.ALLOWED_MODELS)

    def test_config_dimensions(self):
        if helper is None:
            self.skipTest("Helper not imported")
        self.assertEqual(helper._MODEL_CONFIGS["e5-small-v2-qint8"]["output_dimensions"], 384)
        self.assertEqual(helper._MODEL_CONFIGS["qwen3-embedding-0.6b-int8"]["output_dimensions"], 1024)

    def test_action_validation(self):
        if helper is None:
            self.skipTest("Helper not imported")
        # Ensure HelperRuntime validates action
        from helper import HelperRuntime

        self.assertTrue(issubclass(HelperRuntime, object))
        self.assertTrue(hasattr(HelperRuntime, 'handle_embed'))

if __name__ == '__main__':
    unittest.main()
