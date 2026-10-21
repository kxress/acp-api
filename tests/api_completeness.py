"""Offline checks for the official OpenAI and Anthropic Python SDKs."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

from anthropic import Anthropic
from openai import OpenAI


ROOT = Path(__file__).resolve().parents[1]
API_KEY = "local-test-key"
RECORD_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "value": {"type": "string"},
    },
    "required": ["label", "value"],
    "additionalProperties": False,
}
TOOL_SCHEMA = {
    "type": "object",
    "properties": {"value": {"type": "string"}},
    "required": ["value"],
    "additionalProperties": False,
}


class ApiCompleteness(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = subprocess.Popen(
            ["node", str(ROOT / "tests" / "api_completeness_server.mjs")],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert cls.server.stdout is not None
        ready = cls.server.stdout.readline().strip()
        if not ready.startswith("READY http://127.0.0.1:"):
            stderr = cls.server.stderr.read() if cls.server.stderr else ""
            cls.server.terminate()
            raise RuntimeError(f"mock API did not start: {ready}\n{stderr}")
        cls.base_url = ready.removeprefix("READY ")
        cls.openai = OpenAI(
            base_url=f"{cls.base_url}/v1",
            api_key=API_KEY,
            max_retries=0,
        )
        cls.anthropic = Anthropic(
            base_url=cls.base_url,
            api_key=API_KEY,
            max_retries=0,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.openai.close()
        cls.anthropic.close()
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=5)

    def test_openai_sdk_model_listing_and_completions(self) -> None:
        models = self.openai.models.list()
        self.assertEqual(models.data[0].id, "mock-model")

        response = self.openai.completions.create(
            model="mock-model",
            prompt="Say hello.",
            max_tokens=32,
        )
        self.assertEqual(response.choices[0].text, "mock answer")

    def test_openai_sdk_chat_and_responses_endpoints(self) -> None:
        chat = self.openai.chat.completions.create(
            model="mock-model",
            messages=[{"role": "user", "content": "Say hello."}],
        )
        self.assertEqual(chat.choices[0].message.content, "mock answer")

        response = self.openai.responses.create(
            model="mock-model",
            input="Say hello.",
        )
        self.assertEqual(response.output_text, "mock answer")

    def test_openai_sdk_streaming_tools_and_tool_result(self) -> None:
        chunks = self.openai.chat.completions.create(
            model="mock-model",
            messages=[{"role": "user", "content": "Say hello."}],
            stream=True,
        )
        streamed_text = "".join(
            choice.delta.content or ""
            for chunk in chunks
            for choice in chunk.choices
        )
        self.assertEqual(streamed_text, "mock answer")

        tool = {
            "type": "function",
            "function": {
                "name": "save_value",
                "description": "Save a value.",
                "parameters": TOOL_SCHEMA,
            },
        }
        first = self.openai.chat.completions.create(
            model="mock-model",
            messages=[{"role": "user", "content": "Save this value."}],
            tools=[tool],
            tool_choice={"type": "function", "function": {"name": "save_value"}},
        )
        assistant_message = first.choices[0].message
        self.assertEqual(assistant_message.tool_calls[0].function.name, "save_value")
        self.assertEqual(
            assistant_message.tool_calls[0].function.arguments,
            '{"value":"mock value"}',
        )

        follow_up = self.openai.chat.completions.create(
            model="mock-model",
            messages=[
                {"role": "user", "content": "Save this value."},
                assistant_message.model_dump(exclude_none=True),
                {
                    "role": "tool",
                    "tool_call_id": assistant_message.tool_calls[0].id,
                    "content": "Saved.",
                },
            ],
            tools=[tool],
        )
        self.assertEqual(follow_up.choices[0].message.content, "mock answer")

    def test_openai_sdk_json_schema_response_format(self) -> None:
        response = self.openai.chat.completions.create(
            model="mock-structured",
            messages=[{"role": "user", "content": "Return a record."}],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "record",
                    "strict": True,
                    "schema": RECORD_SCHEMA,
                },
            },
        )
        self.assertEqual(
            response.choices[0].message.content,
            '{"label":"mock label","value":"mock value"}',
        )

    def test_anthropic_sdk_model_listing_and_streaming(self) -> None:
        models = self.anthropic.models.list()
        self.assertEqual(models.data[0].id, "mock-model")

        with self.anthropic.messages.stream(
            model="mock-model",
            max_tokens=128,
            messages=[{"role": "user", "content": "Say hello."}],
        ) as stream:
            response = stream.get_final_message()
        self.assertEqual(response.content[0].text, "mock answer")

    def test_anthropic_sdk_tools_and_tool_result(self) -> None:
        tools = [
            {
                "name": "save_value",
                "description": "Save a value.",
                "input_schema": TOOL_SCHEMA,
            }
        ]
        first = self.anthropic.messages.create(
            model="mock-model",
            max_tokens=128,
            messages=[{"role": "user", "content": "Save this value."}],
            tools=tools,
            tool_choice={"type": "tool", "name": "save_value"},
        )
        tool_use = next(block for block in first.content if block.type == "tool_use")
        self.assertEqual(tool_use.name, "save_value")
        self.assertEqual(tool_use.input, {"value": "mock value"})

        follow_up = self.anthropic.messages.create(
            model="mock-model",
            max_tokens=128,
            messages=[
                {"role": "user", "content": "Save this value."},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": tool_use.id,
                            "name": tool_use.name,
                            "input": tool_use.input,
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_use.id,
                            "content": "Saved.",
                        }
                    ],
                },
            ],
            tools=tools,
        )
        self.assertEqual(follow_up.content[0].text, "mock answer")

    def test_anthropic_sdk_json_schema_output(self) -> None:
        response = self.anthropic.messages.create(
            model="mock-structured",
            max_tokens=128,
            messages=[{"role": "user", "content": "Return a record."}],
            output_config={
                "format": {"type": "json_schema", "schema": RECORD_SCHEMA}
            },
        )
        self.assertEqual(
            response.content[0].text,
            '{"label":"mock label","value":"mock value"}',
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
