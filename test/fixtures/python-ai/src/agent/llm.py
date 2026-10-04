from .prompts import SYSTEM_PROMPT


class LlmClient:
    def complete(self, text):
        return SYSTEM_PROMPT + text


def _retry():
    return None
