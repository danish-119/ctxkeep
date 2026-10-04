SYSTEM_PROMPT = "You are helpful."


def build_prompt(ticket):
    return SYSTEM_PROMPT + ticket
