from agent.llm import LlmClient


def test_complete():
    assert LlmClient().complete("x")
