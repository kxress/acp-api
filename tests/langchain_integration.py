"""Offline integration checks using the official LangChain provider clients."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langmem import create_memory_manager
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parents[1]
API_KEY = "local-test-key"


class Preference(BaseModel):
    category: str
    preference: str


class LocalApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = subprocess.Popen(
            ["node", str(ROOT / "tests" / "langchain_server.mjs")],
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

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=5)

    @classmethod
    def openai_model(cls, model: str = "mock-model") -> ChatOpenAI:
        return ChatOpenAI(
            model=model,
            base_url=f"{cls.base_url}/v1",
            api_key=API_KEY,
            temperature=0,
            max_retries=0,
        )

    @classmethod
    def anthropic_model(cls, model: str = "mock-model") -> ChatAnthropic:
        return ChatAnthropic(
            model=model,
            base_url=cls.base_url,
            api_key=API_KEY,
            max_tokens=256,
            max_retries=0,
        )

    def test_chat_openai_client_text_and_stream(self) -> None:
        model = self.openai_model()
        response = model.invoke("Say hello.")
        self.assertEqual(response.content, "mock answer")
        chunks = list(model.stream("Say hello."))
        self.assertEqual("".join(str(chunk.content) for chunk in chunks), "mock answer")

    def test_chat_anthropic_client_text_and_stream(self) -> None:
        model = self.anthropic_model()
        response = model.invoke("Say hello.")
        self.assertEqual(response.content, "mock answer")
        chunks = list(model.stream("Say hello."))
        self.assertEqual("".join(str(chunk.content) for chunk in chunks), "mock answer")

    def test_openai_client_tool_choice_and_tool_call_response(self) -> None:
        model = self.openai_model().bind_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "remember_preference",
                        "description": "Save a preference.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "category": {"type": "string"},
                                "preference": {"type": "string"},
                            },
                            "required": ["category", "preference"],
                        },
                    },
                }
            ],
            tool_choice="any",
        )
        response = model.invoke("Remember that I like dark mode.")
        self.assertIsInstance(response, AIMessage)
        self.assertEqual(response.tool_calls[0]["name"], "remember_preference")
        self.assertEqual(
            response.tool_calls[0]["args"],
            {"category": "mock memory value", "preference": "mock memory value"},
        )

    def test_openai_client_tool_result_round_trip(self) -> None:
        model = self.openai_model().bind_tools(
            [
                {
                    "name": "remember_preference",
                    "description": "Save a preference.",
                    "parameters": {
                        "type": "object",
                        "properties": {"preference": {"type": "string"}},
                        "required": ["preference"],
                    },
                }
            ],
            tool_choice="any",
        )
        user = HumanMessage("Remember I prefer dark mode.")
        first = model.invoke([user])
        result = ToolMessage(
            content="Saved dark mode preference.",
            tool_call_id=first.tool_calls[0]["id"],
        )
        second = model.invoke([user, first, result])
        self.assertEqual(second.content, "mock answer")

    def test_anthropic_client_tool_choice_and_tool_call_response(self) -> None:
        model = self.anthropic_model().bind_tools(
            [
                {
                    "name": "remember_preference",
                    "description": "Save a preference.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "category": {"type": "string"},
                            "preference": {"type": "string"},
                        },
                        "required": ["category", "preference"],
                    },
                }
            ],
            tool_choice="any",
        )
        response = model.invoke("Remember that I like dark mode.")
        self.assertIsInstance(response, AIMessage)
        self.assertEqual(response.tool_calls[0]["name"], "remember_preference")

    def test_anthropic_client_tool_result_round_trip(self) -> None:
        model = self.anthropic_model().bind_tools(
            [
                {
                    "name": "remember_preference",
                    "description": "Save a preference.",
                    "input_schema": {
                        "type": "object",
                        "properties": {"preference": {"type": "string"}},
                        "required": ["preference"],
                    },
                }
            ],
            tool_choice="any",
        )
        user = HumanMessage("Remember I prefer dark mode.")
        first = model.invoke([user])
        result = ToolMessage(
            content="Saved dark mode preference.",
            tool_call_id=first.tool_calls[0]["id"],
        )
        second = model.invoke([user, first, result])
        self.assertEqual(second.content, "mock answer")

    def test_langmem_structured_memory_extraction_with_openai_client(self) -> None:
        manager = create_memory_manager(
            self.openai_model(),
            schemas=[Preference],
            instructions="Extract the preference from the conversation.",
        )
        result = manager.invoke(
            {"messages": [{"role": "user", "content": "I like dark mode."}]}
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].content.category, "mock memory value")

    def test_langmem_structured_memory_extraction_with_anthropic_client(self) -> None:
        manager = create_memory_manager(
            self.anthropic_model(),
            schemas=[Preference],
            instructions="Extract the preference from the conversation.",
        )
        result = manager.invoke(
            {"messages": [{"role": "user", "content": "I like dark mode."}]}
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].content.preference, "mock memory value")

    def test_openai_structured_output_with_json_schema(self) -> None:
        model = self.openai_model("mock-structured").with_structured_output(
            Preference,
            method="json_schema",
        )
        result = model.invoke("Return a preference.")
        self.assertEqual(
            result,
            Preference(category="mock category", preference="mock preference"),
        )

    def test_anthropic_structured_output_with_json_schema(self) -> None:
        model = self.anthropic_model("mock-structured").with_structured_output(
            Preference,
            method="json_schema",
        )
        result = model.invoke("Return a preference.")
        self.assertEqual(
            result,
            Preference(category="mock category", preference="mock preference"),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
