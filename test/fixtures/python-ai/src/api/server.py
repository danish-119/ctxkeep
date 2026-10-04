"""HTTP API exposing the agent."""
from fastapi import FastAPI
from agent.llm import LlmClient
from agent.tool_registry import ToolRegistry

app = FastAPI()


def create_app():
    return app


class TicketRequest:
    pass
